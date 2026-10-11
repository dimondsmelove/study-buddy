import type { ApiMessage } from './api'
import type { TurnKind } from './prompts'
import type { UiLang } from './i18n'

export type ReplyStatus = 'streaming' | 'complete' | 'truncated' | 'interrupted' | 'cancelled' | 'provider_error' | 'empty'

export interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  display?: string
  kind: TurnKind | 'capture'
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
  titleGeneratedAt?: number
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

/** Prefer the persisted model title, then useful local content for legacy records. */
export function conversationDisplayTitle(conversation: Conversation, fallback: string): string {
  if (conversation.titleGeneratedAt !== undefined && conversation.title.trim()) return conversation.title
  const generic = new Set(['study buddy', 'new chat', 'solve', 'hint', 'check', 'explain', 'translate', 'summarize', 'multiple choice', 'выбор ответа', 'ask', 'check my attempt', 'проверить попытку', 'quiz', 'summary', 'конспект', 'решить', 'подсказка', 'проверить', 'объяснить', 'перевести', 'краткое содержание', 'новый чат'])
  if (conversation.title.trim() && !generic.has(conversation.title.trim().toLocaleLowerCase())) return excerpt(conversation.title)
  const explicit = [...conversation.turns].reverse().find((turn) => turn.role === 'user' && turn.input?.trim())?.input?.trim()
  if (explicit) return excerpt(explicit)
  const answer = conversation.turns.find((turn) => turn.role === 'assistant' && !!turn.text.trim())?.text
  if (answer) {
    const line = answer.split(/\r?\n/).map((value) => value.trim()).find((value) => {
      const heading = value.replace(/^#{1,6}\s*/, '').replace(/^\*\*(.*?)\*\*:?$/, '$1').replace(/:$/, '').trim().toLocaleLowerCase()
      return value && !['answer', 'solution', 'explanation', 'ответ', 'решение', 'объяснение'].includes(heading)
    })
    if (line) return excerpt(line.replace(/^#{1,6}\s*/, '').replace(/^[-*]\s*/, ''))
  }
  return fallback
}

function excerpt(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  return chars.length > 80 ? `${chars.slice(0, 77).join('')}…` : text
}

/** Message activity ignores capture previews, selections and streamed delta saves. */
export function conversationActivityAt(conversation: Conversation): number {
  return conversation.turns.reduce((latest, turn) => turn.kind === 'capture' ? latest : Math.max(latest, turn.createdAt), conversation.createdAt)
}

export const CONTEXT_LIMITS = { turns: 12, text: 32_000, images: 2, imageBytes: 4 * 1024 * 1024 }
export const GENERATION_INTERVAL = 10_000

export function cooldownRemaining(lastStartedAt: number, now = Date.now()): number {
  return Math.max(0, GENERATION_INTERVAL - Math.max(0, now - lastStartedAt))
}

/** Last selected task and its attempt remain source inputs, even outside the window. */
export type ContextExclusionReason = 'messages' | 'text' | 'imageLimit' | 'linkedImageLimit' | 'incomplete' | 'superseded' | 'empty'
export interface ContextEntry {
  turn: Turn
  included: boolean
  reason?: ContextExclusionReason
  imageState?: 'included' | 'excluded' | 'otherTurn'
}
export interface ContextProjection {
  turns: Turn[]
  omitted: number
  images: Set<string>
  entries: ContextEntry[]
}

export function contextProjection(conversation: Conversation): ContextProjection {
  const latestReplies = new Map<string, string>()
  for (const turn of conversation.turns) if (turn.role === 'assistant' && turn.status === 'complete' && turn.replyTo) latestReplies.set(turn.replyTo, turn.id)
  const usable: Turn[] = []
  const reasons = new Map<string, ContextExclusionReason>()
  for (const turn of conversation.turns) {
    if (turn.kind === 'capture' || turn.role === 'user') { usable.push(turn); continue }
    if (turn.status !== 'complete') reasons.set(turn.id, 'incomplete')
    else if (turn.replyTo && latestReplies.get(turn.replyTo) !== turn.id) reasons.set(turn.id, 'superseded')
    else if (!turn.text) reasons.set(turn.id, 'empty')
    else usable.push(turn)
  }

  const latestUser = [...usable].reverse().find((turn) => turn.role === 'user' && turn.kind !== 'capture')
  const taskId = latestUser?.attachmentId ?? conversation.activeAttachmentId
  const task = usable.find((turn) => turn.role === 'user' && turn.kind !== 'capture' && turn.attachmentId === taskId)
  const attempt = [...usable].reverse().find((turn) => turn.role === 'user' && !!turn.input && turn.kind === 'check' && turn.attachmentId === taskId)
  const required = new Set([latestUser?.id, task?.id, attempt?.id].filter((id): id is string => !!id))
  const selected = new Set(usable.slice(-CONTEXT_LIMITS.turns).map((turn) => turn.id))
  for (const id of required) selected.add(id)
  const excludeOldestOptional = (reason: 'messages' | 'text') => {
    const removable = usable.find((turn) => selected.has(turn.id) && !required.has(turn.id))
    if (!removable) throw new Error('context.text')
    selected.delete(removable.id)
    reasons.set(removable.id, reason)
  }
  while (selected.size > CONTEXT_LIMITS.turns) excludeOldestOptional('messages')
  const selectedTurns = () => usable.filter((turn) => selected.has(turn.id))
  while (selectedTurns().reduce((sum, turn) => sum + turn.text.length, 0) > CONTEXT_LIMITS.text) excludeOldestOptional('text')

  const turns = selectedTurns()
  const images = contextImages(turns)
  const excludedImageTurns = new Set(turns.filter((turn) => turn.attachmentId && !images.has(turn.attachmentId)).map((turn) => turn.id))
  for (const turn of turns) if (excludedImageTurns.has(turn.id)) reasons.set(turn.id, 'imageLimit')
  const included = turns.filter((turn) => !excludedImageTurns.has(turn.id) && (!turn.replyTo || !excludedImageTurns.has(turn.replyTo)))
  for (const turn of turns) if (turn.replyTo && excludedImageTurns.has(turn.replyTo)) reasons.set(turn.id, 'linkedImageLimit')

  const includedIds = new Set(included.map((turn) => turn.id))
  const imageTurns = new Map<string, string>()
  for (const turn of included) if (turn.attachmentId && images.has(turn.attachmentId) && !imageTurns.has(turn.attachmentId)) imageTurns.set(turn.attachmentId, turn.id)
  const entries = conversation.turns.map((turn) => {
    const includedHere = includedIds.has(turn.id)
    let imageState: ContextEntry['imageState']
    if (turn.attachmentId) {
      if (!images.has(turn.attachmentId)) imageState = 'excluded'
      else if (imageTurns.get(turn.attachmentId) === turn.id) imageState = 'included'
      else imageState = 'otherTurn'
    }
    return { turn, included: includedHere, reason: includedHere ? undefined : reasons.get(turn.id) ?? 'messages', imageState }
  })
  return {
    turns: included,
    images,
    entries,
    omitted: entries.filter((entry) => !entry.included).length,
  }
}

/** Compatibility for coordinator checks and existing callers. */
export function contextTurns(conversation: Conversation): { turns: Turn[]; omitted: number } {
  const { turns, omitted } = contextProjection(conversation)
  return { turns, omitted }
}

export function contextImages(turns: Turn[]): Set<string> {
  const wanted = new Set<string>()
  const latest = [...turns].reverse().find((turn) => turn.role === 'user' && turn.kind !== 'capture')
  if (latest?.attachmentId) wanted.add(latest.attachmentId)
  for (const turn of [...turns].reverse()) {
    if (turn.attachmentId && wanted.size < CONTEXT_LIMITS.images) wanted.add(turn.attachmentId)
  }
  return wanted
}

export async function requestContext(
  conversation: Conversation,
  readImage: (id: string) => Promise<Blob | undefined>,
  projection = contextProjection(conversation),
): Promise<{ messages: ApiMessage[]; omitted: number }> {
  const sent = new Set<string>()
  const messages: ApiMessage[] = []
  for (const turn of projection.turns) {
    const content: Exclude<ApiMessage['content'], string> = []
    if (turn.text) content.push({ type: 'text', text: turn.text })
    if (turn.role === 'user' && turn.attachmentId && projection.images.has(turn.attachmentId) && !sent.has(turn.attachmentId)) {
      const data = await readImage(turn.attachmentId)
      if (!data) throw new Error('context.imageMissing')
      if (data.size > CONTEXT_LIMITS.imageBytes) throw new Error('context.imageLarge')
      content.push({ type: 'image_url', image_url: { url: await blobDataUrl(data) } })
      sent.add(turn.attachmentId)
    }
    if (turn.role === 'user' && content.length) messages.push({ role: 'user', content })
    else if (turn.role === 'assistant') messages.push({ role: 'assistant', content: turn.text })
  }
  return { messages, omitted: projection.omitted }
}

export function blobDataUrl(data: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('storage.read'))
    reader.readAsDataURL(data)
  })
}
