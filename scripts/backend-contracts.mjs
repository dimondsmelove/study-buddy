import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { readFile, readdir, rm, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createViteServer } from 'vite'

const vite = await createViteServer({
  configFile: false,
  root: process.cwd(),
  appType: 'custom',
  server: { middlewareMode: true },
})
let failed = false
const test = async (name, body) => {
  try {
    await body()
    console.log('ok - ' + name)
  } catch (error) {
    failed = true
    console.error('not ok - ' + name)
    console.error(error)
  }
}

const [{ createBackend }, { OperationalStore }, { validateImageDataUrl }, protocol, backendConfig] = await Promise.all([
  vite.ssrLoadModule('/src/backend/app.ts'),
  vite.ssrLoadModule('/src/backend/store.ts'),
  vite.ssrLoadModule('/src/backend/images.ts'),
  vite.ssrLoadModule('/src/shared/gateway-protocol.ts'),
  vite.ssrLoadModule('/src/backend/config.ts'),
])

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(name, data) {
  const type = Buffer.from(name, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length)
  return chunk
}

function png(width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', Buffer.alloc(0)),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 2, 0, 1])),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return 'data:image/png;base64,' + bytes.toString('base64')
}

function webpVp8x(width, height) {
  const data = Buffer.alloc(10)
  writeUInt24LE(data, 4, width - 1)
  writeUInt24LE(data, 7, height - 1)
  const chunk = Buffer.alloc(18)
  chunk.write('VP8X', 0, 'ascii')
  chunk.writeUInt32LE(10, 4)
  data.copy(chunk, 8)
  const frame = Buffer.alloc(20)
  frame.write('VP8 ', 0, 'ascii')
  frame.writeUInt32LE(11, 4)
  frame[11] = 0x9d
  frame[12] = 0x01
  frame[13] = 0x2a
  frame.writeUInt16LE(width, 14)
  frame.writeUInt16LE(height, 16)
  const bytes = Buffer.alloc(12 + chunk.length + frame.length)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WEBP', 8, 'ascii')
  chunk.copy(bytes, 12)
  frame.copy(bytes, 12 + chunk.length)
  return 'data:image/webp;base64,' + bytes.toString('base64')
}

function webpFrameBeforeCanvas(width, height) {
  const valid = Buffer.from(webpVp8x(width, height).split(',')[1], 'base64')
  const frame = valid.subarray(30)
  const canvas = valid.subarray(12, 30)
  const bytes = Buffer.concat([valid.subarray(0, 12), frame, canvas])
  bytes.writeUInt32LE(bytes.length - 8, 4)
  return 'data:image/webp;base64,' + bytes.toString('base64')
}

function writeUInt24LE(bytes, offset, value) {
  bytes[offset] = value & 255
  bytes[offset + 1] = (value >>> 8) & 255
  bytes[offset + 2] = (value >>> 16) & 255
}

function jpeg(width, height) {
  const frame = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 255, height & 255, (width >>> 8) & 255, width & 255,
    0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
    0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9,
  ])
  return 'data:image/jpeg;base64,' + frame.toString('base64')
}

const nowBase = 1_800_000_000_000
const secret = 'test-session-hmac-secret-0123456789'

await test('backend startup accepts exact unpacked extension origins and rejects paths', async () => {
  const config = backendConfig.loadBackendConfig({
    OPENROUTER_API_KEY: 'FAKE_PROVIDER_KEY',
    SESSION_HMAC_SECRET: 'test-session-hmac-secret-0123456789',
    ALLOWED_ORIGINS: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  })
  assert.deepEqual(config.allowedOrigins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'])
  assert.throws(() => backendConfig.loadBackendConfig({
    OPENROUTER_API_KEY: 'FAKE_PROVIDER_KEY',
    SESSION_HMAC_SECRET: 'test-session-hmac-secret-0123456789',
    ALLOWED_ORIGINS: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/path',
  }), /invalid extension origin/)
})

async function startProvider(responder) {
  const requests = []
  const server = createHttpServer(async (request, response) => {
    const chunks = []
    try {
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const body = request.method === 'GET' || !bytes.length ? undefined : JSON.parse(bytes.toString('utf8'))
      requests.push({ method: request.method, body, url: request.url, ...(body && typeof body === 'object' ? body : {}) })
      await responder({ request, response, body, requests })
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) response.destroy(error)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    server,
    requests,
    baseUrl: 'http://127.0.0.1:' + address.port + '/api/v1',
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function sse(data) {
  return 'data: ' + JSON.stringify(data) + '\n\n'
}

async function createFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'study-buddy-backend-'))
  const logs = []
  let clock = options.now ?? nowBase
  const provider = await startProvider(options.responder ?? (async ({ response }) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(
      sse({ model: 'openai/gpt-6-luna', choices: [{ delta: { content: 'PROVIDER_OUTPUT_SENTINEL' }, finish_reason: null }] }) +
      sse({ model: 'openai/gpt-6-luna', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 23, completion_tokens: 4, cost: 0.0001 } }) +
      sse({ model: 'openai/gpt-6-luna', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 23, completion_tokens: 4, cost: 0.0001 } }) +
      sse({ choices: [], usage: { prompt_tokens: 23, completion_tokens: 4, cost: 0.0001 } }) +
      'data: [DONE]\n\n',
    )
  }))
  const config = {
    host: '127.0.0.1',
    port: 0,
    databasePath: join(directory, 'state.sqlite'),
    providerApiKey: 'FAKE_PROVIDER_KEY',
    sessionHmacSecret: secret,
    allowedOrigins: ['chrome-extension://test-extension'],
    trustedProxyIps: options.trustedProxyIps ?? [],
    operationTimeoutMs: options.timeoutMs ?? 180_000,
  }
  const backend = createBackend(config, {
    now: () => clock,
    log: (entry) => logs.push(entry),
    providerBaseUrl: provider.baseUrl,
  })
  await new Promise((resolve) => backend.server.listen(0, '127.0.0.1', resolve))
  const address = backend.server.address()
  const baseUrl = 'http://127.0.0.1:' + address.port
  return {
    directory, logs, provider, config, backend, baseUrl,
    get now() { return clock },
    set now(value) { clock = value },
    async close() {
      await this.backend.close()
      await provider.close()
    },
  }
}

async function issueSession(fixture, origin, extraHeaders = {}) {
  const response = await fetch(fixture.baseUrl + '/api/v1/session', {
    method: 'POST',
    headers: { ...extraHeaders, ...(origin ? { Origin: origin } : {}) },
  })
  const body = await response.json()
  return { response, body, token: body.token }
}

