// The browser talks only to the Study Buddy backend. Provider credentials,
// model selection and canonical prompts stay on the server.

import type { CompletionResult } from './api'
import { GATEWAY_URL } from './config'
import type { GatewayGenerationInput } from './gateway-protocol'
import { t } from './i18n'
import type { UiLang } from './i18n'

export const GATEWAY_SESSION_KEY = 'gateway.session'
export const GATEWAY_INSTALLATION_KEY = 'gateway.installation'
const RENEW_BEFORE_MS = 2 * 24 * 60 * 60 * 1_000

export interface AskRequest extends GatewayGenerationInput {
  signal?: AbortSignal
  onDelta?: (delta: string) => void
  onFallback?: (from: string, to: string) => void
  onContext?: (value: { estimatedInputTokens: number; inputBudget: number; estimateHeadroom: number }) => void
}

export interface Gateway {
  ask(request: AskRequest): Promise<CompletionResult>
}

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    readonly kind: 'unavailable' | 'session' | 'rate' | 'context' | 'uncertain' | 'provider' | 'cancelled' | 'request',
    readonly retryAfter?: number,
    readonly partial = false,
    readonly resetAt?: number,
  ) {
    super(code)
    this.name = 'GatewayError'
  }
}

interface StoredSession {
  token: string
  expiresAt: number
  gatewayOrigin: string
}

interface StoredInstallation {
  installationId: string
  installationSecret: string
  gatewayOrigin: string
}

type SessionResponse = Omit<StoredSession, 'gatewayOrigin'>
type InstallationResponse = Omit<StoredInstallation, 'gatewayOrigin'>

export function createGateway(): Gateway {
  return { ask: askGateway }
}

async function askGateway(request: AskRequest): Promise<CompletionResult> {
  const session = await ensureSession(request.signal)
  let response: Response
  try {
    response = await fetch(`${GATEWAY_URL}/api/v1/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requestId: request.requestId,
        task: request.task,
        answerLanguage: request.answerLanguage,
        browserLanguage: request.browserLanguage,
        uiLanguage: request.uiLanguage,
        titleNeeded: request.titleNeeded,
        ...(request.taskInput !== undefined ? { taskInput: request.taskInput } : {}),
        ...(request.selectedAnswerText !== undefined ? { selectedAnswerText: request.selectedAnswerText } : {}),
        messages: request.messages,
      }),
      signal: request.signal,
    })
  } catch (error) {
    if (request.signal?.aborted || isAbort(error)) throw new GatewayError('generation.cancelled', 'cancelled')
    // Once the generation POST was attempted, the backend may have admitted it.
    throw new GatewayError('gateway.uncertain', 'uncertain')
  }

  if (!response.ok) {
    const error = await responseError(response)
    if (response.status === 401 && error.code === 'session.invalid') await clearSessionIfCurrent(session.token)
    throw error
  }
  if (!response.body) throw new GatewayError('gateway.uncertain', 'uncertain')
  return readGenerationStream(response.body, request)
}

let ensuringSession: Promise<StoredSession> | undefined

async function ensureSession(signal?: AbortSignal): Promise<StoredSession> {
  if (ensuringSession) return ensuringSession
  const run = () => ensureSessionOnce(signal)
  const coordinated = typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request('study-buddy-session', async () => await run())
    : run()
  ensuringSession = Promise.resolve(coordinated).finally(() => { ensuringSession = undefined })
  return ensuringSession
}

async function ensureSessionOnce(signal?: AbortSignal): Promise<StoredSession> {
  let values: Record<string, unknown>
  try {
    values = await chrome.storage.local.get([GATEWAY_SESSION_KEY, GATEWAY_INSTALLATION_KEY])
  } catch {
    throw new GatewayError('gateway.storage', 'unavailable')
  }
  const storedSession = values[GATEWAY_SESSION_KEY]
  const storedInstallation = values[GATEWAY_INSTALLATION_KEY]
  const session = readStoredSession(storedSession)
  const parsedInstallation = storedInstallation === undefined ? undefined : readInstallationBody(storedInstallation)
  const storedOrigin = asRecord(storedInstallation)?.gatewayOrigin
  if (storedInstallation !== undefined && (!parsedInstallation || typeof storedOrigin !== 'string')) {
    throw new GatewayError('installation.invalid', 'session')
  }
  const installation = storedOrigin === new URL(GATEWAY_URL).origin && parsedInstallation
    ? bindInstallationToGateway(parsedInstallation)
    : undefined

  if (session && session.expiresAt > Date.now() + RENEW_BEFORE_MS) {
    if (installation) return session
    const claimed = await claimInstallation(session, signal)
    await storeInstallation(claimed.installation)
    return claimed.session
  }

  if (session) {
    const renewed = await renewSession(session, signal)
    if (renewed) {
      if (installation) return renewed
      const claimed = await claimInstallation(renewed, signal)
      await storeInstallation(claimed.installation)
      return claimed.session
    }
  }

  if (installation) return recoverInstallation(installation, signal)
  const issued = await issueSession(signal)
  await storeInstallation(issued.installation)
  await storeSession(issued.session)
  return issued.session
}

async function renewSession(session: StoredSession, signal?: AbortSignal): Promise<StoredSession | undefined> {
  let response: Response
  try {
    response = await fetch(`${GATEWAY_URL}/api/v1/session/renew`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      signal,
    })
  } catch (error) {
    if (signal?.aborted || isAbort(error)) throw new GatewayError('generation.cancelled', 'cancelled')
    throw new GatewayError('gateway.unavailable', 'unavailable')
  }
  if (response.status === 401) {
    await clearSessionIfCurrent(session.token)
    return undefined
  }
  if (!response.ok) throw await responseError(response, 'gateway.unavailable')
  const body = await readJson(response)
  const renewed = readSessionBody(body)
  if (!renewed || renewed.token !== session.token) throw new GatewayError('gateway.session', 'session')
  const bound = bindSessionToGateway(renewed)
  await storeSession(bound)
  return bound
}

async function issueSession(signal?: AbortSignal): Promise<{ session: StoredSession; installation: StoredInstallation }> {
  let response: Response
  try {
    response = await fetch(`${GATEWAY_URL}/api/v1/session`, { method: 'POST', signal })
  } catch (error) {
    if (signal?.aborted || isAbort(error)) throw new GatewayError('generation.cancelled', 'cancelled')
    throw new GatewayError('gateway.unavailable', 'unavailable')
  }
  if (!response.ok) throw await responseError(response, 'gateway.unavailable')
  const body = await readJson(response)
  const session = readSessionBody(body)
  const installation = readInstallationBody(body)
  if (!session || !installation) throw new GatewayError('gateway.session', 'session')
  return {
    session: bindSessionToGateway(session),
    installation: bindInstallationToGateway(installation),
  }
}

async function claimInstallation(session: StoredSession, signal?: AbortSignal): Promise<{ session: StoredSession; installation: StoredInstallation }> {
  let response: Response
  try {
    response = await fetch(`${GATEWAY_URL}/api/v1/session/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      signal,
    })
  } catch (error) {
    if (signal?.aborted || isAbort(error)) throw new GatewayError('generation.cancelled', 'cancelled')
    throw new GatewayError('gateway.unavailable', 'unavailable')
  }
  if (!response.ok) throw await responseError(response, 'gateway.unavailable')
  const body = await readJson(response)
  const result = readSessionBody(body)
  const installation = readInstallationBody(body)
  if (!result || result.token !== session.token || !installation) throw new GatewayError('gateway.session', 'session')
  const updated = bindSessionToGateway(result)
  await storeSession(updated)
  return { session: updated, installation: bindInstallationToGateway(installation) }
}

