// HTTP client for OpenAI-compatible chat-completions endpoints (OpenRouter by
// preset, any custom base URL). Requests always go out with stream:true: a
// compliant server answers with an SSE event stream, one that ignores the
// flag answers with a single JSON completion — both shapes are parsed here
// (Content-Type tells them apart).
//
// Every failure path throws an Error whose message is written for the user
// (the chat UI renders it verbatim): no raw HTTP lines, no stack text. Known
// statuses (bad key, no credits, rate limit) get a short actionable message.
// Provider details and URLs are untrusted and must never reach that message.

import type { Settings } from './settings'

/** Error kinds a caller can branch on without parsing prose. */
export type ApiErrorKind =
  | 'auth'
  | 'credits'
  | 'rate'
  | 'http'
  | 'network'
  | 'interrupted'
  | 'aborted'
  | 'response'
  | 'provider'

/** Transport completion is distinct from the text already shown by onDelta. */
export interface CompletionResult {
  text: string
  status: 'complete' | 'truncated' | 'interrupted' | 'empty'
  finishReason?: string
  model?: string
  usage?: { promptTokens?: number; completionTokens?: number; cost?: number }
}

/** Every failure from this module is an ApiError. `message` is written for the
 *  user; `kind`/`status` exist so the model-fallback layer (ai.ts) can decide
 *  whether retrying against another model could possibly help. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** True when the SAME request against a different model could plausibly
 *  succeed: the model/provider is unavailable, not our key or credits. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  switch (err.kind) {
    case 'rate':
      return err.status === 429
    case 'http':
      return err.status === 404 || ((err.status ?? 0) >= 500 && (err.status ?? 0) < 600)
    default:
      return false // Ambiguous failures must not silently start another answer.
  }
}

/** OpenAI-compatible message part / message. */
export type ApiContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant'
  content: ApiContent
}

export interface ChatCompletionOpts {
  settings: Settings
  /** Model id for THIS request; the caller owns the fallback chain (ai.ts). */
  model: string
  messages: ApiMessage[]
  /** Sampling temperature (0 = deterministic; factual tasks). */
  temperature?: number
  /** Hard token cutoff for the answer (a cap, not a length target). */
  maxTokens?: number
  /** Aborts the request (fetch signal). */
  signal?: AbortSignal
  /** Streaming callback: each text delta as it arrives. */
  onDelta?: (delta: string) => void
}

/** Authorization header shared by /models (models.ts) and /chat/completions. */
export function authHeaders(settings: Settings): Record<string, string> {
  return { Authorization: `Bearer ${settings.apiKey}` }
}

/** Human error for a non-ok response. Exported because models.ts must phrase
 *  endpoint failures exactly the same — one voice for every API error. The
 *  kind/status ride along for the fallback layer without changing the prose. */
export async function apiHttpError(res: Response): Promise<ApiError> {
  // Do not read provider prose: it can echo credentials, request text or URLs.
  switch (res.status) {
    case 401: return new ApiError('Invalid API key.', 'auth', 401)
    case 402: return new ApiError('Insufficient credits on this account.', 'credits', 402)
    case 403: return new ApiError('Access denied. Check this account’s API permissions.', 'auth', 403)
    case 404: return new ApiError('The requested API endpoint or model is unavailable.', 'http', 404)
    case 429: return new ApiError('Rate limited — try again shortly.', 'rate', 429)
    default:
      return new ApiError(
        `The API returned HTTP ${res.status}. Try again or check the endpoint settings.`,
        'http',
        res.status,
      )
  }
}

/** fetch() rejects with:
 *  - TypeError  → the request never happened (offline, DNS, CORS block) —
 *                 from the user's seat that is "the URL can't be reached";
 *  - AbortError → the caller cancelled; callers branch on kind 'aborted'. */
export function apiNetworkError(err: unknown): ApiError {
  if (isAbort(err)) return new ApiError('Cancelled.', 'aborted')
  return new ApiError('Could not reach the API. Check the connection and endpoint settings.', 'network')
}

// Aborts surface as a DOMException named 'AbortError'; a DOMException IS an
// Error in Chromium, but matching by name keeps quirky engines covered too.
function isAbort(err: unknown): boolean {
  return (err instanceof Error || err instanceof DOMException) && err.name === 'AbortError'
}