function input(requestId = 'request_00000001', changes = {}) {
  return {
    requestId,
    task: 'ask',
    answerLanguage: 'en',
    browserLanguage: 'en',
    uiLanguage: 'en',
    titleNeeded: false,
    taskInput: 'What is 2 + 2?',
    messages: [
      { role: 'assistant', content: 'HISTORICAL_TRANSCRIPT_SENTINEL' },
      { role: 'user', content: 'client text must be replaced' },
    ],
    ...changes,
  }
}

async function postGeneration(fixture, token, value, extra = {}) {
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...extra.headers }
  return fetch(fixture.baseUrl + '/api/v1/generations', {
    method: 'POST',
    headers,
    body: extra.rawBody ?? JSON.stringify(value),
  })
}

function events(body) {
  return body.split('\n\n').filter(Boolean).map((block) => {
    const event = block.match(/^event: ([^\n]+)/m)?.[1]
    const data = block.match(/^data: ([^\n]+)/m)?.[1]
    return { event, data: data ? JSON.parse(data) : undefined }
  })
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Timed out waiting for ' + label)
}

await test('shared preparation includes canonical approved prompts and estimates UTF-8 text', async () => {
  const prepared = protocol.prepareGatewayGeneration(input())
  assert.equal(prepared.messages[0].role, 'system')
  assert.match(prepared.messages[0].content, /Respond in English/)
  assert.match(prepared.messages.at(-1).content, /What is 2 \+ 2\?/)
  assert.equal('temperature' in prepared, false)
  assert.equal(prepared.maxTokens, 16_384)
  assert.equal(protocol.estimateTextTokens('abcde'), 2)
  assert.equal(protocol.estimateTextTokens('ЯЯЯ'), 2)
  assert.equal(protocol.estimateTextTokens('😀'), 1)
})

await test('task prompts preserve image parts, legacy quiz uses Solve, Check uses visible work, Ask stays raw, and Simpler uses selected answer', async () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
  const solve = protocol.prepareGatewayGeneration(input('emptytask_0000001', {
    task: 'solve', taskInput: undefined,
    messages: [{ role: 'user', content: [image] }],
  }))
  assert.match(solve.messages[0].content, /Study Buddy/)
  assert.match(solve.messages.at(-1).content[0].text, /Solve the problem shown in the image/)
  assert.deepEqual(solve.messages.at(-1).content[1], image)
  const legacyQuiz = protocol.prepareGatewayGeneration(input('emptytask_0000002', { task: 'quiz', taskInput: undefined, messages: [{ role: 'user', content: '' }] }))
  assert.match(legacyQuiz.messages.at(-1).content, /multiple-choice questions/i)
  const check = protocol.prepareGatewayGeneration(input('emptytask_0000003', {
    task: 'check', taskInput: undefined, messages: [{ role: 'user', content: [image] }],
  }))
  assert.match(check.messages.at(-1).content[0].text, /Check the student's work visible in the image/)
  assert.deepEqual(check.messages.at(-1).content[1], image)
  const ask = protocol.prepareGatewayGeneration(input('emptytask_0000004', {
    taskInput: '  raw Ask text  ', messages: [{ role: 'user', content: 'old app-generated text' }],
  }))
  assert.equal(ask.messages.at(-1).content, '  raw Ask text  ')
  const simpler = protocol.prepareGatewayGeneration(input('emptytask_0000005', {
    task: 'simpler', answerLanguage: 'ru', taskInput: undefined, selectedAnswerText: "selected $& $$ $` $' older reply",
    messages: [{ role: 'assistant', content: 'later answer' }, { role: 'user', content: '' }],
  }))
  assert.match(simpler.messages.at(-1).content, /^Explain the following text more simply in Russian, while preserving its meaning as accurately as possible:/)
  assert.ok(simpler.messages.at(-1).content.includes("selected $& $$ $` $' older reply"))
})

await test('PNG, JPEG and WebP dimensions validate without pixel decompression', async () => {
  assert.equal(validateImageDataUrl(png(1, 1)).byteLength > 0, true)
  assert.equal(validateImageDataUrl(jpeg(640, 480)).byteLength > 0, true)
  assert.equal(validateImageDataUrl(webpVp8x(640, 480)).byteLength > 0, true)
  assert.throws(() => validateImageDataUrl('data:image/png;base64,aGVsbG8='), /image.invalid/)
  const corruptPng = Buffer.from(png(1, 1).split(',')[1], 'base64')
  corruptPng[45] ^= 1
  assert.throws(() => validateImageDataUrl('data:image/png;base64,' + corruptPng.toString('base64')), /image.invalid/)
  assert.throws(() => validateImageDataUrl(png(16_385, 1)), /image.invalid/)
  assert.throws(() => validateImageDataUrl(webpVp8x(10_000, 10_000)), /image.invalid/)
  assert.throws(() => validateImageDataUrl(webpFrameBeforeCanvas(640, 480)), /image.invalid/)
  assert.throws(() => validateImageDataUrl(jpeg(20_000, 1)), /image.invalid/)
  const oversized = 'data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')
  assert.throws(() => validateImageDataUrl(oversized), /image.too_large/)
  assert.throws(() => validateImageDataUrl('https://example.test/image.png'), /image.invalid/)
})

