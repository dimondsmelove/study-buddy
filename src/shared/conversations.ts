import type { ApiMessage } from './api'
import type { TurnKind } from './prompts'
import type { UiLang } from './i18n'
import { GATEWAY_LIMITS, estimateTextTokens, gatewayRequestBytes, prepareGatewayGeneration, type GatewayGenerationInput } from './gateway-protocol'

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
  inputTokens: GATEWAY_LIMITS.inputTokens,
  estimateHeadroom: GATEWAY_LIMITS.estimateHeadroom,
  imageTokenEstimate: GATEWAY_LIMITS.imageTokenEstimate,
  imageBytes: GATEWAY_LIMITS.imageBytes,
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
  /** Optional canonical task metadata makes this estimate match the gateway payload. */
  generation?: Omit<GatewayGenerationInput, 'requestId' | 'messages'>
  imageByteSizes?: ReadonlyMap<string, { size: number; type: string }>
}

/** Keep the newest complete exchanges that fit, pinning the current request and its image. */
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

  const latestUser = [...usable].reverse().find((turn) => turn.role === 'user' && turn.kind !== 'capture')
  const pinnedIds = new Set<string>()
  if (latestUser) {
    pinnedIds.add(latestUser.id)
    if (latestUser.attachmentId) for (const turn of usable) {
      if (turn.kind === 'capture' && turn.attachmentId === latestUser.attachmentId) pinnedIds.add(turn.id)
    }
  }
  const sourceAttachmentId = latestUser?.attachmentId ?? conversation.activeAttachmentId
  if (sourceAttachmentId) {
    const capture = [...usable].reverse().find((turn) => turn.kind === 'capture' && turn.attachmentId === sourceAttachmentId)
    if (capture) pinnedIds.add(capture.id)
  }

  const replies = new Map<string, Turn[]>()
  for (const turn of usable) if (turn.role === 'assistant' && turn.replyTo) {
    const values = replies.get(turn.replyTo) ?? []
    values.push(turn)
    replies.set(turn.replyTo, values)
  }
  const units: Turn[][] = []
  const assigned = new Set<string>()
  for (const turn of usable) {
    if (assigned.has(turn.id)) continue
    if (turn.kind === 'capture') {
      units.push([turn])
      assigned.add(turn.id)
    } else if (turn.role === 'user') {
      const unit = [turn, ...(replies.get(turn.id) ?? [])]
      unit.sort((a, b) => usable.indexOf(a) - usable.indexOf(b))
      units.push(unit)
      for (const member of unit) assigned.add(member.id)
    } else if (!assigned.has(turn.id)) {
      units.push([turn])
      assigned.add(turn.id)
    }
  }
  const currentUnit = latestUser ? units.find((unit) => unit.some((turn) => turn.id === latestUser.id)) : undefined
  const selectedIds = new Set(pinnedIds)
  if (currentUnit) for (const turn of currentUnit) selectedIds.add(turn.id)
  // TEMP manual-test override: restore to CONTEXT_LIMITS.inputTokens - CONTEXT_LIMITS.estimateHeadroom after checking.
  const inputLimit = Math.min(CONTEXT_LIMITS.inputTokens - CONTEXT_LIMITS.estimateHeadroom, 5_000)
  const estimate = (ids: Set<string>): number => {
    const turns = usable.filter((turn) => ids.has(turn.id))
    const messages = previewContextMessages(turns)
    if (messages.length > GATEWAY_LIMITS.maxMessages) return Number.POSITIVE_INFINITY
    let tokenEstimate: number
    if (options.generation) tokenEstimate = prepareGatewayGeneration({
      ...options.generation, requestId: '00000000-0000-4000-8000-000000000000', messages,
    }).estimatedInputTokens
    else {
      const renderedText = messages.map((message) => message.role + '\n' + (typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''))).join('\n')
      const imageIds = new Set(turns.flatMap((turn) => turn.role === 'user' && turn.attachmentId ? [turn.attachmentId] : []))
      tokenEstimate = estimateTextTokens(renderedText) + messages.length * 8 + imageIds.size * CONTEXT_LIMITS.imageTokenEstimate
    }
    if (tokenEstimate > inputLimit) return tokenEstimate
    if (options.imageByteSizes) {
      for (const id of contextImages(turns)) {
        const image = options.imageByteSizes.get(id)
        if (!image || image.size > CONTEXT_LIMITS.imageBytes) return Number.POSITIVE_INFINITY
      }
    }
    if (options.generation && options.imageByteSizes) {
      const payload = { ...options.generation, requestId: '00000000-0000-4000-8000-000000000000', messages }
      let requestBytes = gatewayRequestBytes(payload)
      for (const id of contextImages(turns)) {
        const image = options.imageByteSizes.get(id)
        if (!image) continue
        const encodedLength = 4 * Math.ceil(image.size / 3)
        const prefix = 'data:' + (image.type || 'image/png') + ';base64,'
        requestBytes += encodedLength + prefix.length - 'data:image/png;base64,AA=='.length
      }
      if (requestBytes > GATEWAY_LIMITS.requestBytes) return Number.POSITIVE_INFINITY
    }
    return tokenEstimate
  }
  if ((latestUser || selectedIds.size) && estimate(selectedIds) > inputLimit) {
    const essentialImageId = latestUser?.attachmentId ?? conversation.activeAttachmentId
    const essentialImage = essentialImageId ? options.imageByteSizes?.get(essentialImageId) : undefined
    if (essentialImageId && options.imageByteSizes && !essentialImage) throw new Error('context.imageMissing')
    if (essentialImage && essentialImage.size > CONTEXT_LIMITS.imageBytes) throw new Error('context.imageLarge')
    selectedIds.clear()
    for (const id of pinnedIds) selectedIds.add(id)
    if (latestUser && estimate(selectedIds) > inputLimit) throw new Error('context.taskTooLarge')
  }
  let stoppedAtBoundary = false
  const reversedUnits = [...units].reverse()
  for (const unit of reversedUnits) {
    if (unit.every((turn) => selectedIds.has(turn.id))) continue
    const pending = unit.filter((turn) => !selectedIds.has(turn.id))
    if (stoppedAtBoundary) { for (const turn of pending) reasons.set(turn.id, 'olderTask'); continue }
    const candidate = new Set(selectedIds)
    for (const turn of pending) candidate.add(turn.id)
    if (estimate(candidate) <= inputLimit) {
      for (const turn of pending) selectedIds.add(turn.id)
    } else {
      stoppedAtBoundary = true
      for (const turn of pending) reasons.set(turn.id, 'olderTask')
    }
  }
  const turns = usable.filter((turn) => selectedIds.has(turn.id))
  const images = contextImages(turns)
  const includedIds = new Set(turns.map((turn) => turn.id))
  const imageTurns = new Map<string, string>()
  for (const turn of turns) if (turn.role === 'user' && turn.attachmentId && images.has(turn.attachmentId)) imageTurns.set(turn.attachmentId, turn.id)
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
  return { turns, images, entries, omitted: entries.filter((entry) => !entry.included).length,
    estimatedInputTokens: estimate(selectedIds), inputBudget: CONTEXT_LIMITS.inputTokens }
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