/** One completion, retaining text even when a stream ends without a terminal
 *  event. Transport, cancellation and provider failures throw typed ApiError. */
export async function chatCompletion(opts: ChatCompletionOpts): Promise<CompletionResult> {
  const { settings, model, messages, signal, onDelta, temperature, maxTokens } = opts
  // A user error, thrown BEFORE any network call: a request without a model
  // id can only fail, so it must not even be attempted.
  if (!model) throw new ApiError('Choose a model first.', 'response')
  if (signal?.aborted) throw new ApiError('Cancelled.', 'aborted')

  let res: Response
  try {
    res = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      // X-Title is OpenRouter's attribution header — required there, harmless
      // elsewhere (servers without OpenRouter semantics ignore unknown headers).
      headers: { ...authHeaders(settings), 'Content-Type': 'application/json', 'X-Title': 'Study Buddy' },
      // temperature/max_tokens travel only when set: providers' defaults stay
      // defaults otherwise (and some reject unknown/unsupported fields).
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw new ApiError('Cancelled.', 'aborted')
    throw apiNetworkError(err)
  }
  if (!res.ok) throw await apiHttpError(res)

  // Content-Type is the only honest discriminator between the two answer
  // shapes: event-stream means a live stream, anything JSON-shaped means the
  // server ignored stream:true and answered in one piece.
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.toLowerCase().includes('text/event-stream')) {
    const result = await streamSSE(res, onDelta, signal)
    return { ...result, model: result.model ?? model }
  }
  const result = await wholeJson(res, onDelta, signal)
  return { ...result, model: result.model ?? model }
}

// SSE events are separated by blank lines. Buffer both UTF-8 and lines: a
// socket chunk can split a character, CRLF, JSON value or multi-line event.
async function streamSSE(
  res: Response,
  onDelta?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  if (!res.body) throw new ApiError('The API returned an empty stream.', 'response')
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let text = ''
  let data: string[] = []
  let event = ''
  let done = false
  let malformed = false
  let finishReason: string | undefined
  let usage: CompletionResult['usage']
  let reportedModel: string | undefined

  const dispatch = (): void => {
    const payload = data.join('\n').trim()
    const eventType = event
    data = []
    event = ''
    if (eventType === 'error') throw providerError()
    if (!payload) return
    if (payload === '[DONE]') {
      done = true
      return
    }
    let body: CompletionBody | null
    try {
      body = JSON.parse(payload) as CompletionBody | null
    } catch {
      malformed = true
      return
    }
    if (!body || typeof body !== 'object') {
      malformed = true
      return
    }
    if (body.error !== undefined && body.error !== null) throw providerError()
    usage = readUsage(body.usage) ?? usage
    if (typeof body.model === 'string') reportedModel = body.model
    if (!Array.isArray(body.choices)) {
      malformed = true
      return
    }
    // Empty choices are permitted for the final usage-only event.
    if (!body.choices.length) return
    const choice = body.choices[0]
    if (!choice || typeof choice !== 'object') {
      malformed = true
      return
    }
    if ((choice.delta !== undefined && (!choice.delta || typeof choice.delta !== 'object' || Array.isArray(choice.delta))) ||
        (choice.delta === undefined && choice.finish_reason == null)) malformed = true
    const delta = choice.delta?.content
    if (delta !== undefined && delta !== null && typeof delta !== 'string') malformed = true
    if (typeof delta === 'string' && delta) {
      if (finishReason !== undefined) malformed = true
      text += delta
      onDelta?.(delta)
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== 'string') malformed = true
      else {
        finishReason = choice.finish_reason
        if (finishReason === 'error' || finishReason === 'content_filter') throw providerError()
      }
    }
  }
  const line = (value: string): void => {
    if (!value) return dispatch()
    if (value.startsWith(':')) return
    const colon = value.indexOf(':')
    const field = colon === -1 ? value : value.slice(0, colon)
    let valueText = colon === -1 ? '' : value.slice(colon + 1)
    if (valueText.startsWith(' ')) valueText = valueText.slice(1)
    if (field === 'data') data.push(valueText)
    if (field === 'event') event = valueText
  }
  const drain = (eof = false): void => {
    while (!done) {
      const nl = buffer.search(/[\r\n]/)
      if (nl === -1 || (!eof && buffer[nl] === '\r' && nl === buffer.length - 1)) break
      const width = buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1
      const value = buffer.slice(0, nl)
      buffer = buffer.slice(nl + width)
      line(value)
    }
    if (eof && !done) {
      if (buffer) line(buffer)
      buffer = ''
      dispatch()
    }
  }
  try {
    while (!done) {
      if (signal?.aborted) throw new ApiError('Cancelled.', 'aborted')
      const { done, value } = await reader.read()
      if (signal?.aborted) throw new ApiError('Cancelled.', 'aborted')
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      drain()
    }
    buffer += decoder.decode()
    drain(true)
    if (signal?.aborted) throw new ApiError('Cancelled.', 'aborted')
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (isAbort(err) || signal?.aborted) throw new ApiError('Cancelled.', 'aborted')
    // A connection that breaks mid-stream is neither "could not reach" (the
    // request went out) nor a raw TypeError worth showing.
    throw new ApiError('The API connection was interrupted.', 'interrupted')
  } finally {
    // Release the socket even on early throws — an abandoned reader keeps the
    // connection open until GC; cancel() never has a useful throw here.
    void reader.cancel().catch(() => {})
  }
  return { ...completionResult(text, finishReason, done, malformed), ...(reportedModel ? { model: reportedModel } : {}), ...(usage ? { usage } : {}) }
}

