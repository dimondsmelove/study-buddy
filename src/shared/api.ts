// HTTP client for OpenAI-compatible chat-completions endpoints (OpenRouter by
// preset, any custom base URL). Requests always go out with stream:true: a
// compliant server answers with an SSE event stream, one that ignores the
// flag answers with a single JSON completion — both shapes are parsed here
// (Content-Type tells them apart).
//
// Every failure path throws an Error whose message is written for the user
// (the chat UI renders it verbatim): no raw HTTP lines, no stack text. Known
// statuses (bad key, no credits, rate limit) get a short human lead; the
// endpoint's own error message is appended when present.

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
    case 'network':
    case 'rate':
    case 'interrupted':
    case 'response':
      return true
    case 'http':
      return err.status === 404 || (err.status ?? 0) >= 500
    default:
      return false // auth, credits, aborted — another model cannot fix these
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
  // The standard error envelope is { error: { message } }; anything else
  // (an HTML error page, an empty body) simply carries no detail to append.
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: unknown } } | null
    const msg = body?.error?.message
    if (typeof msg === 'string' && msg) detail = msg
  } catch {
    // Not JSON — the generic message below stands on its own.
  }
  const say = (lead: string): string => (detail ? `${lead} (${detail})` : lead)
  switch (res.status) {
    case 401: return new ApiError(say('Invalid API key.'), 'auth', 401)
    case 402: return new ApiError(say('Insufficient credits on this account.'), 'credits', 402)
    case 429: return new ApiError(say('Rate limited — try again shortly.'), 'rate', 429)
    default:
      return new ApiError(
        `The API returned HTTP ${res.status}: ${detail || res.statusText || 'unknown reason'}`,
        'http',
        res.status,
      )
  }
}

/** fetch() rejects with:
 *  - TypeError  → the request never happened (offline, DNS, CORS block) —
 *                 from the user's seat that is "the URL can't be reached";
 *  - AbortError → the caller cancelled; rethrown as a plain Error marked
 *                 'Cancelled.' so callers can branch on the message. */
export function apiNetworkError(err: unknown, baseUrl: string): ApiError {
  if (isAbort(err)) return new ApiError('Cancelled.', 'aborted')
  return new ApiError(`Could not reach ${baseUrl} (network blocked or wrong URL).`, 'network')
}

// Aborts surface as a DOMException named 'AbortError'; a DOMException IS an
// Error in Chromium, but matching by name keeps quirky engines covered too.
function isAbort(err: unknown): boolean {
  return (err instanceof Error || err instanceof DOMException) && err.name === 'AbortError'
}

/** One chat completion. Returns the full text. Throws Error with a HUMAN
 *  message (never a raw HTTP line) on failure. */
export async function chatCompletion(opts: ChatCompletionOpts): Promise<string> {
  const { settings, model, messages, signal, onDelta, temperature, maxTokens } = opts
  // A user error, thrown BEFORE any network call: a request without a model
  // id can only fail, so it must not even be attempted.
  if (!model) throw new ApiError('Choose a model first.', 'response')

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
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      }),
      signal,
    })
  } catch (err) {
    throw apiNetworkError(err, settings.baseUrl)
  }
  if (!res.ok) throw await apiHttpError(res)

  // Content-Type is the only honest discriminator between the two answer
  // shapes: event-stream means a live stream, anything JSON-shaped means the
  // server ignored stream:true and answered in one piece.
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) return streamSSE(res, onDelta)
  return wholeJson(res, onDelta)
}

// Consume an SSE body. Parsing is buffered by NEWLINE, never by chunk: a
// chunk boundary is whatever the socket delivered — one chunk can hold
// several `data:` lines, or cut one in half. OpenAI-compatible servers only
// ever use single-line `data:` payloads, so newline-splitting is all the SSE
// machinery needed here (no multi-line events, no `event:`/`id:` fields).
async function streamSSE(res: Response, onDelta?: (delta: string) => void): Promise<string> {
  if (!res.body) throw new ApiError('The API returned an empty stream.', 'response')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        text += sseDelta(buffer.slice(0, nl), onDelta)
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    }
    // A well-formed final line may arrive without its trailing newline.
    buffer += decoder.decode()
    text += sseDelta(buffer, onDelta)
  } catch (err) {
    if (isAbort(err)) throw new ApiError('Cancelled.', 'aborted')
    // A connection that breaks mid-stream is neither "could not reach" (the
    // request went out) nor a raw TypeError worth showing.
    throw new ApiError('The API connection was interrupted.', 'interrupted')
  } finally {
    // Release the socket even on early throws — an abandoned reader keeps the
    // connection open until GC; cancel() never has a useful throw here.
    void reader.cancel().catch(() => {})
  }
  return text
}

// One already-newline-split SSE line → the text it carries. `data:` JSON
// frames yield `choices[0].delta.content`; blank lines, `:`-comments and
// unknown fields yield ''. `[DONE]` is the stream-end sentinel, not JSON. A
// malformed frame is skipped, not fatal — one bad line must not kill a
// completion that already streamed half its answer.
function sseDelta(line: string, onDelta?: (delta: string) => void): string {
  if (!line.startsWith('data:')) return ''
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return ''
  try {
    const evt = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }
    const delta = evt.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) {
      onDelta?.(delta)
      return delta
    }
    // Absent / null content (role-only frames) contributes nothing.
  } catch {
    // Malformed frame — skipped above, the stream stays alive.
  }
  return ''
}

// Fallback for a server that ignored stream:true and answered with one JSON
// completion. message.content is a string or an array of typed parts; only
// the text parts are prose. The whole text goes out as ONE delta — the
// incremental onDelta contract is degenerate here by definition.
async function wholeJson(res: Response, onDelta?: (delta: string) => void): Promise<string> {
  let body: { choices?: Array<{ message?: { content?: unknown } }> } | null
  try {
    body = await res.json()
  } catch (err) {
    if (isAbort(err)) throw new ApiError('Cancelled.', 'aborted')
    throw new ApiError('The API response was not valid JSON.', 'response')
  }
  const text = flattenContent(body?.choices?.[0]?.message?.content)
  if (text === null) throw new ApiError('The API response had no message content.', 'response')
  onDelta?.(text)
  return text
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
