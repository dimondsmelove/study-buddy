import type { ApiContent, ApiMessage } from './api'
import type { AnswerLanguage } from './settings'
import { firstAnswerTitleInstruction, simplerPrompt, systemPrompt, taskPrompt, turnParams, type TurnKind } from './prompts'

export const GATEWAY_LIMITS = {
  inputTokens: 100_000,
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

/** Client-supplied intent, selected local context and explicit user input.
 * Model parameters are reconstructed on the server from allowlisted fields. */
export interface GatewayGenerationInput {
  requestId: string
  task: TurnKind
  answerLanguage: AnswerLanguage
  browserLanguage: string
  uiLanguage: GatewayUiLanguage
  titleNeeded: boolean
  taskInput?: string
  selectedAnswerText?: string
  messages: ApiMessage[]
}

export interface PreparedGatewayGeneration {
  messages: ApiMessage[]
  maxTokens: number
  estimatedInputTokens: number
  inputBudget: number
}

/** Approximate text budget: one token per four UTF-8 bytes.
 * This is not a model tokenizer or a guarantee of provider limits. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / 4)
}

const ANSWER_LANGUAGES: readonly AnswerLanguage[] = [
  'auto', 'en', 'de', 'fr', 'es', 'it', 'nl', 'sv', 'da', 'no', 'fi', 'ar', 'id', 'ru', 'pt', 'ja', 'fil', 'vi', 'tr', 'th', 'ko',
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

/** Build the canonical provider request from validated intent and selected history. */
export function prepareGatewayGeneration(input: GatewayGenerationInput): PreparedGatewayGeneration {
  const last = input.messages.at(-1)
  if (!last || last.role !== 'user') throw new Error('gateway.currentUserRequired')

  let currentText = ''
  const promptContext = { answerLanguage: input.answerLanguage, browserLanguage: input.browserLanguage, uiLang: input.uiLanguage }
  if (input.task === 'ask') {
    if (typeof input.taskInput !== 'string' || !input.taskInput.trim()) throw new Error('gateway.askInputRequired')
    currentText = input.taskInput
  } else if (input.task === 'simpler') {
    if (typeof input.selectedAnswerText !== 'string' || !input.selectedAnswerText.trim()) throw new Error('gateway.simplerAnswerRequired')
    currentText = simplerPrompt(promptContext).replace('{{selected_answer_text}}', () => input.selectedAnswerText!)
  } else {
    currentText = taskPrompt(input.task, promptContext)
    if (input.task === 'check' && input.taskInput !== undefined) currentText += '\n\n' + input.taskInput
  }

  const system = [systemPrompt(promptContext), ...(input.titleNeeded ? [firstAnswerTitleInstruction(promptContext)] : [])].join('\n\n')
  const messages = [{ role: 'system' as const, content: system }, ...input.messages.map((message, index) => {
    if (index !== input.messages.length - 1) return cloneMessage(message)
    return { role: 'user' as const, content: withCanonicalText(last.content, currentText) }
  })].filter(hasContent)
  const images = countImages(messages)
  const estimatedInputTokens = estimateInputTokens(messages, images)
  return {
    messages,
    ...turnParams(input.task),
    estimatedInputTokens,
    inputBudget: GATEWAY_LIMITS.inputTokens,
  }
}

/** Shared client/server estimate includes message framing and a fixed reserve
 * per image in addition to the approximate UTF-8 text estimate. */
/** Exact UTF-8 size of the JSON request body sent by the browser gateway client. */
export function gatewayRequestBytes(input: GatewayGenerationInput): number {
  return new TextEncoder().encode(JSON.stringify(input)).byteLength
}

export function estimateInputTokens(messages: ApiMessage[], imageCount = countImages(messages)): number {
  const rendered = messages.map((message) => message.role + '\n' + textContent(message.content)).join('\n')
  return estimateTextTokens(rendered) + messages.length * 8 + imageCount * GATEWAY_LIMITS.imageTokenEstimate
}

export function gatewayFingerprint(input: GatewayGenerationInput, prepared: PreparedGatewayGeneration): string {
  return JSON.stringify({
    task: input.task,
    answerLanguage: input.answerLanguage,
    browserLanguage: input.browserLanguage,
    selectedAnswerText: input.selectedAnswerText,
    uiLanguage: input.uiLanguage,
    titleNeeded: input.titleNeeded,
    messages: prepared.messages,
    maxTokens: prepared.maxTokens,
  })
}

function withCanonicalText(content: ApiContent, text: string): ApiContent {
  if (typeof content === 'string') return text
  const parts: Exclude<ApiContent, string> = []
  if (text) parts.push({ type: 'text', text })
  parts.push(...content.flatMap((part) => part.type === 'image_url'
    ? [{ type: 'image_url' as const, image_url: { url: part.image_url.url } }]
    : []))
  return parts.length ? parts : ''
}

function hasContent(message: ApiMessage): boolean {
  return typeof message.content === 'string'
    ? message.content.length > 0
    : message.content.some((part) => part.type === 'image_url' || part.text.length > 0)
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