await test('SQLite session expiry, renewal, issuance cap, exact cooldown and idempotency', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'study-buddy-store-'))
  const path = join(directory, 'state.sqlite')
  let store = new OperationalStore(path, secret, nowBase)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const issued = store.issueInstallation('198.51.100.7', nowBase)
  assert.equal('token' in issued, true)
  if (!('token' in issued)) return
  assert.equal(store.authenticate(issued.token, issued.session.expiresAt - 1)?.id, issued.session.id)
  assert.equal(store.authenticate(issued.token, issued.session.expiresAt), undefined)
  const renewed = store.renew(issued.token, nowBase + 100)
  assert.equal(renewed?.id, issued.session.id)
  assert.equal(renewed?.expiresAt, nowBase + 100 + 30 * 24 * 60 * 60 * 1_000)

  const first = store.admit(issued.session.id, 'request_00000001', 'hash-one', nowBase)
  assert.equal(first.accepted, true)
  assert.equal(store.admit(issued.session.id, 'request_00000001', 'hash-one', nowBase + 1).code, 'generation.already_started')
  assert.equal(store.admit(issued.session.id, 'request_00000001', 'hash-two', nowBase + 1).code, 'generation.request_id_conflict')
  store.finish(issued.session.id, 'request_00000001', 'complete', nowBase + 2)
  assert.equal(store.admit(issued.session.id, 'request_00000002', 'hash-two', nowBase + 9_999).code, 'generation.cooldown')
  assert.equal(store.admit(issued.session.id, 'request_00000002', 'hash-two', nowBase + 10_000).accepted, true)
  store.finish(issued.session.id, 'request_00000002', 'complete', nowBase + 10_001)

  let overflow
  for (let index = 0; index < 20; index++) overflow = store.issueInstallation('198.51.100.8', nowBase + index)
  assert.equal('token' in overflow, true)
  overflow = store.issueInstallation('198.51.100.8', nowBase + 20)
  assert.equal('retryAfter' in overflow, true)

  const active = store.issueInstallation('198.51.100.9', nowBase)
  assert.ok('token' in active)
  if (!('token' in active)) return
  assert.equal(store.admit(active.session.id, 'restart_00000001', 'restart-hash', nowBase).accepted, true)
  store.close()
  store = new OperationalStore(path, secret, nowBase + 1)
  const database = new DatabaseSync(path)
  const row = database.prepare('SELECT status FROM operations WHERE request_id = ?').get('restart_00000001')
  assert.equal(row.status, 'interrupted')
  assert.equal(store.admit(active.session.id, 'restart_00000001', 'restart-hash', nowBase + 2).code, 'generation.already_started')
  store.close()
  database.close()
  await rm(directory, { recursive: true, force: true })
})

await test('durable installation recovery, legacy claim, and cross-session admission state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'study-buddy-installation-'))
  const path = join(directory, 'state.sqlite')
  let store = new OperationalStore(path, secret, nowBase)
  const issued = store.issueInstallation('198.51.100.20', nowBase)
  assert.ok('token' in issued)
  if (!('token' in issued)) return
  assert.equal(issued.installationSecret.length, 43)
  const database = new DatabaseSync(path)
  const storedSecret = database.prepare('SELECT secret_hash FROM installations WHERE id = ?')
    .get(issued.installationId).secret_hash
  assert.notEqual(storedSecret, issued.installationSecret)

  const recovered = store.recoverInstallation(issued.installationId, issued.installationSecret, nowBase + 1)
  assert.ok(recovered)
  assert.equal(recovered.session.installationId, issued.installationId)
  assert.equal(store.recoverInstallation(issued.installationId, 'wrong-secret', nowBase + 2), undefined)
  assert.equal(store.admit(issued.session.id, 'identity_active_01', 'first', nowBase + 3).accepted, true)
  assert.equal(store.admit(recovered.session.id, 'identity_active_02', 'second', nowBase + 4).code, 'generation.in_progress')
  store.finish(issued.session.id, 'identity_active_01', 'complete', nowBase + 5)
  assert.equal(store.admit(recovered.session.id, 'identity_cooldown_01', 'second', nowBase + 6).code, 'generation.cooldown')
  assert.equal(store.admit(recovered.session.id, 'identity_active_01', 'different', nowBase + 10_003).code, 'generation.request_id_conflict')

  const legacy = store.issueInstallation('198.51.100.21', nowBase)
  assert.ok('token' in legacy)
  if (!('token' in legacy)) return
  database.prepare('UPDATE sessions SET installation_id = NULL WHERE id = ?').run(legacy.session.id)
  database.prepare('DELETE FROM installations WHERE id = ?').run(legacy.installationId)
  const claimed = store.claimInstallation(legacy.token, nowBase + 1)
  assert.ok(claimed)
  assert.notEqual(claimed.installationId, legacy.installationId)
  const retriedClaim = store.claimInstallation(legacy.token, nowBase + 2)
  assert.equal(retriedClaim?.installationId, claimed.installationId)
  assert.notEqual(retriedClaim?.installationSecret, claimed.installationSecret)

  store.close()
  store = new OperationalStore(path, secret, nowBase + 3)
  const afterRestart = store.recoverInstallation(issued.installationId, issued.installationSecret, nowBase + 4)
  assert.equal(afterRestart?.session.installationId, issued.installationId)
  assert.equal(store.recoverInstallation(legacy.installationId, legacy.installationSecret, nowBase + 4), undefined)
  store.close()
  database.close()
  await rm(directory, { recursive: true, force: true })
})