async function recoverInstallation(installation: StoredInstallation, signal?: AbortSignal): Promise<StoredSession> {
  let response: Response
  try {
    response = await fetch(`${GATEWAY_URL}/api/v1/session/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: installation.installationId, installationSecret: installation.installationSecret }),
      signal,
    })
  } catch (error) {
    if (signal?.aborted || isAbort(error)) throw new GatewayError('generation.cancelled', 'cancelled')
    throw new GatewayError('gateway.unavailable', 'unavailable')
  }
  if (response.status === 401) throw new GatewayError('installation.invalid', 'session')
  if (!response.ok) throw await responseError(response, 'gateway.unavailable')
  const session = readSessionBody(await readJson(response))
  if (!session) throw new GatewayError('gateway.session', 'session')
  const bound = bindSessionToGateway(session)
  await storeSession(bound)
  return bound
}

async function storeSession(session: StoredSession): Promise<void> {
  try { await chrome.storage.local.set({ [GATEWAY_SESSION_KEY]: session }) }
  catch { throw new GatewayError('gateway.storage', 'unavailable') }
}

async function storeInstallation(installation: StoredInstallation): Promise<void> {
  try { await chrome.storage.local.set({ [GATEWAY_INSTALLATION_KEY]: installation }) }
  catch { throw new GatewayError('gateway.storage', 'unavailable') }
}

async function clearSessionIfCurrent(token: string): Promise<void> {
  try {
    const current = readStoredSession((await chrome.storage.local.get(GATEWAY_SESSION_KEY))[GATEWAY_SESSION_KEY])
    if (current?.token === token) await chrome.storage.local.remove(GATEWAY_SESSION_KEY)
  } catch {
    // The response still remains explicit; a later request can renew or issue.
  }
}

async function responseError(response: Response, defaultCode = 'gateway.error'): Promise<GatewayError> {
  let body: unknown
  try { body = await response.json() } catch { body = undefined }
  const root = asRecord(body)
  const error = asRecord(root?.error)
  const code = typeof error?.code === 'string' ? error.code : defaultCode
  const resetAt = typeof error?.resetAt === 'number' && Number.isFinite(error.resetAt) ? error.resetAt : undefined
  const retryHeader = Number(response.headers.get('Retry-After'))
  const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined
  if (code === 'session.invalid') return new GatewayError(code, 'session')
  if (code === 'budget.accounting_review') return new GatewayError(code, 'provider')
  if (code === 'session.rate_limited') return new GatewayError(code, 'rate', retryAfter, false, resetAt)
  if (code === 'budget.exhausted' || code === 'budget.service_exhausted') return new GatewayError(code, 'rate', undefined, false, resetAt)
  if (code === 'generation.cooldown' || code === 'generation.capacity' || code === 'generation.in_progress') {
    return new GatewayError(code, 'rate', retryAfter)
  }
  if (code === 'context.too_large' || code === 'provider.context_too_large') return new GatewayError(code, 'context')
  if (response.status >= 500 || response.status === 408 || response.status === 425) {
    return new GatewayError('gateway.uncertain', 'uncertain')
  }
  return new GatewayError(code, response.status === 429 ? 'rate' : 'request', retryAfter)
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json() }
  catch { throw new GatewayError('gateway.response', 'unavailable') }
}

function readSessionBody(value: unknown): SessionResponse | undefined {
  const body = asRecord(value)
  const token = body?.token
  const expiresAt = body?.expiresAt
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token) ||
      typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined
  return { token, expiresAt }
}

function bindSessionToGateway(session: SessionResponse): StoredSession {
  return { ...session, gatewayOrigin: new URL(GATEWAY_URL).origin }
}

function readInstallationBody(value: unknown): InstallationResponse | undefined {
  const body = asRecord(value)
  const installationId = body?.installationId
  const installationSecret = body?.installationSecret
  if (typeof installationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(installationId) ||
      typeof installationSecret !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(installationSecret)) return undefined
  return { installationId, installationSecret }
}

function bindInstallationToGateway(installation: InstallationResponse): StoredInstallation {
  return { ...installation, gatewayOrigin: new URL(GATEWAY_URL).origin }
}


function readStoredSession(value: unknown): StoredSession | undefined {
  const session = readSessionBody(value)
  const gatewayOrigin = asRecord(value)?.gatewayOrigin
  if (!session || gatewayOrigin !== new URL(GATEWAY_URL).origin) return undefined
  return { ...session, gatewayOrigin }
}

export async function readGenerationStream(stream: ReadableStream<Uint8Array>, request: AskRequest): Promise<CompletionResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let event = ''
  let data: string[] = []
  let text = ''
  let terminal: CompletionResult | undefined
  let failed: GatewayError | undefined

  const dispatch = (): void => {
    const payload = data.join('\n').trim()
    const name = event
    event = ''
    data = []
    if (!payload) return
    if (terminal || failed) return
    let value: unknown
    try { value = JSON.parse(payload) }
    catch { throw new GatewayError('gateway.response', 'uncertain', undefined, text.length > 0) }
    const body = asRecord(value)
    if (!body) throw new GatewayError('gateway.response', 'uncertain', undefined, text.length > 0)
    if (name === 'delta') {
      if (typeof body.text !== 'string') throw new GatewayError('gateway.response', 'uncertain', undefined, text.length > 0)
      text += body.text
      request.onDelta?.(body.text)
    } else if (name === 'fallback') {
      if (typeof body.from === 'string' && typeof body.to === 'string') request.onFallback?.(body.from, body.to)
    } else if (name === 'context') {
      if (typeof body.estimatedInputTokens !== 'number' || typeof body.inputBudget !== 'number' || typeof body.estimateHeadroom !== 'number') {
        throw new GatewayError('gateway.response', 'uncertain', undefined, text.length > 0)
      }
      request.onContext?.({
        estimatedInputTokens: body.estimatedInputTokens,
        inputBudget: body.inputBudget,
        estimateHeadroom: body.estimateHeadroom,
      })
    } else if (name === 'complete') {
      const status = body.status
      if (!['complete', 'truncated', 'interrupted', 'empty'].includes(String(status))) {
        throw new GatewayError('gateway.response', 'uncertain', undefined, text.length > 0)
      }
      const usage = asRecord(body.usage)
      terminal = {
        text,
        status: status as CompletionResult['status'],
        ...(typeof body.finishReason === 'string' ? { finishReason: body.finishReason } : {}),
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        ...(usage ? { usage: {
          ...(isNonNegative(usage.promptTokens) ? { promptTokens: usage.promptTokens } : {}),
          ...(isNonNegative(usage.completionTokens) ? { completionTokens: usage.completionTokens } : {}),
          ...(isNonNegative(usage.cost) ? { cost: usage.cost } : {}),
        } } : {}),
      }
    } else if (name === 'error') {
      failed = new GatewayError(
        typeof body.code === 'string' ? body.code : 'gateway.error',
        gatewayErrorKind(body.code),
        undefined,
        body.partial === true || text.length > 0,
      )
    }
  }

  const line = (value: string): void => {
    if (!value) return dispatch()
    if (value.startsWith(':')) return
    const colon = value.indexOf(':')
    const field = colon === -1 ? value : value.slice(0, colon)
    let content = colon === -1 ? '' : value.slice(colon + 1)
    if (content.startsWith(' ')) content = content.slice(1)
    if (field === 'event') event = content
    if (field === 'data') data.push(content)
  }
  const drain = (eof = false): void => {
    while (true) {
      const nl = buffer.search(/[\r\n]/)
      if (nl === -1 || (!eof && buffer[nl] === '\r' && nl === buffer.length - 1)) break
      const width = buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1
      const currentLine = buffer.slice(0, nl)
      buffer = buffer.slice(nl + width)
      line(currentLine)
    }
    if (eof) {
      if (buffer) line(buffer)
      buffer = ''
      dispatch()
    }
  }
  try {
    while (!terminal && !failed) {
      if (request.signal?.aborted) throw new GatewayError('generation.cancelled', 'cancelled', undefined, text.length > 0)
      const { done, value } = await reader.read()
      if (request.signal?.aborted) throw new GatewayError('generation.cancelled', 'cancelled', undefined, text.length > 0)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      drain()
    }
    buffer += decoder.decode()
    if (!terminal && !failed) drain(true)
  } catch (error) {
    if (error instanceof GatewayError) throw error
    if (request.signal?.aborted || isAbort(error)) throw new GatewayError('generation.cancelled', 'cancelled', undefined, text.length > 0)
    throw new GatewayError('gateway.uncertain', 'uncertain', undefined, text.length > 0)
  } finally {
    void reader.cancel().catch(() => {})
  }
  if (failed) throw failed
  if (!terminal) throw new GatewayError('gateway.uncertain', 'uncertain', undefined, text.length > 0)
  return terminal
}

export function gatewayErrorMessage(error: GatewayError, language: UiLang): string {
  const key = error.code === 'generation.timeout' ? 'err.gatewayTimeout'
    : error.code === 'budget.exhausted' ? 'err.gatewayBudget'
      : error.code === 'budget.service_exhausted' ? 'err.gatewayServiceBudget'
      : error.code === 'budget.accounting_review' ? 'err.gatewayAccountingReview'
          : error.code === 'session.rate_limited' ? 'err.gatewaySessionRate'
      : error.code === 'generation.cooldown' ? 'err.gatewayRate'
        : error.code === 'generation.capacity' || error.code === 'generation.in_progress' ? 'err.gatewayBusy'
          : error.code === 'generation.request_id_conflict' || error.code === 'generation.already_started' ? 'err.gatewayDuplicate'
            : error.kind === 'context' ? 'err.gatewayContext'
              : error.kind === 'session' ? 'err.gatewaySession'
                : error.kind === 'uncertain' ? 'err.gatewayUncertain'
                  : error.kind === 'unavailable' ? (error.code === 'gateway.storage' ? 'err.gatewayStorage' : 'err.gatewayUnavailable')
                    : error.kind === 'rate' ? 'err.gatewayRate'
                      : error.kind === 'cancelled' ? 'err.gatewayCancelled'
                        : 'err.gatewayProvider'
  if (error.code === 'budget.exhausted' || error.code === 'budget.service_exhausted') {
    const date = error.resetAt
      ? new Date(error.resetAt).toLocaleDateString(language === 'ru' ? 'ru-RU' : 'en-US', { timeZone: 'UTC' })
      : ''
    return t(language, key, { date })
  }
  return t(language, key, { seconds: Math.max(1, Math.ceil(error.retryAfter ?? 10)) })
}

function gatewayErrorKind(code: unknown): GatewayError['kind'] {
  if (typeof code !== 'string') return 'provider'
  if (code === 'generation.cancelled') return 'cancelled'
  if (code === 'generation.timeout') return 'uncertain'
  if (code === 'budget.exhausted' || code === 'budget.service_exhausted' || code === 'generation.cooldown' || code === 'generation.capacity' || code === 'generation.in_progress' || code === 'session.rate_limited' || code === 'provider.rate_limited') return 'rate'
  if (code === 'session.invalid') return 'session'
  if (code === 'context.too_large' || code === 'provider.context_too_large') return 'context'
  if (code === 'provider.unavailable' || code === 'backend.internal') return 'uncertain'
  return 'provider'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isAbort(error: unknown): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === 'AbortError'
}