function contextItems(turns: Turn[], images: Set<string>): Array<{ turn: Turn; imageId?: string }> {
  const lastTurnForImage = new Map<string, string>()
  for (const turn of turns) if (turn.role === 'user' && turn.attachmentId && images.has(turn.attachmentId)) {
    lastTurnForImage.set(turn.attachmentId, turn.id)
  }
  return turns.map((turn) => ({
    turn,
    imageId: turn.role === 'user' && turn.attachmentId && lastTurnForImage.get(turn.attachmentId) === turn.id
      ? turn.attachmentId
      : undefined,
  }))
}

function previewContextMessages(turns: Turn[]): ApiMessage[] {
  const messages: ApiMessage[] = []
  const currentUserId = [...turns].reverse().find((turn) => turn.role === 'user' && turn.kind !== 'capture')?.id
  for (const { turn, imageId } of contextItems(turns, contextImages(turns))) {
    if (turn.role === 'assistant') {
      if (turn.text) messages.push({ role: 'assistant', content: turn.text })
      continue
    }
    const content: Exclude<ApiMessage['content'], string> = []
    const text = contextTurnText(turn)
    if (text) content.push({ type: 'text', text })
    if (imageId) content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } })
    if (content.length) messages.push({ role: 'user', content })
    else if (turn.id === currentUserId) messages.push({ role: 'user', content: '' })
  }
  return messages
}

export async function requestContext(
  readImage: (id: string) => Promise<Blob | undefined>,
  projection: ContextProjection,
): Promise<{ messages: ApiMessage[]; omitted: number }> {
  const messages: ApiMessage[] = []
  const currentUserId = [...projection.turns].reverse().find((turn) => turn.role === 'user' && turn.kind !== 'capture')?.id
  for (const { turn, imageId } of contextItems(projection.turns, projection.images)) {
    if (turn.role === 'assistant') {
      if (turn.text) messages.push({ role: 'assistant', content: turn.text })
      continue
    }
    const content: Exclude<ApiMessage['content'], string> = []
    const text = contextTurnText(turn)
    if (text) content.push({ type: 'text', text })
    if (imageId) {
      const data = await readImage(imageId)
      if (!data) throw new Error('context.imageMissing')
      if (data.size > CONTEXT_LIMITS.imageBytes) throw new Error('context.imageLarge')
      content.push({ type: 'image_url', image_url: { url: await blobDataUrl(data) } })
    }
    if (content.length) messages.push({ role: 'user', content })
    else if (turn.id === currentUserId) messages.push({ role: 'user', content: '' })
  }
  return { messages, omitted: projection.omitted }
}

function contextTurnText(turn: Turn): string {
  if (turn.role === 'assistant') return turn.text
  if (turn.kind === 'ask') return turn.input ?? turn.text
  if (turn.kind === 'check') return turn.input ?? ''
  return ''
}

export function blobDataUrl(data: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('storage.read'))
    reader.readAsDataURL(data)
  })
}