await test('monthly installation wallet reserves atomically, settles once, rolls over at UTC, and keeps uncertain holds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'study-buddy-budget-'))
  const path = join(directory, 'state.sqlite')
  const monthEnd = Date.UTC(2026, 9, 31, 23, 58, 40)
  let store = new OperationalStore(path, secret, monthEnd)
  const issued = store.issueInstallation('198.51.100.30', monthEnd)
  assert.ok('token' in issued)
  if (!('token' in issued)) return
  const database = new DatabaseSync(path)

  assert.equal(store.admit(issued.session.id, 'budget_first_0001', 'f1', monthEnd).accepted, true)
  let wallet = database.prepare('SELECT spent_nano, reserved_nano FROM monthly_budgets WHERE installation_id = ?')
    .get(issued.installationId)
  assert.equal(wallet.spent_nano, 0)
  assert.equal(wallet.reserved_nano, 275_000_000)
  store.recordProviderGeneration(issued.installationId, 'budget_first_0001', 'gen_budget_first', monthEnd + 1)
  const firstSettlement = store.settleBudgetAndFinish(
    issued.session.id, issued.installationId, 'budget_first_0001', 'complete', 275_000_000, monthEnd + 2,
  )
  assert.equal(firstSettlement.exceededReserve, false)
  store.settleBudget(issued.installationId, 'budget_first_0001', 275_000_000, monthEnd + 3)
  wallet = database.prepare('SELECT spent_nano, reserved_nano FROM monthly_budgets WHERE installation_id = ?')
    .get(issued.installationId)
  assert.equal(wallet.spent_nano, 275_000_000)
  assert.equal(wallet.reserved_nano, 0)

  database.prepare('UPDATE monthly_budgets SET spent_nano = ? WHERE installation_id = ?')
    .run(4_725_000_000, issued.installationId)
  assert.equal(store.admit(issued.session.id, 'budget_exact_0001', 'f2', monthEnd + 10_000).accepted, true)
  store.settleBudgetAndFinish(issued.session.id, issued.installationId, 'budget_exact_0001', 'complete', 275_000_000, monthEnd + 10_001)
  const exhausted = store.admit(issued.session.id, 'budget_over_00001', 'f3', monthEnd + 20_000)
  assert.equal(exhausted.code, 'budget.exhausted')
  assert.equal(exhausted.resetAt, Date.UTC(2026, 10, 1))
  assert.equal(store.admit(issued.session.id, 'budget_newmonth_01', 'f4', Date.UTC(2026, 10, 1) + 1).accepted, true)
  store.settleBudgetAndFinish(issued.session.id, issued.installationId, 'budget_newmonth_01', 'complete', 275_000_001, Date.UTC(2026, 10, 1) + 2)
  assert.equal(store.admit(issued.session.id, 'budget_overrun_001', 'f5', Date.UTC(2026, 10, 1) + 10_001).code, 'budget.accounting_review')

  const rollover = store.issueInstallation('198.51.100.32', monthEnd)
  assert.ok('token' in rollover)
  if (!('token' in rollover)) return
  const lateAdmission = Date.UTC(2026, 9, 31, 23, 59, 50)
  assert.equal(store.admit(rollover.session.id, 'budget_late_00001', 'f8', lateAdmission).accepted, true)
  store.holdBudget(rollover.installationId, 'budget_late_00001', lateAdmission + 1)
  store.settleBudget(rollover.installationId, 'budget_late_00001', 100_000_000, Date.UTC(2026, 10, 1) + 1)
  assert.equal(database.prepare('SELECT spent_nano FROM monthly_budgets WHERE installation_id = ? AND month_key = ?')
    .get(rollover.installationId, '2026-10').spent_nano, 100_000_000)
  assert.equal(database.prepare('SELECT spent_nano FROM monthly_budgets WHERE installation_id = ? AND month_key = ?')
    .get(rollover.installationId, '2026-11'), undefined)

  const uncertain = store.issueInstallation('198.51.100.31', monthEnd)
  assert.ok('token' in uncertain)
  if (!('token' in uncertain)) return
  assert.equal(store.admit(uncertain.session.id, 'budget_held_0001', 'f6', monthEnd).accepted, true)
  store.recordProviderGeneration(uncertain.installationId, 'budget_held_0001', 'gen_budget_pending', monthEnd + 1)
  store.holdBudget(uncertain.installationId, 'budget_held_0001', monthEnd + 2)
  store.finish(uncertain.session.id, 'budget_held_0001', 'interrupted', monthEnd + 2)
  store.close()
  store = new OperationalStore(path, secret, monthEnd + 3)
  const pending = store.pendingBudgetReconciliation(monthEnd + 3, 10)
  assert.equal(pending.some((charge) => charge.generationId === 'gen_budget_pending'), true)
  assert.equal(store.admit(uncertain.session.id, 'budget_held_0002', 'f7', monthEnd + 20_000).accepted, true,
    'an uncertain hold reduces available balance without locking the installation')
  store.markBudgetReconciliationAttempt(uncertain.installationId, 'budget_held_0001', monthEnd + 3)
  assert.equal(store.pendingBudgetReconciliation(monthEnd + 4, 10).some((charge) => charge.generationId === 'gen_budget_pending'), false)
  assert.equal(store.pendingBudgetReconciliation(monthEnd + 30_003, 10).some((charge) => charge.generationId === 'gen_budget_pending'), true)
  store.close()
  database.close()
  await rm(directory, { recursive: true, force: true })
})

await test('global reserve is restored by release and settlement of the original month charge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'study-buddy-service-budget-'))
  const path = join(directory, 'state.sqlite')
  const now = Date.UTC(2026, 9, 20)
  const store = new OperationalStore(path, secret, now)
  const database = databaseFor(path)
  const a = store.issueInstallation('198.51.100.41', now)
  const b = store.issueInstallation('198.51.100.42', now)
  const c = store.issueInstallation('198.51.100.43', now)
  assert.ok('token' in a && 'token' in b && 'token' in c)
  if (!('token' in a) || !('token' in b) || !('token' in c)) return
  const monthKey = '2026-10'
  database.prepare(
    'INSERT INTO monthly_budgets(installation_id, month_key, spent_nano, reserved_nano) VALUES (?, ?, ?, 0)',
  ).run('cccccccc-cccc-4ccc-8ccc-cccccccccccc', monthKey, 99_725_000_000)

  assert.equal(store.admit(a.session.id, 'global_release_0001', 'a', now).accepted, true)
  assert.equal(store.admit(b.session.id, 'global_denied_0001', 'b', now).code, 'budget.service_exhausted')
  store.releaseBudget(a.installationId, 'global_release_0001', now + 1)
  store.finish(a.session.id, 'global_release_0001', 'failed', now + 1)
  assert.equal(store.admit(b.session.id, 'global_settle_0001', 'b2', now).accepted, true)
  store.settleBudgetAndFinish(b.session.id, b.installationId, 'global_settle_0001', 'complete', 0, now + 1)
  assert.equal(store.admit(c.session.id, 'global_after_settle_0001', 'c', now).accepted, true)
  store.releaseBudget(c.installationId, 'global_after_settle_0001', now + 1)
  store.finish(c.session.id, 'global_after_settle_0001', 'failed', now + 1)

  const november = Date.UTC(2026, 10, 1)
  assert.equal(store.admit(c.session.id, 'global_newmonth_0001', 'c2', november).accepted, true,
    'the new UTC month has an independent global aggregate')
  store.settleBudgetAndFinish(c.session.id, c.installationId, 'global_newmonth_0001', 'complete', 0, november + 1)
  const late = store.issueInstallation('198.51.100.44', now)
  assert.ok('token' in late)
  if (!('token' in late)) return
  const octoberLate = Date.UTC(2026, 9, 31, 23, 59, 50)
  assert.equal(store.admit(late.session.id, 'global_late_october_001', 'late', octoberLate).accepted, true)
  store.holdBudget(late.installationId, 'global_late_october_001', octoberLate + 1)
  store.settleBudget(late.installationId, 'global_late_october_001', 0, november + 2)
  assert.equal(database.prepare(
    'SELECT COALESCE(SUM(spent_nano + reserved_nano), 0) AS total FROM monthly_budgets WHERE month_key = ?',
  ).get('2026-11').total, 0, 'late October settlement remains outside the November aggregate')
  store.close()
  database.close()
  await rm(directory, { recursive: true, force: true })
})

