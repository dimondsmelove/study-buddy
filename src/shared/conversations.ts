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
  usage?: { model?: string; promptTokens?: number; completionTokens?: number; cost?: number }
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

export const CONTEXT_LIMITS = {
  inputTokens: 200_000,
  estimateHeadroom: 20_000,
  imageTokenEstimate: 1_024,
  imageBytes: 4 * 1024 * 1024,
}
export const GENERATION_INTERVAL = 10_000

export function cooldownRemaining(lastStartedAt: number, now = Date.now()): number {
  return Math.max(0, GENERATION_INTERVAL - Math.max(0, now - lastStartedAt))
}

export type ContextExclusionReason = 'olderTask' | 'incomplete' | 'superseded' | 'empty'
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
  estimatedInputTokens: number
  inputBudget: number
}
export interface ContextProjectionOptions {
  /** Local model-specific estimate for text parts, not provider-exact usage. */
  countTokens: (text: string) => number
  systemPrompt: string
}

/** Keep the newest whole task groups that fit the estimated prompt budget. */
export function contextProjection(conversation: Conversation, options: ContextProjectionOptions): ContextProjection {
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

  const groupForTurn = new Map<string, string>()
  const groups = new Map<string, Turn[]>()
  let latestGroup = conversation.activeAttachmentId ?? 'text-session'
  for (const turn of usable) {
    if (turn.kind === 'capture' && turn.attachmentId) latestGroup = turn.attachmentId
    let key = turn.attachmentId ?? latestGroup
    if (turn.role === 'assistant' && turn.replyTo) key = groupForTurn.get(turn.replyTo) ?? key
    if (turn.role === 'user' && turn.kind !== 'capture' && !turn.attachmentId) latestGroup = key
    groupForTurn.set(turn.id, key)
    const group = groups.get(key) ?? []
    group.push(turn)
    groups.set(key, group)
  }

  const latestUser = [...usable].reverse().find((turn) => turn.role === 'user' && turn.kind !== 'capture')
  const currentGroup = latestUser ? groupForTurn.get(latestUser.id) : conversation.activeAttachmentId ?? [...groups.keys()].at(-1)
  const orderedGroups = [...groups.entries()].sort((a, b) => usable.indexOf(a[1].at(-1)!) - usable.indexOf(b[1].at(-1)!))
  const selectedGroups: Turn[][] = []
  const selectedIds = new Set<string>()
  const inputLimit = CONTEXT_LIMITS.inputTokens - CONTEXT_LIMITS.estimateHeadroom
  const estimate = (candidate: Turn[][]): number => {
    const turns = candidate.flat().sort((a, b) => usable.indexOf(a) - usable.indexOf(b))
    const renderedText = [options.systemPrompt, ...turns.map((turn) => `${turn.role}\n${turn.text}`)].join('\n')
    const imageIds = new Set(turns.flatMap((turn) => turn.role === 'user' && turn.attachmentId ? [turn.attachmentId] : []))
    // OpenRouter does not expose image-token preflight. Reserve per image, add
    // message framing overhead, and keep a 10% margin for route variance.
    return options.countTokens(renderedText) + turns.length * 8 + imageIds.size * CONTEXT_LIMITS.imageTokenEstimate
  }
  let stoppedAtBoundary = false
  for (const [key, group] of [...orderedGroups].reverse()) {
    if (stoppedAtBoundary) {
      for (const turn of group) reasons.set(turn.id, 'olderTask')
      continue
    }
    const estimateTokens = estimate([...selectedGroups, group])
    if (key === currentGroup && !selectedGroups.length && estimateTokens > inputLimit) throw new Error('context.taskTooLarge')
    if (estimateTokens <= inputLimit || key === currentGroup) {
      selectedGroups.push(group)
      for (const turn of group) selectedIds.add(turn.id)
    } else {
      stoppedAtBoundary = true
      for (const turn of group) reasons.set(turn.id, 'olderTask')
    }
  }
  selectedGroups.reverse()
  const turns = usable.filter((turn) => selectedIds.has(turn.id))
  const images = contextImages(turns)
  const includedIds = new Set(turns.map((turn) => turn.id))
  const imageTurns = new Map<string, string>()
  for (const turn of turns) if (turn.attachmentId && images.has(turn.attachmentId) && !imageTurns.has(turn.attachmentId)) imageTurns.set(turn.attachmentId, turn.id)
  const entries = conversation.turns.map((turn) => {
    const included = includedIds.has(turn.id)
    let imageState: ContextEntry['imageState']
    if (turn.attachmentId) {
      if (!images.has(turn.attachmentId)) imageState = 'excluded'
      else if (imageTurns.get(turn.attachmentId) === turn.id) imageState = 'included'
      else imageState = 'otherTurn'
    }
    return { turn, included, reason: included ? undefined : reasons.get(turn.id) ?? 'olderTask', imageState }
  })
  return {
    turns,
    images,
    entries,
    omitted: entries.filter((entry) => !entry.included).length,
    estimatedInputTokens: estimate(selectedGroups),
    inputBudget: CONTEXT_LIMITS.inputTokens,
  }
}

/** Compatibility for caller and storage contracts. */
export function contextTurns(conversation: Conversation, options: ContextProjectionOptions): { turns: Turn[]; omitted: number } {
  const { turns, omitted } = contextProjection(conversation, options)
  return { turns, omitted }
}

export function contextImages(turns: Turn[]): Set<string> {
  const wanted = new Set<string>()
  for (const turn of turns) if (turn.role === 'user' && turn.attachmentId) wanted.add(turn.attachmentId)
  return wanted
}

export async function requestContext(
  readImage: (id: string) => Promise<Blob | undefined>,
  projection: ContextProjection,
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
