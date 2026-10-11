import { attachCapture, createConversation, deleteConversation, enforceConversationLimit, getAttachment, getConversation, getConversationState, recoverGeneration, selectConversation, startGeneration, updateReply } from '../shared/conversation-store'
import { CONTEXT_LIMITS, cooldownRemaining, type Conversation, type Generation, type ReplyStatus, type Turn } from '../shared/conversations'
import { CAPTURE_PREFIX, GENERATION_PORT, type ConversationAction, type StoredCapture } from '../shared/messages'

const ready = recoverGeneration().then(() => enforceConversationLimit())
void ready.catch(() => {}) // command handlers report failure; do not start a request without recovery
let queue: Promise<unknown> = ready
let active: { port: chrome.runtime.Port; generation: Generation; text: string; tabId?: number } | undefined

/** Every transcript mutation shares this writer, including port disconnects. */
function serialized<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.catch(() => {}).then(() => ready).then(run)
  queue = result
  return result
}

function changed(): void {
  void chrome.runtime.sendMessage({ type: 'CONVERSATIONS_CHANGED' }).catch(() => {})
}

function ownPage(sender?: chrome.runtime.MessageSender): boolean {
  return sender?.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''))
}

async function selectedForTab(tabId?: number): Promise<Conversation | undefined> {
  const key = `dialog.tab.${tabId}`
  const saved = tabId === undefined ? {} : await chrome.storage.session.get(key)
  if (typeof saved[key] === 'string') {
    const selected = await getConversation(saved[key])
    if (selected) return selected
  }
  return undefined
}

async function remember(id: string, tabId?: number): Promise<void> {
  await selectConversation(id)
  if (tabId !== undefined) await chrome.storage.session.set({ [`dialog.tab.${tabId}`]: id })
}

export function restoreDialog(tabId?: number): Promise<Conversation> {
  return serialized(async () => {
    const conversation = await selectedForTab(tabId) ?? await createConversation('Study Buddy')
    await enforceConversationLimit(conversation.id)
    await remember(conversation.id, tabId)
    return conversation
  })
}

async function saveCapture(conversationId: string, imageId: string): Promise<Conversation> {
  const got = await chrome.storage.session.get(CAPTURE_PREFIX + imageId)
  const capture = got[CAPTURE_PREFIX + imageId] as StoredCapture | undefined
  if (!capture) {
    const conversation = await getConversation(conversationId)
    if (conversation?.activeAttachmentId === imageId && await getAttachment(imageId)) return conversation
    throw new Error('state.expired')
  }
  const blob = await (await fetch(capture.dataUrl)).blob()
  return attachCapture(conversationId, { id: imageId, data: blob, createdAt: capture.ts })
}

export function captureDialog(imageId: string, tabId: number): Promise<Conversation> {
  return serialized(async () => {
    const conversation = await selectedForTab(tabId) ?? await createConversation('Study Buddy')
    const updated = await saveCapture(conversation.id, imageId)
    await enforceConversationLimit(conversation.id)
    await remember(conversation.id, tabId)
    changed()
    return updated
  })
}

/** Close only the association and writer owned by this content tab. */
export function closeDialog(conversationId: string, tabId: number): Promise<void> {
  return serialized(async () => {
    const running = active
    if (running?.tabId === tabId && running.generation.conversationId === conversationId) {
      active = undefined
      await updateReply(running.generation, running.text, 'cancelled')
      await enforceConversationLimit()
      running.port.disconnect()
      changed()
    }
    const key = `dialog.tab.${tabId}`
    const saved = await chrome.storage.session.get(key)
    if (saved[key] === conversationId) await chrome.storage.session.remove(key)
  })
}

async function action(message: ConversationAction, tabId?: number): Promise<Conversation | undefined> {
  if (message.action === 'create') {
    const created = await createConversation(message.title.slice(0, 80))
    await enforceConversationLimit(created.id)
    return created
  }
  if (message.action === 'prune') {
    await enforceConversationLimit()
    return undefined
  }
  const conversation = await getConversation(message.conversationId)
  if (!conversation) throw new Error('dialog.missing')
  if (message.action === 'delete') {
    if (active?.generation.conversationId === conversation.id) throw new Error('dialog.busy')
    await deleteConversation(conversation.id)
    const session = await chrome.storage.session.get(null)
    const staleBindings = Object.entries(session).filter(([key, value]) => key.startsWith('dialog.tab.') && value === conversation.id).map(([key]) => key)
    if (staleBindings.length) await chrome.storage.session.remove(staleBindings)
    return undefined
  }
  await remember(conversation.id, tabId)
  return message.action === 'attach' ? saveCapture(conversation.id, message.imageId) : conversation
}