await test('HTTP session, CORS, canonical provider request, final usage chunk, and no content persistence', async () => {
  const fixture = await createFixture()
  try {
    const issued = await issueSession(fixture, 'chrome-extension://test-extension')
    assert.equal(issued.response.status, 201)
    assert.equal(issued.response.headers.get('access-control-allow-origin'), 'chrome-extension://test-extension')
    assert.equal(typeof issued.token, 'string')
    assert.equal(typeof issued.body.installationId, 'string')
    assert.equal(typeof issued.body.installationSecret, 'string')
    const invalidRecovery = await fetch(fixture.baseUrl + '/api/v1/session/recover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: issued.body.installationId, installationSecret: 'x'.repeat(43) }),
    })
    assert.equal(invalidRecovery.status, 401)
    assert.equal((await invalidRecovery.json()).error.code, 'installation.invalid')
    const recovered = await fetch(fixture.baseUrl + '/api/v1/session/recover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: issued.body.installationId, installationSecret: issued.body.installationSecret }),
    })
    assert.equal(recovered.status, 201)
    const recoveredBody = await recovered.json()
    assert.equal(typeof recoveredBody.token, 'string')
    const claim = await fetch(fixture.baseUrl + '/api/v1/session/claim', {
      method: 'POST', headers: { Authorization: 'Bearer ' + issued.token },
    })
    assert.equal(claim.status, 200)
    const claimedBody = await claim.json()
    assert.equal(claimedBody.installationId, issued.body.installationId)
    assert.notEqual(claimedBody.installationSecret, issued.body.installationSecret)
    fixture.now += 1_000
    const renewed = await fetch(fixture.baseUrl + '/api/v1/session/renew', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + issued.token },
    })
    const renewedBody = await renewed.json()
    assert.equal(renewed.status, 200)
    assert.equal(renewedBody.token, issued.token)
    assert.ok(renewedBody.expiresAt > issued.body.expiresAt)

    const response = await postGeneration(fixture, issued.token, input(), { headers: { Origin: 'chrome-extension://test-extension' } })
    assert.equal(response.status, 200)
    const receivedEvents = events(await response.text())
    assert.equal(receivedEvents[0].event, 'context')
    assert.equal(receivedEvents[0].data.estimateHeadroom, 20_000)
    assert.equal(receivedEvents.some((event) => event.event === 'delta' && event.data.text === 'PROVIDER_OUTPUT_SENTINEL'), true)
    const complete = receivedEvents.find((event) => event.event === 'complete').data
    assert.equal(complete.status, 'complete')
    assert.equal(complete.usage.promptTokens, 23)
    assert.equal(complete.usage.completionTokens, 4)
    assert.equal(fixture.provider.requests.length, 1)
    const upstream = fixture.provider.requests[0]
    assert.equal(upstream.model, 'openai/gpt-6-luna')
    assert.equal('temperature' in upstream, false)
    assert.equal('reasoning' in upstream, false)
    assert.equal(upstream.max_tokens, 16_384)
    assert.equal(upstream.messages.some((message) => message.role === 'system'), true)
    assert.match(upstream.messages[0].content, /Use the supplied text, images, and relevant conversation history as the source of task-specific facts/)
    assert.equal(upstream.messages.at(-1).content, 'What is 2 + 2?')
    assert.equal(JSON.stringify(upstream).includes('client text must be replaced'), false)
    assert.equal(JSON.stringify(upstream).includes('HISTORICAL_TRANSCRIPT_SENTINEL'), true)

    const duplicate = await postGeneration(fixture, issued.token, input())
    assert.equal(duplicate.status, 409)
    assert.equal((await duplicate.json()).error.code, 'generation.already_started')
    const conflicting = await postGeneration(fixture, issued.token, input('request_00000001', { taskInput: 'different question' }))
    assert.equal(conflicting.status, 409)
    assert.equal((await conflicting.json()).error.code, 'generation.request_id_conflict')

    const denied = await fetch(fixture.baseUrl + '/api/v1/session', {
      method: 'POST',
      headers: { Origin: 'https://arbitrary-page.example' },
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.headers.get('access-control-allow-origin'), null)

    fixture.now += 10_000
    const imageUrl = png(1, 1)
    const imageResponse = await postGeneration(fixture, issued.token, input('request_00000002', {
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'client image turn' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ] }],
    }))
    assert.equal(imageResponse.status, 200)
    await imageResponse.text()
    const imageMessage = fixture.provider.requests[1].messages.at(-1)
    assert.equal(Array.isArray(imageMessage.content), true)
    assert.equal(imageMessage.content[0].text, 'What is 2 + 2?')
    assert.equal(imageMessage.content[1].image_url.url, imageUrl)

    await fixture.close()
    const databaseFiles = await readdir(fixture.directory)
    const persisted = Buffer.concat(await Promise.all(databaseFiles.map((name) => readFile(join(fixture.directory, name)))))
    assert.equal(persisted.includes(Buffer.from(issued.token)), false)
    assert.equal(persisted.includes(Buffer.from('HISTORICAL_TRANSCRIPT_SENTINEL')), false)
    assert.equal(persisted.includes(Buffer.from('PROVIDER_OUTPUT_SENTINEL')), false)
    assert.equal(persisted.includes(Buffer.from(imageUrl)), false)
    assert.equal(persisted.includes(Buffer.from('127.0.0.1')), false)
    assert.equal(JSON.stringify(fixture.logs).includes('HISTORICAL_TRANSCRIPT_SENTINEL'), false)
    assert.equal(JSON.stringify(fixture.logs).includes('PROVIDER_OUTPUT_SENTINEL'), false)
    assert.equal(JSON.stringify(fixture.logs).includes('FAKE_PROVIDER_KEY'), false)
  } finally {
    if (fixture.backend.server.listening) await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

function databaseFor(path) { return new DatabaseSync(path) }

await test('HTTP budget denies legacy sessions and reconciles missing SSE usage before a new paid request', async () => {
  const fixture = await createFixture({
    responder: async ({ request, response, body, requests }) => {
      if (request.method === 'GET') {
        const id = new URL(request.url, 'http://provider.invalid').searchParams.get('id')
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ data: {
          id, model: 'openai/gpt-6-luna', finish_reason: 'stop', generation_time: 1, total_cost: 0.0123456781,
        } }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Generation-Id': 'gen-local-usage' })
      response.end(
        sse({ id: 'gen-local-usage', model: 'openai/gpt-6-luna', choices: [{ delta: { content: 'answer' }, finish_reason: null }] }) +
        sse({ id: 'gen-local-usage', model: 'openai/gpt-6-luna', choices: [{ delta: {}, finish_reason: 'stop' }] }) +
        'data: [DONE]\n\n',
      )
    },
  })
  try {
    const issued = await issueSession(fixture)
    const database = new DatabaseSync(fixture.config.databasePath)
    // Exercise the old bearer path by detaching its durable subject in place.
    const sessionId = database.prepare('SELECT id FROM sessions ORDER BY created_at LIMIT 1').get().id
    database.prepare('UPDATE sessions SET installation_id = NULL WHERE id = ?').run(sessionId)
    const legacy = await postGeneration(fixture, issued.token, input('legacy_no_identity'))
    assert.equal(legacy.status, 401)
    assert.equal((await legacy.json()).error.code, 'installation.required')
    database.prepare('UPDATE sessions SET installation_id = ? WHERE id = ?').run(issued.body.installationId, sessionId)
    database.close()

    const first = await postGeneration(fixture, issued.token, input('usage_missing_0001'))
    assert.equal(first.status, 200)
    await first.text()
    const pending = databaseFor(fixture.config.databasePath)
    const charge = pending.prepare('SELECT status, provider_generation_id FROM budget_charges WHERE request_id = ?')
      .get('usage_missing_0001')
    assert.equal(charge.status, 'held')
    assert.equal(charge.provider_generation_id, 'gen-local-usage')
    fixture.now += 10_000
    const second = await postGeneration(fixture, issued.token, input('usage_missing_0002'))
    assert.equal(second.status, 200)
    await second.text()
    const settled = pending.prepare('SELECT status, charged_nano FROM budget_charges WHERE request_id = ?')
      .get('usage_missing_0001')
    assert.equal(settled.status, 'settled')
    assert.equal(settled.charged_nano, 12_345_679)
    assert.equal(fixture.provider.requests.some((entry) => entry.method === 'GET' && entry.url.includes('/generation?id=gen-local-usage')), true)
    pending.close()
  } finally {
    await fixture.close()
  }
})

await test('global monthly reserve aggregates installations atomically and survives database reopen', async () => {
  const fixture = await createFixture({
    responder: async ({ request, response }) => {
      if (request.method === 'GET') {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end('{}')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Generation-Id': 'gen-global-held' })
      response.end(
        sse({ id: 'gen-global-held', model: 'openai/gpt-6-luna', choices: [{ delta: { content: 'answer' }, finish_reason: null }] }) +
        sse({ id: 'gen-global-held', model: 'openai/gpt-6-luna', choices: [{ delta: {}, finish_reason: 'stop' }] }) +
        'data: [DONE]\n\n',
      )
    },
  })
  try {
    const first = await issueSession(fixture)
    const second = await issueSession(fixture)
    const third = await issueSession(fixture)
    const database = databaseFor(fixture.config.databasePath)
    const monthKey = new Date(fixture.now).toISOString().slice(0, 7)
    const priorMonthInstallations = Array.from({ length: 20 }, (_, index) =>
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`)
    const monthlyWalletInsert = database.prepare(
      'INSERT INTO monthly_budgets(installation_id, month_key, spent_nano, reserved_nano) VALUES (?, ?, ?, 0)',
    )
    for (const id of priorMonthInstallations) monthlyWalletInsert.run(id, monthKey, 4_986_250_000)
    const previousMonthDate = new Date(monthKey + '-01T00:00:00.000Z')
    previousMonthDate.setUTCMonth(previousMonthDate.getUTCMonth() - 1)
    const previousMonth = previousMonthDate.toISOString().slice(0, 7)
    const previousMonthInstallations = Array.from({ length: 20 }, (_, index) =>
      `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 1).padStart(12, '0')}`)
    for (const id of previousMonthInstallations) monthlyWalletInsert.run(id, previousMonth, 5_000_000_000)

    const concurrent = await Promise.all([
      postGeneration(fixture, first.token, input('global_race_install_1')),
      postGeneration(fixture, second.token, input('global_race_install_2')),
    ])
    const statuses = concurrent.map(response => response.status).sort()
    assert.deepEqual(statuses, [200, 429], 'only one installation can reserve the final $0.275')
    const denied = concurrent.find(response => response.status === 429)
    const deniedBody = await denied.json()
    assert.equal(deniedBody.error.code, 'budget.service_exhausted')
    assert.equal(deniedBody.error.resetAt, Date.UTC(
      Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)), 1,
    ))
    const accepted = concurrent.find(response => response.status === 200)
    await accepted.text()
    const providerPosts = fixture.provider.requests.filter(entry => entry.method === 'POST')
    assert.equal(providerPosts.length, 1)
    database.close()
    await fixture.backend.close()
    fixture.backend = createBackend(fixture.config, {
      now: () => fixture.now,
      log: (entry) => fixture.logs.push(entry),
      providerBaseUrl: fixture.provider.baseUrl,
    })
    await new Promise((resolve) => fixture.backend.server.listen(0, '127.0.0.1', resolve))
    fixture.baseUrl = 'http://127.0.0.1:' + fixture.backend.server.address().port
    const reopened = databaseFor(fixture.config.databasePath)
    const persisted = reopened.prepare(
      'SELECT COALESCE(SUM(spent_nano + reserved_nano), 0) AS total FROM monthly_budgets WHERE month_key = ?',
    ).get(monthKey)
    assert.equal(persisted.total, 100_000_000_000, 'held reservation persists after restarting the backend and reopening SQLite')
    assert.equal(reopened.prepare(
      'SELECT COALESCE(SUM(spent_nano + reserved_nano), 0) AS total FROM monthly_budgets WHERE month_key = ?',
    ).get(previousMonth).total, 100_000_000_000, 'older-month settlement ledger remains isolated from this month')
    reopened.close()

    const noCapacity = await postGeneration(fixture, third.token, input('global_denied_install_3'))
    assert.equal(noCapacity.status, 429)
    assert.equal((await noCapacity.json()).error.code, 'budget.service_exhausted')
    assert.equal(fixture.provider.requests.filter(entry => entry.method === 'POST').length, 1)
  } finally {
    await fixture.close()
  }
})

await test('provider context-length rejection is explicit, redacted, and never falls back', async () => {
  const fixture = await createFixture({
    responder: async ({ response }) => {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 400, metadata: { error_type: 'context_length_exceeded' }, message: 'PRIVATE_PROVIDER_DETAIL' } }))
    },
  })
  try {
    const session = await issueSession(fixture)
    const response = await postGeneration(fixture, session.token, input())
    const emitted = events(await response.text())
    const error = emitted.find((event) => event.event === 'error').data
    assert.equal(error.code, 'provider.context_too_large')
    assert.equal(error.partial, false)
    assert.equal(JSON.stringify(error).includes('PRIVATE_PROVIDER_DETAIL'), false)
    assert.equal(fixture.provider.requests.length, 1)
  } finally {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

await test('HTTP 200 OpenRouter SSE context rejection is typed and never falls back', async () => {
  const fixture = await createFixture({
    responder: async ({ response }) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(sse({ error: { code: 400, metadata: { error_type: 'context_length_exceeded' }, message: 'PRIVATE_PROVIDER_DETAIL' } }))
    },
  })
  try {
    const session = await issueSession(fixture)
    const response = await postGeneration(fixture, session.token, input())
    const emitted = events(await response.text())
    const error = emitted.find((event) => event.event === 'error').data
    assert.equal(error.code, 'provider.context_too_large')
    assert.equal(error.partial, false)
    assert.equal(JSON.stringify(error).includes('PRIVATE_PROVIDER_DETAIL'), false)
    assert.equal(fixture.provider.requests.length, 1)
  } finally {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

await test('HTTP forwarding uses X-Forwarded-For only from explicitly trusted peers', async () => {
  const untrusted = await createFixture()
  try {
    for (let index = 0; index < 20; index++) {
      const issued = await issueSession(untrusted, undefined, { 'X-Forwarded-For': `198.51.100.${index + 1}` })
      assert.equal(issued.response.status, 201)
    }
    const spoofed = await issueSession(untrusted, undefined, { 'X-Forwarded-For': '203.0.113.99' })
    assert.equal(spoofed.response.status, 429)
  } finally {
    await untrusted.close()
    await rm(untrusted.directory, { recursive: true, force: true })
  }

  const trusted = await createFixture({ trustedProxyIps: ['127.0.0.1'] })
  try {
    for (let index = 0; index < 20; index++) {
      const issued = await issueSession(trusted, undefined, { 'X-Forwarded-For': '198.51.100.7' })
      assert.equal(issued.response.status, 201)
    }
    for (let index = 0; index < 20; index++) {
      const issued = await issueSession(trusted, undefined, { 'X-Forwarded-For': '203.0.113.8' })
      assert.equal(issued.response.status, 201)
    }
    const limitedA = await issueSession(trusted, undefined, { 'X-Forwarded-For': '198.51.100.7' })
    const limitedB = await issueSession(trusted, undefined, { 'X-Forwarded-For': '203.0.113.8' })
    assert.equal(limitedA.response.status, 429)
    assert.equal(limitedB.response.status, 429)
    for (let index = 0; index < 20; index++) {
      const malformed = await issueSession(trusted, undefined, { 'X-Forwarded-For': 'not-an-ip' })
      assert.equal(malformed.response.status, 201)
    }
    const malformedFallsBackToPeer = await issueSession(trusted, undefined, { 'X-Forwarded-For': 'not-an-ip' })
    assert.equal(malformedFallsBackToPeer.response.status, 429)
    const boundedChain = await issueSession(trusted, undefined, { 'X-Forwarded-For': Array.from({ length: 9 }, (_, index) => `192.0.2.${index + 1}`).join(',') })
    assert.equal(boundedChain.response.status, 429)
    const overlong = await issueSession(trusted, undefined, { 'X-Forwarded-For': '1'.repeat(513) })
    assert.equal(overlong.response.status, 429)
  } finally {
    await trusted.close()
    await rm(trusted.directory, { recursive: true, force: true })
  }
})

await test('malformed, oversized, image, client-system, and client-parameter requests fail before admission', async () => {
  const fixture = await createFixture()
  try {
    const session = await issueSession(fixture)
    const invalidJson = await postGeneration(fixture, session.token, null, { rawBody: '{' })
    assert.equal(invalidJson.status, 400)
    const systemRole = await postGeneration(fixture, session.token, input('badrole_0000001', {
      messages: [{ role: 'system', content: 'client system' }, { role: 'user', content: 'q' }],
    }))
    assert.equal(systemRole.status, 400)
    const clientModel = await postGeneration(fixture, session.token, { ...input('badmodel_000001'), model: 'untrusted/model' })
    assert.equal(clientModel.status, 400)
    const externalImage = await postGeneration(fixture, session.token, input('badimage_000001', {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/i.png' } }] }],
    }))
    assert.equal(externalImage.status, 400)
    const impossibleImage = await postGeneration(fixture, session.token, input('badpng_0000001', {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: png(16_385, 1) } }] }],
    }))
    assert.equal(impossibleImage.status, 400)
    const oversizedImageUrl = 'data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')
    const oversizedImage = await postGeneration(fixture, session.token, input('oversizeimage_01', {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: oversizedImageUrl } }] }],
    }))
    assert.equal(oversizedImage.status, 413)
    assert.equal((await oversizedImage.json()).error.code, 'image.too_large')
    const textBudget = await postGeneration(fixture, session.token, input('textbudget_00001', {
      messages: [{ role: 'assistant', content: 'x'.repeat(720_000) }, { role: 'user', content: 'q' }],
    }))
    assert.equal(textBudget.status, 422)
    assert.equal((await textBudget.json()).error.code, 'context.too_large')
    const imageBudget = await postGeneration(fixture, session.token, input('imagebudget_0001', {
      messages: [{ role: 'user', content: Array.from({ length: 176 }, () => ({
        type: 'image_url', image_url: { url: png(1, 1) },
      })) }],
    }))
    assert.equal(imageBudget.status, 422)
    assert.equal((await imageBudget.json()).error.code, 'context.too_large')
    assert.equal(fixture.provider.requests.length, 0)

    const oversizedBody = JSON.stringify(input('too_large_000001', {
      taskInput: 'x'.repeat(32 * 1024 * 1024),
    }))
    const oversized = await postGeneration(fixture, session.token, null, { rawBody: oversizedBody })
    assert.equal(oversized.status, 413)
    assert.equal(fixture.provider.requests.length, 0)

    const allowedAfterInvalid = await postGeneration(fixture, session.token, input('request_00000002'))
    assert.equal(allowedAfterInvalid.status, 200)
    await allowedAfterInvalid.text()
  } finally {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

await test('unavailable Luna surfaces an error without a second model attempt', async () => {
  for (const status of [404, 429, 503]) {
    const unavailable = await createFixture({
      responder: async ({ response }) => {
        response.writeHead(status)
        response.end('PROVIDER_BODY_SECRET')
      },
    })
    try {
      const session = await issueSession(unavailable)
      const response = await postGeneration(unavailable, session.token, input())
      const emitted = events(await response.text())
      const error = emitted.find((event) => event.event === 'error').data
      assert.equal(error.code, status === 429 ? 'provider.rate_limited' : 'provider.unavailable')
      assert.equal(emitted.some((event) => event.event === 'fallback'), false)
      assert.equal(unavailable.provider.requests.length, 1)
      assert.equal(unavailable.provider.requests[0].model, 'openai/gpt-6-luna')
      assert.equal(unavailable.provider.requests[0].max_tokens, 16_384)
      assert.equal('temperature' in unavailable.provider.requests[0], false)
      assert.equal('reasoning' in unavailable.provider.requests[0], false)
    } finally {
      await unavailable.close()
      await rm(unavailable.directory, { recursive: true, force: true })
    }
  }

  const auth = await createFixture({
    responder: async ({ response }) => {
      response.writeHead(401, { 'Content-Type': 'text/plain' })
      response.end('PROVIDER_BODY_SECRET')
    },
  })
  try {
    const session = await issueSession(auth)
    const response = await postGeneration(auth, session.token, input())
    const emitted = events(await response.text())
    const error = emitted.find((event) => event.event === 'error').data
    assert.equal(error.code, 'provider.auth')
    assert.equal(error.partial, false)
    assert.equal(JSON.stringify(error).includes('PROVIDER_BODY_SECRET'), false)
    assert.equal(auth.provider.requests.length, 1)
  } finally {
    await auth.close()
    await rm(auth.directory, { recursive: true, force: true })
  }

  const partial = await createFixture({
    responder: async ({ response }) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(sse({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }))
      setTimeout(() => response.destroy(), 10)
    },
  })
  try {
    const session = await issueSession(partial)
    const response = await postGeneration(partial, session.token, input())
    const emitted = events(await response.text())
    assert.equal(emitted.some((event) => event.event === 'delta' && event.data.text === 'partial'), true)
    const error = emitted.find((event) => event.event === 'error').data
    assert.equal(error.partial, true)
    assert.equal(emitted.some((event) => event.event === 'fallback'), false)
    assert.equal(partial.provider.requests.length, 1)
  } finally {
    await partial.close()
    await rm(partial.directory, { recursive: true, force: true })
  }
})

await test('in-flight/session/global admission races, timeout, disconnect cancellation, and expiry', async () => {
  let abortedUpstream = 0
  const hang = async ({ response }) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.flushHeaders()
    response.once('close', () => { if (!response.writableEnded) abortedUpstream++ })
  }
  const fixture = await createFixture({ responder: hang, timeoutMs: 120 })
  try {
    const first = await issueSession(fixture)
    const inFlightResponse = await postGeneration(fixture, first.token, input())
    assert.equal(inFlightResponse.status, 200)
    const duplicate = await postGeneration(fixture, first.token, input())
    assert.equal(duplicate.status, 409)
    assert.equal((await duplicate.json()).error.code, 'generation.already_started')
    const other = await postGeneration(fixture, first.token, input('request_00000002'))
    assert.equal(other.status, 409)
    assert.equal((await other.json()).error.code, 'generation.in_progress')
    const timeoutEvents = events(await inFlightResponse.text())
    assert.equal(timeoutEvents.find((event) => event.event === 'error').data.code, 'generation.timeout')

    const timeoutSession = await issueSession(fixture)
    const timeoutResponse = await postGeneration(fixture, timeoutSession.token, input('request_00000003'))
    assert.equal(timeoutResponse.status, 200)
    assert.equal(events(await timeoutResponse.text()).find((event) => event.event === 'error').data.code, 'generation.timeout')

    const expirySession = await issueSession(fixture)
    const renewed = await fetch(fixture.baseUrl + '/api/v1/session/renew', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + expirySession.token },
    })
    assert.equal(renewed.status, 200)
    fixture.now += 31 * 24 * 60 * 60 * 1_000
    const expired = await fetch(fixture.baseUrl + '/api/v1/session/renew', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + expirySession.token },
    })
    assert.equal(expired.status, 401)
  } finally {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }

  const capacity = await createFixture({ responder: hang, timeoutMs: 20_000 })
  try {
    const sessions = []
    for (let index = 0; index < 5; index++) sessions.push(await issueSession(capacity))
    const responses = await Promise.all(sessions.slice(0, 4).map((session, index) =>
      postGeneration(capacity, session.token, input('active_0000000' + index))))
    await waitFor(() => capacity.provider.requests.length === 4, 'four active upstream requests')
    const rejected = await postGeneration(capacity, sessions[4].token, input('active_00000004'))
    assert.equal(rejected.status, 429)
    assert.equal((await rejected.json()).error.code, 'generation.capacity')
    await Promise.all(responses.map((response) => response.body.cancel()))
  } finally {
    await capacity.close()
    await rm(capacity.directory, { recursive: true, force: true })
  }

  const cancellation = await createFixture({ responder: hang, timeoutMs: 20_000 })
  try {
    const previousAbortCount = abortedUpstream
    const session = await issueSession(cancellation)
    const response = await postGeneration(cancellation, session.token, input())
    const reader = response.body.getReader()
    let sawContext = false
    while (!sawContext) {
      const { done, value } = await reader.read()
      if (done) break
      sawContext ||= new TextDecoder().decode(value).includes('event: context')
    }
    await reader.cancel()
    await waitFor(() => abortedUpstream > previousAbortCount, 'upstream cancellation on client disconnect')
  } finally {
    await cancellation.close()
    await rm(cancellation.directory, { recursive: true, force: true })
  }
})

await test('backend shutdown waits for an aborted operation to finalize SQLite state', async () => {
  let upstreamStarted = false
  const fixture = await createFixture({
    responder: async ({ response }) => {
      upstreamStarted = true
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.flushHeaders()
    },
    timeoutMs: 20_000,
  })
  try {
    const session = await issueSession(fixture)
    const response = await postGeneration(fixture, session.token, input())
    const reader = response.body.getReader()
    let sawContext = false
    while (!sawContext) {
      const { done, value } = await reader.read()
      if (done) break
      sawContext ||= new TextDecoder().decode(value).includes('event: context')
    }
    assert.equal(sawContext, true)
    await waitFor(() => upstreamStarted, 'upstream request before shutdown')
    await fixture.backend.close()
    const database = new DatabaseSync(join(fixture.directory, 'state.sqlite'))
    const row = database.prepare('SELECT status FROM operations WHERE request_id = ?').get('request_00000001')
    assert.equal(row.status, 'cancelled')
    database.close()
    await fixture.provider.close()
  } finally {
    if (fixture.backend.server.listening) await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

await vite.close()
if (failed) process.exitCode = 1
else console.log('Backend contract suite passed.')
