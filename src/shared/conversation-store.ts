import { normalizeGeneratedTitle } from './title'
import { conversationActivityAt, type Attachment, type Conversation, type ConversationState, type Generation, type Turn } from './conversations'

const DATABASE = 'study-buddy-conversations'
let connection: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  if (connection) return connection
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('conversations', { keyPath: 'id' })
      db.createObjectStore('attachments', { keyPath: 'id' })
      db.createObjectStore('state', { keyPath: 'id' })
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); connection = undefined }
      resolve(db)
    }
    request.onerror = () => { connection = undefined; reject(new Error('storage.open')) }
    request.onblocked = () => { connection = undefined; reject(new Error('storage.blocked')) }
  })
  return connection
}

/** Resolve on commit, not on put success: quota/abort must never look saved. */
async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, done: (value: T) => void) => void,
): Promise<T> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode)
    let result: T
    tx.oncomplete = () => resolve(result)
    tx.onabort = () => reject(new Error('storage.write'))
    tx.onerror = () => reject(new Error('storage.write'))
    try { run(tx, (value) => { result = value }) } catch (err) { tx.abort(); reject(err) }
  })
}

export function getConversation(id: string): Promise<Conversation | undefined> {
  return transaction(['conversations'], 'readonly', (tx, done) => {
    const request = tx.objectStore('conversations').get(id)
    request.onsuccess = () => done(request.result)
  })
}

export function listConversations(): Promise<Conversation[]> {
  return transaction(['conversations'], 'readonly', (tx, done) => {
    const request = tx.objectStore('conversations').getAll()
    request.onsuccess = () => done((request.result as Conversation[]).sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a) || b.createdAt - a.createdAt))
  })
}

export function getAttachment(id: string): Promise<Attachment | undefined> {
  return transaction(['attachments'], 'readonly', (tx, done) => {
    const request = tx.objectStore('attachments').get(id)
    request.onsuccess = () => done(request.result)
  })
}

export function getConversationState(): Promise<ConversationState> {
  return transaction(['state'], 'readonly', (tx, done) => {
    const request = tx.objectStore('state').get('state')
    request.onsuccess = () => done(request.result ?? { id: 'state', lastStartedAt: 0 })
  })
}

export function createConversation(title: string): Promise<Conversation> {
  const now = Date.now()
  const conversation: Conversation = { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now, turns: [] }
  return transaction(['conversations', 'state'], 'readwrite', (tx, done) => {
    tx.objectStore('conversations').add(conversation)
    const state = tx.objectStore('state')
    const request = state.get('state')
    request.onsuccess = () => state.put({ ...(request.result ?? { lastStartedAt: 0 }), id: 'state', lastConversationId: conversation.id })
    done(conversation)
  })
}

export function selectConversation(id: string): Promise<void> {
  return transaction(['state'], 'readwrite', (tx, done) => {
    const state = tx.objectStore('state')
    const request = state.get('state')
    request.onsuccess = () => state.put({ ...(request.result ?? { lastStartedAt: 0 }), id: 'state', lastConversationId: id })
    done(undefined)
  })
}

export function attachCapture(id: string, attachment: Attachment): Promise<Conversation> {
  return transaction(['conversations', 'attachments'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('conversations')
    const request = store.get(id)
    request.onsuccess = () => {
      const conversation = request.result as Conversation | undefined
      if (!conversation) { tx.abort(); return }
      const duplicate = conversation.turns.some((turn) => turn.kind === 'capture' && turn.id === attachment.id)
      if (!duplicate) {
        conversation.activeAttachmentId = attachment.id
        conversation.turns.push({ id: attachment.id, role: 'user', text: '', kind: 'capture', attachmentId: attachment.id, createdAt: attachment.createdAt, locale: 'en', promptVersion: 'capture' })
        tx.objectStore('attachments').put(attachment)
      }
      store.put(conversation)
      done(conversation)
    }
  })
}

export function startGeneration(conversationId: string, user: Turn | null, assistant: Turn, now = Date.now()): Promise<Generation> {
  return transaction(['conversations', 'state'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('conversations')
    const request = store.get(conversationId)
    request.onsuccess = () => {
      const conversation = request.result as Conversation | undefined
      if (!conversation) { tx.abort(); return }
      if (user) {
        conversation.turns.push(user)
        if (!conversation.turns.some((turn) => turn.role === 'user' && turn.kind !== 'capture' && turn.id !== user.id)) conversation.title = (user.input || user.display || conversation.title).slice(0, 80)
      }
      conversation.turns.push(assistant)
      conversation.updatedAt = now
      store.put(conversation)
      const generation = { conversationId, turnId: assistant.id, requestId: crypto.randomUUID() }
      const state = tx.objectStore('state')
      const get = state.get('state')
      get.onsuccess = () => state.put({ ...(get.result ?? {}), id: 'state', lastConversationId: conversationId, lastStartedAt: now, generation })
      done(generation)
    }
  })
}

