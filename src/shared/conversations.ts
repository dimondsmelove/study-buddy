import type { ApiMessage } from './api'
import type { TurnKind } from './prompts'
import type { UiLang } from './i18n'

export type ReplyStatus = 'streaming' | 'complete' | 'truncated' | 'interrupted' | 'cancelled' | 'provider_error' | 'empty'

export interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  display?: string
  kind: TurnKind
  attachmentId?: string
  status?: ReplyStatus
  error?: string
  note?: string
  createdAt: number
  locale: UiLang
  promptVersion: string
  /** Explicit input, independently of the generated tutor instruction. */
  input?: string
  replyTo?: string
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  activeAttachmentId?: string
  turns: Turn[]
}

export interface Attachment {
  id: string
  data: Blob
  createdAt: number
}

export interface Generation {
  conversationId: string
  turnId: string
  requestId: string
}

export interface ConversationState {
  id: 'state'
  lastConversationId?: string
  lastStartedAt: number
  generation?: Generation
}

export const CONTEXT_LIMITS = { turns: 12, text: 32_000, images: 2, imageBytes: 4 * 1024 * 1024 }
export const GENERATION_INTERVAL = 10_000

export function cooldownRemaining(lastStartedAt: number, now = Date.now()): number {
  return Math.max(0, GENERATION_INTERVAL - Math.max(0, now - lastStartedAt))
}

/** Last selected task and its attempt remain source inputs, even outside the window. */
export function contextTurns(conversation: Conversation): { turns: Turn[]; omitted: number } {
  const latestReplies = new Map<string, string>()
  for (const turn of conversation.turns) if (turn.role === 'assistant' && turn.status === 'complete' && turn.replyTo) latestReplies.set(turn.replyTo, turn.id)
  const usable = conversation.turns.filter((turn) => turn.role === 'user' || (!!turn.text && turn.status === 'complete' && (!turn.replyTo || latestReplies.get(turn.replyTo) === turn.id)))
  const latestUser = [...usable].reverse().find((turn) => turn.role === 'user')
  const taskId = latestUser?.attachmentId ?? conversation.activeAttachmentId
  const task = usable.find((turn) => turn.role === 'user' && turn.attachmentId === taskId)
  const attempt = [...usable].reverse().find((turn) => turn.role === 'user' && !!turn.input && turn.kind === 'check')
  const required = new Set([latestUser?.id, task?.id, attempt?.attachmentId === taskId ? attempt?.id : undefined])
  const selected = usable.slice(-CONTEXT_LIMITS.turns)
  for (const turn of usable) if (required.has(turn.id) && !selected.includes(turn)) selected.push(turn)
  selected.sort((a, b) => usable.indexOf(a) - usable.indexOf(b))
  while (selected.length > CONTEXT_LIMITS.turns) {
    const index = selected.findIndex((turn) => !required.has(turn.id))
    if (index < 0) throw new Error('context.text')
    selected.splice(index, 1)
  }
  // Remove older optional turns first; never cut the current condition/attempt.
  while (selected.reduce((sum, turn) => sum + turn.text.length, 0) > CONTEXT_LIMITS.text) {
    const index = selected.findIndex((turn) => !required.has(turn.id))
    if (index < 0) throw new Error('context.text')
    selected.splice(index, 1)
  }
  const images = contextImages(selected)
  const excluded = new Set(selected.filter((turn) => turn.role === 'user' && turn.attachmentId && !images.has(turn.attachmentId)).map((turn) => turn.id))
  const included = selected.filter((turn) => !excluded.has(turn.id) && (!turn.replyTo || !excluded.has(turn.replyTo)))
  return { turns: included, omitted: conversation.turns.filter((turn) => !!turn.text).length - included.length }
}

export function contextImages(turns: Turn[]): Set<string> {
  const wanted = new Set<string>()
  const latest = [...turns].reverse().find((turn) => turn.role === 'user')
  if (latest?.attachmentId) wanted.add(latest.attachmentId)
  for (const turn of [...turns].reverse()) {
    if (turn.attachmentId && wanted.size < CONTEXT_LIMITS.images) wanted.add(turn.attachmentId)
  }
  return wanted
}

export async function requestContext(
  conversation: Conversation,
  readImage: (id: string) => Promise<Blob | undefined>,
): Promise<{ messages: ApiMessage[]; omitted: number }> {
  const { turns, omitted } = contextTurns(conversation)
  const wanted = contextImages(turns)
  const sent = new Set<string>()
  const messages: ApiMessage[] = []
  for (const turn of turns) {
    const content: Exclude<ApiMessage['content'], string> = [{ type: 'text', text: turn.text }]
    if (turn.role === 'user' && turn.attachmentId && wanted.has(turn.attachmentId) && !sent.has(turn.attachmentId)) {
      const data = await readImage(turn.attachmentId)
      if (!data) throw new Error('context.imageMissing')
      if (data.size > CONTEXT_LIMITS.imageBytes) throw new Error('context.imageLarge')
      content.push({ type: 'image_url', image_url: { url: await blobDataUrl(data) } })
      sent.add(turn.attachmentId)
    }
    messages.push({ role: turn.role, content: turn.role === 'assistant' ? turn.text : content })
  }
  return { messages, omitted }
}

export function blobDataUrl(data: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('storage.read'))
    reader.readAsDataURL(data)
  })
}
