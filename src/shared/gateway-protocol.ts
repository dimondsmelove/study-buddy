import type { ApiContent, ApiMessage } from './api'
import type { AnswerLanguage } from './settings'
import {
  checkPrompt,
  firstAnswerTitleInstruction,
  simplerPrompt,
  systemPrompt,
  taskPrompt,
  turnParams,
  type TurnKind,
  type TaskId,
} from './prompts'

export const GATEWAY_LIMITS = {
  inputTokens: 200_000,
  estimateHeadroom: 20_000,
  imageTokenEstimate: 1_024,
  imageBytes: 4 * 1024 * 1024,
  requestBytes: 32 * 1024 * 1024,
  operationTimeoutMs: 180_000,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
  idempotencyWindowMs: 24 * 60 * 60 * 1_000,
  cooldownMs: 10_000,
  maxConcurrentGenerations: 4,
  maxMessages: 2_000,
  maxMessageChars: 1_000_000,
  maxTaskInputChars: 1_000_000,
} as const

export type GatewayUiLanguage = 'en' | 'ru'

/** Client-supplied intent and selected local context. Prompts and model params
 * are always reconstructed on the server from these allowlisted fields. */
export interface GatewayGenerationInput {
  requestId: string
  task: TurnKind
  answerLanguage: AnswerLanguage
  uiLanguage: GatewayUiLanguage
  titleNeeded: boolean
  taskInput?: string
  messages: ApiMessage[]
}

export interface PreparedGatewayGeneration {
  messages: ApiMessage[]
  temperature: number
  maxTokens: number
  estimatedInputTokens: number
  inputBudget: number
}

/** This heuristic intentionally overestimates many ordinary words and remains
 * approximate. It is not a model tokenizer or a guarantee of provider limits. */
export function estimateTextTokens(text: string): number {
  const bytes = new TextEncoder().encode(text).byteLength
  let punctuation = 0
  let complexSymbols = 0
  let longAsciiRun = 0
  let run = 0
  for (const character of text) {
    if (/^[\p{P}\p{S}]$/u.test(character)) punctuation++
    if (/^[\p{Extended_Pictographic}\p{M}]$/u.test(character)) complexSymbols++
    if (/^[A-Za-z0-9]$/.test(character)) {
      run++
    } else {
      if (run > 32) longAsciiRun += Math.ceil((run - 32) / 2)
      run = 0
    }
  }
  if (run > 32) longAsciiRun += Math.ceil((run - 32) / 2)
  return Math.ceil(bytes / 3) + punctuation + complexSymbols * 2 + longAsciiRun
}

const ANSWER_LANGUAGES: readonly AnswerLanguage[] = [
  'auto', 'en', 'ru', 'uk', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr', 'zh', 'ja',
]
const TASK_KINDS: readonly TurnKind[] = [
  'solve', 'quiz', 'explain', 'translate', 'summarize', 'hint', 'ask', 'simpler', 'check',
]

export function isAnswerLanguage(value: unknown): value is AnswerLanguage {
  return typeof value === 'string' && ANSWER_LANGUAGES.includes(value as AnswerLanguage)
}

export function isTurnKind(value: unknown): value is TurnKind {
  return typeof value === 'string' && TASK_KINDS.includes(value as TurnKind)
}

/** Build the exact provider messages from client-selected user/assistant
 * history. The last user turn keeps its image parts, while its text is replaced
 * by the canonical task prompt or explicit free Ask/Check input. */
export function prepareGatewayGeneration(input: GatewayGenerationInput): PreparedGatewayGeneration {
  const last = input.messages.at(-1)
  if (!last || last.role !== 'user') throw new Error('gateway.currentUserRequired')

  const promptContext = { answerLanguage: input.answerLanguage, uiLang: input.uiLanguage }
  let canonicalText: string
  if (input.task === 'ask') {
    if (typeof input.taskInput !== 'string' || !input.taskInput.trim()) throw new Error('gateway.askInputRequired')
    canonicalText = input.taskInput.trim()
  } else if (input.task === 'check') {
    canonicalText = checkPrompt(input.taskInput, promptContext)
  } else if (input.task === 'simpler') {
    canonicalText = simplerPrompt(promptContext)
  } else {
    canonicalText = taskPrompt(input.task as TaskId, promptContext)
  }

  const system = systemPrompt(promptContext) + (input.titleNeeded
    ? '\n\n' + firstAnswerTitleInstruction(promptContext)
    : '')
  const messages = input.messages.map((message, index) => {
    if (index !== input.messages.length - 1) return cloneMessage(message)
    return { role: 'user' as const, content: withCanonicalText(last.content, canonicalText) }
  })
  const providerMessages: ApiMessage[] = [{ role: 'system', content: system }, ...messages]
  const images = countImages(providerMessages)
  const estimatedInputTokens = estimateInputTokens(providerMessages, images)
  return {
    messages: providerMessages,
    ...turnParams(input.task),
    estimatedInputTokens,
    inputBudget: GATEWAY_LIMITS.inputTokens,
  }
}

/** Shared client/server estimate includes message framing and a fixed reserve
 * per image in addition to the deliberately conservative text heuristic. */
export function estimateInputTokens(messages: ApiMessage[], imageCount = countImages(messages)): number {
  const rendered = messages.map((message) => message.role + '\n' + textContent(message.content)).join('\n')
  return estimateTextTokens(rendered) + messages.length * 8 + imageCount * GATEWAY_LIMITS.imageTokenEstimate
}

export function gatewayFingerprint(input: GatewayGenerationInput, prepared: PreparedGatewayGeneration): string {
  return JSON.stringify({
    task: input.task,
    answerLanguage: input.answerLanguage,
    uiLanguage: input.uiLanguage,
    titleNeeded: input.titleNeeded,
    ...(input.taskInput !== undefined ? { taskInput: input.taskInput.trim() } : {}),
    messages: prepared.messages,
    temperature: prepared.temperature,
    maxTokens: prepared.maxTokens,
  })
}

function withCanonicalText(content: ApiContent, text: string): ApiContent {
  if (typeof content === 'string') return text
  const images = content.flatMap((part) => part.type === 'image_url'
    ? [{ type: 'image_url' as const, image_url: { url: part.image_url.url } }]
    : [])
  return images.length ? [{ type: 'text', text }, ...images] : text
}

function cloneMessage(message: ApiMessage): ApiMessage {
  if (typeof message.content === 'string') return { role: message.role, content: message.content }
  return {
    role: message.role,
    content: message.content.map((part) => part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image_url' as const, image_url: { url: part.image_url.url } }),
  }
}

function textContent(content: ApiContent): string {
  return typeof content === 'string'
    ? content
    : content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

function countImages(messages: ApiMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    count += message.content.filter((part) => part.type === 'image_url').length
  }
  return count
}