export function updateReply(generation: Generation, text: string, status: Turn['status'], error?: string, note?: string, generatedTitle?: string): Promise<void> {
  return transaction(['conversations', 'state'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('conversations')
    const request = store.get(generation.conversationId)
    request.onsuccess = () => {
      const conversation = request.result as Conversation | undefined
      const turn = conversation?.turns.find((item) => item.id === generation.turnId)
      if (!conversation || !turn || turn.status !== 'streaming') { tx.abort(); return }
      turn.text = text
      turn.status = status
      turn.error = error
      turn.note = note ?? turn.note
      const title = generatedTitle && conversation.titleGeneratedAt === undefined ? normalizeGeneratedTitle(generatedTitle) : undefined
      if (title) { conversation.title = title; conversation.titleGeneratedAt = Date.now() }
      conversation.updatedAt = Date.now()
      store.put(conversation)
      if (status !== 'streaming') {
        const state = tx.objectStore('state')
        const get = state.get('state')
        get.onsuccess = () => {
          const value = get.result as ConversationState
          if (value.generation?.requestId === generation.requestId) {
            delete value.generation
            state.put(value)
          }
        }
      }
      done(undefined)
    }
  })
}

export async function recoverGeneration(): Promise<void> {
  const state = await getConversationState()
  if (!state.generation) return
  const conversation = await getConversation(state.generation.conversationId)
  const turn = conversation?.turns.find((item) => item.id === state.generation?.turnId)
  if (turn?.status === 'streaming') await updateReply(state.generation, turn.text, 'interrupted')
  else await transaction(['state'], 'readwrite', (tx, done) => {
    delete state.generation
    tx.objectStore('state').put(state)
    done(undefined)
  })
}

export function deleteConversation(id: string): Promise<void> {
  return transaction(['conversations', 'attachments', 'state'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('conversations')
    store.delete(id)
    const request = store.getAll()
    request.onsuccess = () => {
      const referenced = new Set<string>()
      for (const conversation of request.result as Conversation[]) {
        if (conversation.activeAttachmentId) referenced.add(conversation.activeAttachmentId)
        for (const turn of conversation.turns) if (turn.attachmentId) referenced.add(turn.attachmentId)
      }
      const attachments = tx.objectStore('attachments')
      const keys = attachments.getAllKeys()
      keys.onsuccess = () => { for (const key of keys.result) if (!referenced.has(String(key))) attachments.delete(key) }
      const state = tx.objectStore('state')
      const get = state.get('state')
      get.onsuccess = () => {
        const value = get.result as ConversationState | undefined
        if (value?.lastConversationId === id) {
          value.lastConversationId = (request.result as Conversation[]).sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a) || b.createdAt - a.createdAt)[0]?.id
          state.put(value)
        }
      }
      done(undefined)
    }
  })
}

/** Keep the newest 20 message-active chats and any current writer in one transaction. */
export function enforceConversationLimit(protectedConversationId?: string, limit = 20): Promise<void> {
  return transaction(['conversations', 'attachments', 'state'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('conversations')
    const all = store.getAll()
    all.onsuccess = () => {
      const rows = all.result as Conversation[]
      const stateStore = tx.objectStore('state')
      const stateRequest = stateStore.get('state')
      stateRequest.onsuccess = () => {
        const state = stateRequest.result as ConversationState | undefined
        const protectedIds = new Set([state?.generation?.conversationId, protectedConversationId].filter((id): id is string => !!id))
        const ordered = rows.sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a) || b.createdAt - a.createdAt)
        const keep = new Set(ordered.slice(0, limit).map((row) => row.id))
        for (const id of protectedIds) if (rows.some((row) => row.id === id)) keep.add(id)
        while (keep.size > limit) {
          const oldest = [...ordered].reverse().find((row) => keep.has(row.id) && !protectedIds.has(row.id))
          if (!oldest) break
          keep.delete(oldest.id)
        }
        const removed = rows.filter((row) => !keep.has(row.id))
        for (const row of removed) store.delete(row.id)
        if (removed.length && state) {
          const removedIds = new Set(removed.map((row) => row.id))
          if (state.lastConversationId && removedIds.has(state.lastConversationId)) {
            state.lastConversationId = ordered.find((row) => keep.has(row.id))?.id
            stateStore.put(state)
          }
        }
        if (!removed.length) { done(undefined); return }
        const referenced = new Set<string>()
        for (const row of rows.filter((item) => keep.has(item.id))) {
          if (row.activeAttachmentId) referenced.add(row.activeAttachmentId)
          for (const turn of row.turns) if (turn.attachmentId) referenced.add(turn.attachmentId)
        }
        const attachments = tx.objectStore('attachments')
        const keys = attachments.getAllKeys()
        keys.onsuccess = () => { for (const key of keys.result) if (!referenced.has(String(key))) attachments.delete(key) }
        done(undefined)
      }
    }
  })
}

export async function conversationUsage(): Promise<number> {
  const conversations = await listConversations()
  const blobs = await transaction<Attachment[]>(['attachments'], 'readonly', (tx, done) => {
    const request = tx.objectStore('attachments').getAll()
    request.onsuccess = () => done(request.result)
  })
  return new TextEncoder().encode(JSON.stringify(conversations)).byteLength + blobs.reduce((sum, attachment) => sum + attachment.data.size, 0)
}