async function validateContext(conversation: Conversation): Promise<void> {
  const id = conversation.activeAttachmentId
  if (id) {
    const attachment = await getAttachment(id)
    if (!attachment) throw new Error('context.imageMissing')
    if (attachment.data.size > CONTEXT_LIMITS.imageBytes) throw new Error('context.imageLarge')
  }
}

export function installConversationCoordinator(): void {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'CONVERSATION') return false
    if (!ownPage(sender)) { respond({ ok: false, error: 'dialog.denied' }); return false }
    void serialized(() => action(message, sender.tab?.id)).then((value) => {
      respond({ ok: true, value })
      changed()
    }, (err) => respond({ ok: false, error: err instanceof Error ? err.message : 'storage.write' }))
    return true
  })

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== GENERATION_PORT || !ownPage(port.sender)) return
    let disconnected = false
    port.onMessage.addListener((message) => {
      void serialized(async () => {
        if (disconnected) throw new Error('dialog.disconnected')
        if (message.action === 'ping') return
        if (message.action === 'start') {
          if (active) throw new Error('dialog.busy')
          const state = await getConversationState()
          const wait = cooldownRemaining(state.lastStartedAt)
          if (wait) throw new Error(`dialog.cooldown:${Math.ceil(wait / 1000)}`)
          const conversation = await getConversation(message.conversationId)
          if (!conversation) throw new Error('dialog.missing')
          const user = message.user as Turn | null
          const assistant = message.assistant as Turn
          if (assistant.role !== 'assistant' || assistant.status !== 'streaming' || !assistant.replyTo) throw new Error('dialog.invalid')
          if (user) {
            if (user.role !== 'user' || !user.text.trim() || conversation.turns.some((turn) => turn.id === user.id)) throw new Error('dialog.invalid')
            conversation.turns.push(user)
          } else {
            const index = conversation.turns.findIndex((turn) => turn.id === assistant.replyTo && turn.role === 'user')
            if (index < 0) throw new Error('dialog.invalid')
            conversation.turns = conversation.turns.slice(0, index + 1)
          }
          await validateContext(conversation)
          // Prune before establishing the generation lease so failure cannot strand it.
          await enforceConversationLimit(conversation.id)
          const generation = await startGeneration(conversation.id, user, assistant)
          active = { port, generation, text: '', tabId: port.sender?.tab?.id }
          await remember(conversation.id, port.sender?.tab?.id)
          changed()
          return { generation, conversation: await getConversation(conversation.id) }
        }
        if (message.action === 'update') {
          if (active?.port !== port) throw new Error('dialog.disconnected')
          const status = message.status as ReplyStatus
          if (!['streaming', 'complete', 'truncated', 'interrupted', 'cancelled', 'provider_error', 'empty'].includes(status) || typeof message.text !== 'string') throw new Error('dialog.invalid')
          const completedGeneration = active.generation
          await updateReply(completedGeneration, message.text, status, message.error, message.note, typeof message.title === 'string' ? message.title : undefined)
          active.text = message.text
          if (status !== 'streaming') {
            active = undefined
            await enforceConversationLimit()
          }
          changed()
          return
        }
        throw new Error('dialog.invalid')
      }).then((value) => {
        if (!disconnected) port.postMessage({ seq: message.seq, ok: true, value })
      }, (err) => {
        if (!disconnected) port.postMessage({ seq: message.seq, ok: false, error: err instanceof Error ? err.message : 'storage.write' })
      })
    })
    port.onDisconnect.addListener(() => {
      disconnected = true
      void serialized(async () => {
        if (active?.port !== port) return
        const lost = active
        active = undefined
        await updateReply(lost.generation, lost.text, 'interrupted')
        await enforceConversationLimit()
        changed()
      }).catch(() => {})
    })
  })
}