interface CompletionBody {
  error?: unknown
  model?: unknown
  usage?: unknown
  choices?: Array<{
    delta?: { content?: unknown }
    message?: { content?: unknown }
    finish_reason?: unknown
  }>
}

function readUsage(value: unknown): CompletionResult['usage'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  const promptTokens = typeof usage.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : undefined
  const completionTokens = typeof usage.completion_tokens === 'number' && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : undefined
  const cost = typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : undefined
  if (promptTokens === undefined && completionTokens === undefined && cost === undefined) return undefined
  return { promptTokens, completionTokens, cost }
}

function providerError(): ApiError {
  return new ApiError('The provider could not complete the response. Try again.', 'provider')
}

function completionResult(
  text: string,
  finishReason?: string,
  done = false,
  malformed = false,
): CompletionResult {
  let status: CompletionResult['status'] = 'interrupted'
  if (!malformed) {
    if (finishReason === 'length') status = 'truncated'
    else if (finishReason === 'stop' || (done && finishReason === undefined)) status = text ? 'complete' : 'empty'
  }
  return { text, status, ...(finishReason !== undefined ? { finishReason } : {}) }
}

// Fallback for a server that ignored stream:true and answered with one JSON
// completion. message.content is a string or an array of typed parts; only
// the text parts are prose. The whole text goes out as ONE delta — the
// incremental onDelta contract is degenerate here by definition.
async function wholeJson(
  res: Response,
  onDelta?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  let body: CompletionBody | null
  try {
    if (signal?.aborted) throw new ApiError('Cancelled.', 'aborted')
    body = await res.json()
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (isAbort(err) || signal?.aborted) throw new ApiError('Cancelled.', 'aborted')
    throw new ApiError('The API response was not valid JSON.', 'response')
  }
  if (signal?.aborted) throw new ApiError('Cancelled.', 'aborted')
  if (body?.error !== undefined && body.error !== null) throw providerError()
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined
  const content = choice?.message?.content
  const text = content === null ? '' : flattenContent(content)
  if (text) onDelta?.(text)
  if (signal?.aborted) throw new ApiError('Cancelled.', 'aborted')
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined
  if (finishReason === 'error' || finishReason === 'content_filter') throw providerError()
  if (text === null) throw new ApiError('The API response had no message content.', 'response')
  const usage = readUsage(body?.usage)
  return { ...completionResult(text, finishReason), ...(typeof body?.model === 'string' ? { model: body.model } : {}), ...(usage ? { usage } : {}) }
}

// Content arrives as a string, or as an array of typed parts — the same shape
// ApiContent accepts for requests. Only `{ type: 'text' }` parts are prose;
// null means "no content at all", distinct from '' (an empty reply).
function flattenContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let out = ''
    for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
      if (part && part.type === 'text' && typeof part.text === 'string') out += part.text
    }
    return out
  }
  return null
}
