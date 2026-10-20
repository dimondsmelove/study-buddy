import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { ApiError } from '../shared/api'
import type { ApiContent, ApiMessage, CompletionResult } from '../shared/api'
import { MODEL_CHAIN, askWithFallback } from '../shared/ai'
import {
  GATEWAY_LIMITS,
  gatewayFingerprint,
  isAnswerLanguage,
  isTurnKind,
  prepareGatewayGeneration,
  type GatewayGenerationInput,
} from '../shared/gateway-protocol'
import type { BackendConfig, BackendDependencies } from './config'
import { OperationalStore } from './store'
import { ImageValidationError, validateImageDataUrl } from './images'

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'

interface PublicError {
  status: number
  code: string
  message: string
  retryAfter?: number
}

class HttpFailure extends Error {
  constructor(readonly failure: PublicError) {
    super(failure.code)
  }
}

export interface BackendApp {
  server: Server
  close(): Promise<void>
}

async function reconcilePendingBudget(
  store: OperationalStore,
  providerBaseUrl: string,
  apiKey: string,
  now: () => number,
  log: (entry: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<void> {
  const pending = store.pendingBudgetReconciliation(now(), 3)
  for (const charge of pending) {
    store.markBudgetReconciliationAttempt(charge.installationId, charge.requestId, now())
    try {
      const response = await fetch(`${providerBaseUrl}/generation?id=${encodeURIComponent(charge.generationId)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      })
      if (!response.ok) continue
      const payload: unknown = await response.json()
      const root = recordOrUndefined(payload)
      const data = recordOrUndefined(root?.data)
      const terminal = (typeof data?.finish_reason === 'string' && data.finish_reason.length > 0) || data?.cancelled === true
      if (data?.id !== charge.generationId || data.model !== MODEL_CHAIN[0] || !terminal ||
          typeof data.generation_time !== 'number' || !Number.isFinite(data.generation_time) ||
          typeof data.total_cost !== 'number' || !Number.isFinite(data.total_cost) || data.total_cost < 0) continue
      const chargedNano = costToNano(data.total_cost)
      if (chargedNano === undefined) continue
      const settlement = store.settleBudget(charge.installationId, charge.requestId, chargedNano, now())
      if (settlement?.exceededReserve) safeLog(log, { event: 'budget.reserve_exceeded', route: '/api/v1/generations' })
    } catch {
      // Unknown provider state keeps the full reservation held.
    }
  }
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function costToNano(cost: number | undefined): number | undefined {
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) return undefined
  const nano = Math.ceil(cost * 1_000_000_000)
  return Number.isSafeInteger(nano) ? nano : undefined
}

function isDefiniteProviderRejection(error: unknown, providerAccepted: boolean): boolean {
  if (!(error instanceof ApiError)) return false
  return !providerAccepted && error.definitiveRejection
}

export function createBackend(config: BackendConfig, dependencies: BackendDependencies = {}): BackendApp {
  const now = dependencies.now ?? Date.now
  const log = dependencies.log ?? ((entry: Record<string, unknown>) => console.info(JSON.stringify(entry)))
  const providerBaseUrl = normalizeProviderBaseUrl(dependencies.providerBaseUrl ?? OPENROUTER_API_BASE)
  const store = new OperationalStore(config.databasePath, config.sessionHmacSecret, now())
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>()
  let reconciling: Promise<void> | undefined
  const reconcileController = new AbortController()
  const reconcileBudget = (): Promise<void> => {
    if (reconciling) return reconciling
    reconciling = reconcilePendingBudget(store, providerBaseUrl, config.providerApiKey, now, log, reconcileController.signal)
      .finally(() => { reconciling = undefined })
    return reconciling
  }
  void reconcileBudget().catch(() => {})
  const trustedProxies = new Set(config.trustedProxyIps.map(normalizeIp))
  const allowedOrigins = new Set(config.allowedOrigins)
  const server = createServer((request, response) => {
    const route = routeName(request)
    const startedAt = now()
    let logged = false
    const finishLog = (): void => {
      if (logged) return
      logged = true
      safeLog(log, {
        event: 'http.complete',
        method: request.method ?? 'UNKNOWN',
        route,
        status: response.statusCode,
        durationMs: Math.max(0, now() - startedAt),
      })
    }
    response.once('finish', finishLog)
    response.once('close', finishLog)
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent && error instanceof HttpFailure) {
        const item = error.failure
        sendJson(response, item.status, item.code, item.message, undefined, item.retryAfter)
      } else if (!response.headersSent) {
        sendJson(response, 500, 'backend.internal', 'The backend could not complete this request.')
      } else if (!response.writableEnded) response.end()
    })
  })

  server.headersTimeout = 15_000
  server.requestTimeout = 300_000
  server.maxHeadersCount = 64

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin
    if (origin && !allowedOrigins.has(origin)) {
      sendJson(response, 403, 'origin.forbidden', 'This extension origin is not allowed.')
      return
    }
    if (origin) applyCors(response, origin)

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      })
      response.end()
      return
    }

    const path = pathname(request)
    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, undefined, undefined, { ok: true })
      return
    }

    if (request.method === 'POST' && path === '/api/v1/session') {
      const body = await readBody(request, 1_024)
      if (body.byteLength) throw failure(400, 'request.body_not_allowed', 'This endpoint does not accept a request body.')
      const issued = store.issueInstallation(clientIp(request, trustedProxies), now())
      if ('retryAfter' in issued) {
        sendJson(response, 429, 'session.rate_limited', 'Too many installations were started from this network. Try again later.', undefined, issued.retryAfter)
        return
      }
      sendJson(response, 201, undefined, undefined, {
        token: issued.token,
        expiresAt: issued.session.expiresAt,
        installationId: issued.installationId,
        installationSecret: issued.installationSecret,
      })
      return
    }

    if (request.method === 'POST' && path === '/api/v1/session/recover') {
      const body = parseInstallationCredential(await readJsonBody(request, 1_024))
      if (!body) throw failure(400, 'installation.credential_invalid', 'The saved installation credential is invalid.')
      const session = store.recoverInstallation(body.installationId, body.installationSecret, now())
      if (!session) {
        sendJson(response, 401, 'installation.invalid', 'The saved installation credential is unavailable.')
        return
      }
      sendJson(response, 201, undefined, undefined, { token: session.token, expiresAt: session.session.expiresAt })
      return
    }

    if (request.method === 'POST' && path === '/api/v1/session/claim') {
      const body = await readBody(request, 1_024)
      if (body.byteLength) throw failure(400, 'request.body_not_allowed', 'This endpoint does not accept a request body.')
      const token = bearerToken(request)
      const claimed = token ? store.claimInstallation(token, now()) : undefined
      if (!claimed) {
        sendJson(response, 401, 'session.invalid', 'The session is unavailable. Reconnect to continue.')
        return
      }
      sendJson(response, 200, undefined, undefined, {
        token,
        expiresAt: claimed.session.expiresAt,
        installationId: claimed.installationId,
        installationSecret: claimed.installationSecret,
      })
      return
    }

    if (request.method === 'POST' && path === '/api/v1/session/renew') {
      const body = await readBody(request, 1_024)
      if (body.byteLength) throw failure(400, 'request.body_not_allowed', 'This endpoint does not accept a request body.')
      const token = bearerToken(request)
      if (!token) {
        sendJson(response, 401, 'session.invalid', 'The session is unavailable. Reconnect to continue.')
        return
      }
      const session = store.renew(token, now())
      if (!session) {
        sendJson(response, 401, 'session.invalid', 'The session is unavailable. Reconnect to continue.')
        return
      }
      sendJson(response, 200, undefined, undefined, { token, expiresAt: session.expiresAt })
      return
    }

    if (request.method === 'POST' && path === '/api/v1/generations') {
      await handleGeneration(request, response)
      return
    }

    sendJson(response, 404, 'route.not_found', 'This backend route does not exist.')
  }

  async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
    const bytes = await readBody(request, limit)
    try { return JSON.parse(bytes.toString('utf8')) }
    catch { throw failure(400, 'request.invalid_json', 'The request is not valid JSON.') }
  }

  async function handleGeneration(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearerToken(request)
    if (!token) {
      sendJson(response, 401, 'session.invalid', 'The session is unavailable. Reconnect to continue.')
      return
    }
    const session = store.authenticate(token, now())
    if (!session) {
      sendJson(response, 401, 'session.invalid', 'The session is unavailable. Reconnect to continue.')
      return
    }

    const bytes = await readBody(request, GATEWAY_LIMITS.requestBytes)
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      sendJson(response, 415, 'request.content_type', 'Send a JSON generation request.')
      return
    }

    let decoded: unknown
    try {
      decoded = JSON.parse(bytes.toString('utf8'))
    } catch {
      sendJson(response, 400, 'request.invalid_json', 'The generation request is not valid JSON.')
      return
    }

    const input = parseGenerationInput(decoded)
    let prepared
    try {
      prepared = prepareGatewayGeneration(input)
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const message = code === 'gateway.askInputRequired'
        ? 'Ask requires a question.'
        : 'The task request is invalid.'
      sendJson(response, 400, code || 'generation.invalid', message)
      return
    }

    const effectiveBudget = GATEWAY_LIMITS.inputTokens - GATEWAY_LIMITS.estimateHeadroom
    if (prepared.estimatedInputTokens > effectiveBudget) {
      sendJson(response, 422, 'context.too_large', 'The selected context is too large. Remove older messages or images and try again.')
      return
    }

    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ modelChain: MODEL_CHAIN, request: gatewayFingerprint(input, prepared) }))
      .digest('hex')
    await reconcileBudget().catch(() => {})
    const admission = store.admit(session.id, input.requestId, fingerprint, now())
    if (!admission.accepted) {
      const message = admission.code === 'generation.cooldown'
        ? 'Please wait before starting another generation.'
        : admission.code === 'generation.capacity'
          ? 'The backend is busy. Try again shortly.'
          : admission.code === 'generation.request_id_conflict'
            ? 'This request identifier was already used for different content.'
            : admission.code === 'generation.already_started'
              ? 'This generation was already started. Start a new request to try again.'
              : admission.code === 'generation.in_progress'
                ? 'This installation already has a generation in progress.'
                : admission.code === 'budget.exhausted'
                  ? 'The monthly anonymous usage limit has been reached.'
                  : admission.code === 'budget.accounting_review'
                    ? 'A provider charge exceeded its reserved limit. Contact support before continuing.'
                    : admission.code === 'installation.required'
                      ? 'Reconnect this installation before starting another answer.'
                    : 'The session is unavailable. Reconnect to continue.'
      sendJson(response, admission.status, admission.code, message, undefined, admission.retryAfter,
        admission.resetAt ? { resetAt: admission.resetAt } : undefined)
      return
    }

    await streamGeneration(response, session.id, session.installationId!, input, prepared)
  }

  async function streamGeneration(
    response: ServerResponse,
    sessionId: string,
    installationId: string,
    input: GatewayGenerationInput,
    prepared: ReturnType<typeof prepareGatewayGeneration>,
  ): Promise<void> {
    const operationKey = sessionId + ':' + input.requestId
    const controller = new AbortController()
    let completeOperation!: () => void
    const done = new Promise<void>((resolve) => { completeOperation = resolve })
    let timedOut = false
    let disconnected = false
    let emittedText = false
    let operationStatus: 'complete' | 'failed' | 'cancelled' | 'interrupted' = 'failed'
    let operationFinalized = false
    let providerAccepted = false
    active.set(operationKey, { controller, done })

    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.operationTimeoutMs)
    timeout.unref?.()
    const onClose = (): void => {
      if (response.writableEnded) return
      disconnected = true
      controller.abort()
    }
    response.once('close', onClose)

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.flushHeaders()
    writeEvent(response, 'context', {
      estimatedInputTokens: prepared.estimatedInputTokens,
      inputBudget: prepared.inputBudget,
      estimateHeadroom: GATEWAY_LIMITS.estimateHeadroom,
    })

    try {
      const settings = {
        provider: 'openrouter' as const,
        baseUrl: providerBaseUrl,
        apiKey: config.providerApiKey,
        uiLanguage: input.uiLanguage,
        answerLanguage: input.answerLanguage,
      }
      const result = await askWithFallback({
        settings,
        messages: prepared.messages,
        maxTokens: prepared.maxTokens,
        signal: controller.signal,
        onDelta: (text) => {
          emittedText = true
          if (!controller.signal.aborted) writeEvent(response, 'delta', { text })
        },
        onProviderGenerationId: (generationId) => store.recordProviderGeneration(installationId, input.requestId, generationId, now()),
        onProviderResponseAccepted: () => { providerAccepted = true },
      })
      const safeResult = completionDto(result)
      const chargedNano = costToNano(result.usage?.cost)
      operationStatus = result.status === 'interrupted' ? 'interrupted' : 'complete'
      const settlement = store.settleBudgetAndFinish(sessionId, installationId, input.requestId, operationStatus, chargedNano, now())
      operationFinalized = true
      if (settlement?.exceededReserve) safeLog(log, { event: 'budget.reserve_exceeded', route: '/api/v1/generations' })
      writeEvent(response, 'complete', safeResult)
    } catch (error) {
      if (isDefiniteProviderRejection(error, providerAccepted)) store.releaseBudget(installationId, input.requestId, now())
      else store.holdBudget(installationId, input.requestId, now())
      if (disconnected || response.destroyed) {
        operationStatus = 'cancelled'
      } else if (timedOut) {
        operationStatus = emittedText ? 'interrupted' : 'failed'
        writeEvent(response, 'error', {
          code: 'generation.timeout',
          message: 'The generation took too long. Try again.',
          partial: emittedText,
        })
      } else if (isAborted(error)) {
        operationStatus = 'cancelled'
        writeEvent(response, 'error', {
          code: 'generation.cancelled',
          message: 'Generation cancelled.',
          partial: emittedText,
        })
      } else {
        operationStatus = emittedText ? 'interrupted' : 'failed'
        const publicError = providerFailure(error)
        writeEvent(response, 'error', {
          code: publicError.code,
          message: publicError.message,
          partial: emittedText,
        })
      }
    } finally {
      clearTimeout(timeout)
      response.removeListener('close', onClose)
      active.delete(operationKey)
      try {
        if (!operationFinalized) store.finish(sessionId, input.requestId, operationStatus, now())
      } finally { completeOperation() }
      if (!response.writableEnded && !response.destroyed) response.end()
    }
  }

  return {
    server,
    async close(): Promise<void> {
      const operations = [...active.values()]
      for (const operation of operations) operation.controller.abort()
      if (server.listening) {
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve())
        })
        server.closeAllConnections()
        await closed
      }
      await Promise.allSettled(operations.map((operation) => operation.done))
      reconcileController.abort()
      if (reconciling) await reconciling.catch(() => {})
      store.close()
    },
  }
}

function parseInstallationCredential(value: unknown): { installationId: string; installationSecret: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  if (typeof body.installationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.installationId) ||
      typeof body.installationSecret !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(body.installationSecret)) return undefined
  return { installationId: body.installationId, installationSecret: body.installationSecret }
}

function parseGenerationInput(value: unknown): GatewayGenerationInput {
  const root = record(value)
  exactKeys(root, ['requestId', 'task', 'answerLanguage', 'browserLanguage', 'uiLanguage', 'titleNeeded', 'taskInput', 'selectedAnswerText', 'messages'])
  if (typeof root.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(root.requestId)) {
    throw failure(400, 'generation.request_id', 'The request identifier is invalid.')
  }
  if (!isTurnKind(root.task)) throw failure(400, 'generation.task', 'The task is invalid.')
  if (!isAnswerLanguage(root.answerLanguage)) throw failure(400, 'generation.language', 'The answer language is invalid.')
  if (typeof root.browserLanguage !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(root.browserLanguage) || root.browserLanguage.length > 35) {
    throw failure(400, 'generation.language', 'The browser language is invalid.')
  }
  if (root.uiLanguage !== 'en' && root.uiLanguage !== 'ru') {
    throw failure(400, 'generation.language', 'The interface language is invalid.')
  }
  if (typeof root.titleNeeded !== 'boolean') throw failure(400, 'generation.title', 'The title option is invalid.')

  let taskInput: string | undefined
  if (root.taskInput !== undefined) {
    if (typeof root.taskInput !== 'string' || root.taskInput.length > GATEWAY_LIMITS.maxTaskInputChars) {
      throw failure(400, 'generation.task_input', 'The task input is invalid.')
    }
    taskInput = root.taskInput
  }
  if (root.task === 'ask' && (taskInput === undefined || !taskInput.trim())) {
    throw failure(400, 'generation.task_input', 'Ask requires a question.')
  }
  if (taskInput !== undefined && root.task !== 'ask' && root.task !== 'check') {
    throw failure(400, 'generation.task_input', 'This task does not accept extra input.')
  }
  let selectedAnswerText: string | undefined
  if (root.selectedAnswerText !== undefined) {
    if (typeof root.selectedAnswerText !== 'string' || root.selectedAnswerText.length > GATEWAY_LIMITS.maxTaskInputChars || !root.selectedAnswerText.trim()) {
      throw failure(400, 'generation.selected_answer', 'The selected answer is invalid.')
    }
    selectedAnswerText = root.selectedAnswerText
  }
  if ((root.task === 'simpler') !== (selectedAnswerText !== undefined)) {
    throw failure(400, 'generation.selected_answer', 'Simpler requires the selected answer text.')
  }
  if (!Array.isArray(root.messages) || root.messages.length === 0 || root.messages.length > GATEWAY_LIMITS.maxMessages) {
    throw failure(400, 'generation.messages', 'The selected message history is invalid.')
  }

  const messages: ApiMessage[] = []
  const maxImages = Math.floor(
    (GATEWAY_LIMITS.inputTokens - GATEWAY_LIMITS.estimateHeadroom) /
      GATEWAY_LIMITS.imageTokenEstimate,
  )
  let imageCount = 0
  for (const value of root.messages) {
    const message = record(value)
    exactKeys(message, ['role', 'content'])
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw failure(400, 'generation.messages', 'Only selected user and assistant messages are accepted.')
    }
    if (typeof message.content === 'string') {
      if (message.content.length > GATEWAY_LIMITS.maxMessageChars) {
        throw failure(413, 'generation.message_too_large', 'A selected message is too large.')
      }
      messages.push({ role: message.role, content: message.content })
      continue
    }
    if (!Array.isArray(message.content) || message.content.length === 0 || message.content.length > 1_000) {
      throw failure(400, 'generation.messages', 'A message content part is invalid.')
    }
    const parts: Extract<ApiContent, unknown[]> = []
    for (const partValue of message.content) {
      const part = record(partValue)
      if (part.type === 'text') {
        exactKeys(part, ['type', 'text'])
        if (typeof part.text !== 'string' || part.text.length > GATEWAY_LIMITS.maxMessageChars) {
          throw failure(413, 'generation.message_too_large', 'A selected message is too large.')
        }
        parts.push({ type: 'text', text: part.text })
      } else if (part.type === 'image_url') {
        exactKeys(part, ['type', 'image_url'])
        const image = record(part.image_url)
        exactKeys(image, ['url'])
        if (typeof image.url !== 'string') throw failure(400, 'generation.image', 'An image attachment is invalid.')
        let normalizedUrl: string
        try {
          normalizedUrl = validateImageDataUrl(image.url).dataUrl
        } catch (error) {
          if (error instanceof ImageValidationError && error.code === 'image.too_large') {
            throw failure(413, error.code, 'An image attachment is too large.')
          }
          throw failure(400, 'generation.image', 'An image attachment is invalid.')
        }
        imageCount++
        if (imageCount > maxImages) {
          throw failure(422, 'context.too_large', 'The selected context is too large. Remove older messages or images and try again.')
        }
        parts.push({ type: 'image_url', image_url: { url: normalizedUrl } })
      } else {
        throw failure(400, 'generation.messages', 'A message content part is invalid.')
      }
    }
    messages.push({ role: message.role, content: parts })
  }

  if (messages.at(-1)?.role !== 'user') {
    throw failure(400, 'generation.current_user', 'The selected history must end with the current user message.')
  }
  return {
    requestId: root.requestId,
    task: root.task,
    answerLanguage: root.answerLanguage,
    browserLanguage: root.browserLanguage,
    uiLanguage: root.uiLanguage,
    titleNeeded: root.titleNeeded,
    ...(taskInput !== undefined ? { taskInput } : {}),
    ...(selectedAnswerText !== undefined ? { selectedAnswerText } : {}),
    messages,
  }
}

function providerFailure(error: unknown): PublicError {
  if (error instanceof ApiError) {
    if (error.kind === 'context') {
      return { status: 422, code: 'provider.context_too_large', message: 'The selected context exceeds the provider limit. Remove older messages or images and try again.' }
    }
    if (error.kind === 'auth' || error.kind === 'credits') {
      return {
        status: 502,
        code: error.kind === 'auth' ? 'provider.auth' : 'provider.credits',
        message: 'The AI provider rejected the server request. Contact the backend operator.',
      }
    }
    if (error.kind === 'rate') {
      return { status: 503, code: 'provider.rate_limited', message: 'The AI provider is busy. Try again shortly.' }
    }
  }
  return { status: 502, code: 'provider.unavailable', message: 'The AI provider could not complete this request.' }
}

function completionDto(result: CompletionResult): Record<string, unknown> {
  const model = result.model && MODEL_CHAIN.includes(result.model) ? result.model : undefined
  const usage = result.usage
  const safeUsage = usage ? {
    ...(nonNegative(usage.promptTokens) ? { promptTokens: usage.promptTokens } : {}),
    ...(nonNegative(usage.completionTokens) ? { completionTokens: usage.completionTokens } : {}),
    ...(nonNegative(usage.cost) ? { cost: usage.cost } : {}),
  } : undefined
  return {
    status: result.status,
    ...(model ? { model } : {}),
    ...(typeof result.finishReason === 'string' && result.finishReason.length <= 100
      ? { finishReason: result.finishReason.replace(/[\u0000-\u001f\u007f]/g, '') }
      : {}),
    ...(safeUsage && Object.keys(safeUsage).length ? { usage: safeUsage } : {}),
  }
}

function nonNegative(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function isAborted(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'aborted'
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization
  const match = typeof value === 'string' ? /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(value) : null
  return match?.[1]
}

function applyCors(response: ServerResponse, origin: string): void {
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Expose-Headers', 'Retry-After')
}

function sendJson(
  response: ServerResponse,
  status: number,
  code?: string,
  message?: string,
  value?: Record<string, unknown>,
  retryAfter?: number,
  errorDetails?: Record<string, unknown>,
): void {
  if (retryAfter !== undefined) response.setHeader('Retry-After', String(retryAfter))
  const body = code && message ? { error: { code, message, ...errorDetails } } : value ?? {}
  const encoded = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(encoded),
  })
  response.end(encoded)
}

function writeEvent(response: ServerResponse, event: string, value: Record<string, unknown>): void {
  if (response.destroyed || response.writableEnded) return
  response.write('event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n')
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = request.headers['content-length']
  if (declared !== undefined) {
    const length = Array.isArray(declared) ? Number.NaN : Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) throw failure(400, 'request.content_length', 'The request length is invalid.')
    if (length > limit) {
      request.resume()
      throw failure(413, 'request.too_large', 'The request is too large.')
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > limit) {
      request.resume()
      throw failure(413, 'request.too_large', 'The request is too large.')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure(400, 'request.shape', 'The request shape is invalid.')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw failure(400, 'request.field', 'The request contains an unsupported field.')
  }
}

function failure(status: number, code: string, message: string, retryAfter?: number): HttpFailure {
  return new HttpFailure({ status, code, message, retryAfter })
}

function pathname(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://backend.invalid').pathname
  } catch {
    return '/'
  }
}

function routeName(request: IncomingMessage): string {
  const path = pathname(request)
  return ['/health', '/api/v1/session', '/api/v1/session/renew', '/api/v1/generations'].includes(path)
    ? path
    : 'other'
}

function clientIp(request: IncomingMessage, trusted: Set<string>): string {
  const peer = normalizeRemoteIp(request.socket.remoteAddress ?? '')
  if (!peer || !trusted.has(peer)) return peer || 'unknown'
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded !== 'string' || forwarded.length > 512) return peer
  const hops = forwarded.split(',').map(normalizeRemoteIp)
  if (!hops.length || hops.length > 8 || hops.some((hop) => !hop)) return peer
  let current = peer
  for (const hop of hops.reverse()) {
    if (!trusted.has(current)) break
    current = hop
  }
  return current
}

function normalizeRemoteIp(value: string): string {
  const candidate = value.trim().toLowerCase()
  if (candidate.startsWith('::ffff:') && isIP(candidate.slice(7)) === 4) return candidate.slice(7)
  return isIP(candidate) ? candidate : ''
}

function normalizeIp(value: string): string {
  const normalized = normalizeRemoteIp(value)
  if (!normalized) throw new Error('Invalid configured IP')
  return normalized
}

function normalizeProviderBaseUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid backend provider base URL')
  }
  return url.href.replace(/\/+$/, '')
}

function safeLog(log: (entry: Record<string, unknown>) => void, entry: Record<string, unknown>): void {
  try {
    log(entry)
  } catch {
    // Logging must not change request outcomes.
  }
}
