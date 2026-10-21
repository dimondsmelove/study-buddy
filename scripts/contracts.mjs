// Source-level contracts run without credentials, a build or external requests.
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const stored = { settings: {} }
const runtime = vm.createContext({
  console, URL, Blob, Response, ReadableStream, TextEncoder, TextDecoder, AbortController, DOMException,
  structuredClone, setTimeout, clearTimeout,
  __SB_GATEWAY_URL__: 'https://gateway.test',
  chrome: { storage: { local: {
    get: async () => structuredClone(stored),
    set: async (value) => Object.assign(stored, structuredClone(value)),
    remove: async (key) => { delete stored[key] },
  } } },
  fetch: () => { throw new Error('Unexpected network request in contract test') },
})
const modules = new Map()
function load(file) {
  const path = resolve(root, file)
  if (modules.has(path)) return modules.get(path).exports
  const module = { exports: {} }
  modules.set(path, module)
  const require = (name) => {
    assert(name.startsWith('.'), `Unexpected dependency ${name}`)
    const base = resolve(dirname(path), name)
    return load(existsSync(`${base}.ts`) ? `${base}.ts` : `${base}/index.ts`)
  }
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInContext(`(function(require,module,exports){${code}\n})`, runtime, { filename: path })(require, module, module.exports)
  return module.exports
}

const plain = (value) => JSON.parse(JSON.stringify(value))
const settings = load('src/shared/settings.ts')
const i18n = load('src/shared/i18n.ts')
assert.equal(i18n.t('en', 'dialog.deleteError'), "Couldn't delete this chat. Try again.")
assert.equal(i18n.t('ru', 'dialog.deleteError'), 'Не удалось удалить чат. Попробуйте ещё раз.')
assert.equal(i18n.t('en', 'dialog.denied'), 'This action is unavailable.')
assert.equal(i18n.t('ru', 'dialog.denied'), 'Это действие недоступно.')
assert.equal(settings.DEFAULT_SETTINGS.uiLanguage, 'en')
assert.equal(settings.DEFAULT_SETTINGS.answerLanguage, 'en')
for (const value of [null, 'old', { apiKey: 42, uiLanguage: 'bad' }, { apiKey: 'legacy-secret', uiLanguage: 'ru', model: 'old' }]) {
  stored.settings = value
  const got = await settings.getSettings()
  assert.deepEqual(plain(got), { uiLanguage: value?.uiLanguage === 'ru' ? 'ru' : 'en', answerLanguage: 'en' })
  assert.deepEqual(plain(stored.settings), plain(got), 'legacy provider fields are removed from extension storage')
}
stored.settings = settings.DEFAULT_SETTINGS
runtime.chrome.storage.local.get = async () => { throw new Error('fixture storage failure') }
await assert.rejects(settings.getSettings(), /storage.read/)
runtime.chrome.storage.local.get = async () => structuredClone(stored)
const previousSettings = structuredClone(stored.settings)
runtime.chrome.storage.local.set = async () => { throw new Error('fixture write failure') }
await assert.rejects(settings.setSettings({ ...settings.DEFAULT_SETTINGS, uiLanguage: 'ru' }), /fixture write failure/)
assert.deepEqual(plain(stored.settings), plain(previousSettings))
runtime.chrome.storage.local.set = async (value) => Object.assign(stored, structuredClone(value))
console.log('SETTINGS CONTRACTS OK — language-only defaults, legacy credential removal, malformed records and storage failures')

const titles = load('src/shared/title.ts')
const envelope = '[[STUDY_BUDDY_TITLE]]Linear equations\nSolve 2x + 3 = 7.'
for (let boundary = 0; boundary <= envelope.length; boundary++) {
  const parser = titles.createResponseTitleParser()
  const shown = parser.push(envelope.slice(0, boundary)) + parser.push(envelope.slice(boundary))
  const tail = parser.finish()
  assert.equal(shown + tail.text, 'Solve 2x + 3 = 7.')
  assert.equal(tail.title ?? parser.title, 'Linear equations')
}
{
  const parser = titles.createResponseTitleParser()
  const text = 'ordinary answer 😀'
  assert.equal(parser.push(text.slice(0, 4)) + parser.push(text.slice(4)), text)
  assert.equal(parser.finish().text, '')
  assert.equal(parser.title, undefined)
}
for (const value of ['', 'x'.repeat(81)]) {
  const parser = titles.createResponseTitleParser()
  assert.equal(parser.push(`[[STUDY_BUDDY_TITLE]]${value}\nanswer`), 'answer')
  assert.equal(parser.title, undefined)
}
{
  const candidate = 'x'.repeat(700)
  const parser = titles.createResponseTitleParser()
  parser.push(`[[STUDY_BUDDY_TITLE]]${candidate}`)
  assert.equal(parser.finish().text, candidate)
}
for (const partial of ['[[STUDY_BUDDY_TIT', '[[STUDY_BUDDY_TITLE]]Linear equations']) {
  const parser = titles.createResponseTitleParser()
  assert.equal(parser.push(partial), '')
  const tail = parser.finish()
  assert.equal(tail.text, partial.startsWith('[[STUDY_BUDDY_TITLE]]') ? 'Linear equations' : '')
  assert.equal(tail.title, undefined)
}
const fallbackTitle = titles.normalizeGeneratedTitle('  Linear equations\n')
assert.equal(fallbackTitle, 'Linear equations')
const display = load('src/shared/conversations.ts').conversationDisplayTitle
assert.equal(display({ title: 'Solve', createdAt: 1, turns: [{ role: 'user', input: 'A question about fractions', createdAt: 2 }] }, 'New chat'), 'A question about fractions')
assert.equal(display({ title: 'Study Buddy', createdAt: 1, turns: [{ role: 'assistant', text: 'Answer\nFactor x² - 9.', createdAt: 2 }] }, 'New chat'), 'Factor x² - 9.')
assert.equal(display({ title: 'Hint', createdAt: 1, turns: [{ role: 'assistant', text: 'Answer: 84 km/h', createdAt: 2 }] }, 'New chat'), 'Answer: 84 km/h')
assert.equal(display({ title: 'Проверить попытку', createdAt: 1, turns: [{ role: 'assistant', text: 'Ответ\nДелим обе части на 2.', createdAt: 2 }] }, 'Новый чат'), 'Делим обе части на 2.')

const api = load('src/shared/api.ts')
const ai = load('src/shared/ai.ts')
const gateway = load('src/shared/gateway.ts')
const models = load('src/shared/models.ts')
const fixtureSettings = {
  ...settings.DEFAULT_SETTINGS,
  provider: 'custom',
  apiKey: 'fixture-secret-key',
  baseUrl: 'https://fixture.test/private-endpoint',
}
const messages = [{ role: 'user', content: 'fixture-private-request' }]
const encoder = new TextEncoder()
const frame = (choice) => `data: ${JSON.stringify({ choices: [choice] })}\n\n`
const payload = (body) => `data: ${JSON.stringify(body)}\n\n`
const delta = (text) => frame({ delta: { content: text } })
const finish = (reason) => frame({ delta: {}, finish_reason: reason })
const done = 'data: [DONE]\n\n'
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})
function streamResponse(text, { width = 4096, failure, headers = {} } = {}) {
  const bytes = encoder.encode(text)
  let offset = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + width))
        offset += width
      } else if (failure) controller.error(failure)
      else controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream', ...headers } })
}
function stubFetch(handler) {
  const requests = []
  runtime.fetch = async (url, init) => {
    assert(url.startsWith(fixtureSettings.baseUrl), 'Only the synthetic endpoint is allowed')
    requests.push({ url, ...init, body: init?.body && JSON.parse(init.body) })
    return handler(requests.at(-1), requests.length)
  }
  return requests
}
const complete = (extra = {}) => api.chatCompletion({
  settings: fixtureSettings, model: 'fixture-model', messages, ...extra,
})
const ask = (extra = {}) => ai.askWithFallback({ settings: fixtureSettings, messages, ...extra })
const expected = (text, status, finishReason, model = 'fixture-model', usage) => ({
  text, status, ...(finishReason !== undefined ? { finishReason } : {}),
  ...(model ? { model } : {}), ...(usage ? { usage } : {}),
})
const sensitive = [fixtureSettings.apiKey, fixtureSettings.baseUrl, messages[0].content, 'fixture-authorization']
function safeError(error, kind, status) {
  assert(error instanceof api.ApiError)
  assert.equal(error.kind, kind)
  if (status !== undefined) assert.equal(error.status, status)
  for (const secret of sensitive) assert(!error.message.includes(secret), `Error exposed ${secret}`)
  return true
}
let apiCases = 0
async function contract(name, check) {
  await check()
  apiCases++
  console.log(`  ✓ ${name}`)
}

await contract('SSE UTF-8, CRLF, comments, role and multi-line events at byte/chunk boundaries', async () => {
  const text = ': heartbeat\r\nid: fixture\r\nevent: message\r\n' +
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n' +
    'data: {"choices": [\r\ndata: {"delta":{"content":"Привет 🧪"}}\r\ndata: ]}\r\n\r\n' +
    finish('stop') + done
  for (const width of [1, 2, 3, 5, 17, 4096]) {
    const deltas = []
    stubFetch(() => streamResponse(text, { width }))
    assert.deepEqual(plain(await complete({ onDelta: (value) => deltas.push(value) })), expected('Привет 🧪', 'complete', 'stop'))
    assert.equal(deltas.join(''), 'Привет 🧪')
  }
})
await contract('provider spend cap, generation ID capture, and rejection provenance', async () => {
  const id = 'gen_contract_0123'
  const ids = []
  const accepted = []
  const requests = stubFetch(() => streamResponse(
    payload({ id, choices: [{ delta: { content: 'answer' }, finish_reason: null }] }) +
      payload({ id, choices: [{ delta: {}, finish_reason: 'stop' }] }) +
      payload({ id, choices: [], usage: { cost: 0.001 } }) + done,
    { headers: { 'x-generation-id': id } },
  ))
  const result = await complete({
    onProviderGenerationId: value => ids.push(value),
    onProviderResponseAccepted: () => accepted.push(true),
  })
  assert.equal(result.usage.cost, 0.001)
  assert.deepEqual(ids, [id], 'header and repeated stream IDs persist once')
  assert.deepEqual(accepted, [true])
  assert.deepEqual(plain(requests[0].body.provider), {
    max_price: { prompt: 0.25, completion: 0.75, request: 0, image: 0 },
  })

  let acceptedRejected = false
  stubFetch(() => jsonResponse({}, 402))
  await assert.rejects(complete({ onProviderResponseAccepted: () => { acceptedRejected = true } }), error => {
    assert.equal(error.definitiveRejection, true)
    return true
  })
  assert.equal(acceptedRejected, false)

  let streamAccepted = false
  stubFetch(() => streamResponse('event: error\ndata: {"error":{"code":"provider_error"}}\n\n'))
  await assert.rejects(complete({ onProviderResponseAccepted: () => { streamAccepted = true } }), error => {
    assert.equal(error.definitiveRejection, false)
    return true
  })
  assert.equal(streamAccepted, true)
})

await contract('stop, length, DONE, usage-only events, CR-only lines and final line without newline', async () => {
  for (const [text, result] of [
    [delta('answer') + finish('stop'), expected('answer', 'complete', 'stop')],
    [delta('partial') + finish('length') + done, expected('partial', 'truncated', 'length')],
    [delta('answer') + 'data: {"choices":[],"usage":{"total_tokens":2}}\n\n' + done, expected('answer', 'complete')],
    [(delta('answer') + finish('stop') + done).replaceAll('\n', '\r'), expected('answer', 'complete', 'stop')],
    [delta('answer') + 'data: [DONE]', expected('answer', 'complete')],
    [delta('answer') + done + 'data: malformed\n\n', expected('answer', 'complete')],
  ]) {
    stubFetch(() => streamResponse(text, { width: 1 }))
    assert.deepEqual(plain(await complete()), result)
  }
})
await contract('normal empty terminal and empty non-terminal EOF remain distinct', async () => {
  for (const [text, result] of [
    [finish('stop'), expected('', 'empty', 'stop')],
    [done, expected('', 'empty')],
    ['', expected('', 'interrupted')],
    [delta('partial'), expected('partial', 'interrupted')],
    [delta('partial') + finish('unknown'), expected('partial', 'interrupted', 'unknown')],
  ]) {
    stubFetch(() => streamResponse(text))
    assert.deepEqual(plain(await complete()), result)
  }
})
await contract('malformed SSE cannot assert complete and keeps text on both sides of the bad event', async () => {
  for (const bad of ['{broken', 'null', '42', '{"choices":{}}', '{"choices":[null]}',
    '{"choices":[{}]}', '{"choices":[{"delta":"bad"}]}', '{"choices":[{"delta":{"content":42}}]}']) {
    const deltas = []
    stubFetch(() => streamResponse(delta('before ') + `data: ${bad}\n\n` + delta('after') + finish('stop') + done))
    assert.deepEqual(plain(await complete({ onDelta: (value) => deltas.push(value) })), expected('before after', 'interrupted', 'stop'))
    assert.equal(deltas.join(''), 'before after')
  }
  let text = ''
  stubFetch(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(delta('partial')))
      controller.enqueue(new Uint8Array([0xff]))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } }))
  await assert.rejects(complete({ onDelta: (value) => { text += value } }),
    (error) => safeError(error, 'interrupted'))
  assert.equal(text, 'partial')
})
await contract('HTTP 200 provider errors and error finish reasons retain typed provider errors', async () => {
  for (const response of [
    () => streamResponse(delta('partial') + 'data: {"error":{"code":503,"message":"fixture-secret-key fixture-private-request"}}\n\n'),
    () => streamResponse(delta('partial') + 'event: error\ndata: {"message":"fixture-secret-key"}\n\n'),
    () => streamResponse(delta('partial') + finish('error')),
    () => streamResponse(delta('partial') + finish('content_filter')),
    () => jsonResponse({ error: { message: sensitive.join(' ') } }),
    () => jsonResponse({ choices: [{ message: { content: 'partial' }, finish_reason: 'error' }] }),
    () => jsonResponse({ choices: [{ finish_reason: 'error' }] }),
  ]) {
    stubFetch(response)
    await assert.rejects(complete(), (error) => safeError(error, 'provider'))
  }
})
await contract('whole JSON tracks terminal status and flattens only existing typed text parts', async () => {
  for (const [content, reason, result] of [
    ['answer', 'stop', expected('answer', 'complete', 'stop')],
    [[{ type: 'text', text: 'one ' }, { type: 'image_url', image_url: { url: 'fixture' } }, { type: 'text', text: 'two' }], 'stop', expected('one two', 'complete', 'stop')],
    ['partial', 'length', expected('partial', 'truncated', 'length')],
    ['', 'stop', expected('', 'empty', 'stop')],
    [null, 'stop', expected('', 'empty', 'stop')],
    ['partial', undefined, expected('partial', 'interrupted')],
  ]) {
    const deltas = []
    stubFetch(() => jsonResponse({ model: 'routed-json-model', usage: { prompt_tokens: 12, completion_tokens: 4 }, choices: [{ message: { content }, finish_reason: reason }] }))
    const expectedResult = { ...result, model: 'routed-json-model', usage: { promptTokens: 12, completionTokens: 4 } }
    assert.deepEqual(plain(await complete({ onDelta: (value) => deltas.push(value) })), expectedResult)
    assert.equal(deltas.join(''), result.text)
  }
  for (const response of [
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => jsonResponse({ choices: [{ message: {} }] }),
    () => jsonResponse(null),
  ]) {
    stubFetch(response)
    await assert.rejects(complete(), (error) => safeError(error, 'response'))
  }
})
await contract('cancelled requests and reader failures stay typed and retain emitted partial text', async () => {
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  const requests = stubFetch(() => { throw new Error('An already aborted request must not fetch') })
  await assert.rejects(complete({ signal: alreadyAborted.signal }), (error) => safeError(error, 'aborted'))
  assert.equal(requests.length, 0)
  stubFetch(() => { throw new DOMException('fixture-secret-key', 'AbortError') })
  await assert.rejects(complete(), (error) => safeError(error, 'aborted'))
  for (const response of [
    () => streamResponse(delta('partial') + done),
    () => jsonResponse({ choices: [{ message: { content: 'partial' }, finish_reason: 'stop' }] }),
  ]) {
    const controller = new AbortController()
    stubFetch(response)
    await assert.rejects(complete({ signal: controller.signal, onDelta: () => controller.abort() }),
      (error) => safeError(error, 'aborted'))
  }
  for (const [failure, kind] of [
    [new DOMException('fixture-secret-key', 'AbortError'), 'aborted'],
    [new Error('fixture-secret-key fixture-private-request'), 'interrupted'],
  ]) {
    let text = ''
    stubFetch(() => streamResponse(delta('partial'), { failure }))
    await assert.rejects(complete({ onDelta: (value) => { text += value } }), (error) => safeError(error, kind))
    assert.equal(text, 'partial')
  }
})
await contract('HTTP and network errors redact provider prose, headers, request text and private URL for chat and models', async () => {
  for (const [status, kind] of [[401, 'auth'], [402, 'credits'], [403, 'auth'], [404, 'http'], [429, 'rate'], [503, 'http']]) {
    stubFetch(() => jsonResponse({ error: { message: sensitive.join(' ') } }, status))
    await assert.rejects(complete(), (error) => safeError(error, kind, status))
    await assert.rejects(models.fetchVisionModels(fixtureSettings), (error) => safeError(error, kind, status))
  }
  stubFetch(() => { throw new Error(sensitive.join(' ')) })
  await assert.rejects(complete(), (error) => safeError(error, 'network'))
  await assert.rejects(models.fetchVisionModels(fixtureSettings), (error) => safeError(error, 'network'))
  const error = await api.apiHttpError(new Response('fixture-secret-key', { status: 500, statusText: sensitive.join(' ') }))
  safeError(error, 'http', 500)
})
await contract('shared gateway body sizing counts UTF-8 JSON including encoded image URLs', async () => {
  const protocol = load('src/shared/gateway-protocol.ts')
  const request = {
    requestId: '00000000-0000-4000-8000-000000000000', task: 'ask', answerLanguage: 'ru', uiLanguage: 'ru', titleNeeded: false,
    taskInput: 'вопрос 😀', messages: [{ role: 'user', content: [{ type: 'text', text: 'вопрос 😀' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(12_000) } }] }],
  }
  assert.equal(protocol.gatewayRequestBytes(request), new TextEncoder().encode(JSON.stringify(request)).byteLength)
  assert(protocol.gatewayRequestBytes(request) > JSON.stringify(request).length, 'UTF-8 counts non-ASCII request content by encoded bytes')
})
await contract('documented OpenRouter context-length metadata is redacted and never falls back', async () => {
  stubFetch(() => jsonResponse({ error: { code: 400, metadata: { error_type: 'context_length_exceeded' }, message: sensitive.join(' ') } }, 400))
  await assert.rejects(complete(), (error) => safeError(error, 'context', 400))
  const requests = stubFetch(() => streamResponse('data: ' + JSON.stringify({
    error: { code: 400, metadata: { error_type: 'context_length_exceeded' }, message: sensitive.join(' ') },
  }) + '\n\n'))
  await assert.rejects(ask({ onFallback: () => assert.fail('Context rejections must not fall back') }), (error) => safeError(error, 'context'))
  assert.equal(requests.length, 1)
})
await contract('Haiku is the sole model and unavailable responses are surfaced after one request', async () => {
  assert.equal(JSON.stringify(ai.MODEL_CHAIN), JSON.stringify(['anthropic/claude-haiku-5.5']))
  assert.equal(ai.MODEL_FALLBACKS.length, 0)
  for (const status of [404, 429, 503]) {
    const requests = stubFetch(() => jsonResponse({ error: { message: 'fixture unavailable' } }, status))
    await assert.rejects(ask({ maxTokens: 8_192 }), (error) => error.status === status)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.model, 'anthropic/claude-haiku-5.5')
    assert.equal(requests[0].body.max_tokens, 8_192)
    assert.equal('temperature' in requests[0].body, false)
    assert.deepEqual(requests[0].body.reasoning, { effort: 'medium', exclude: true })
  }
})
await contract('no fallback for partial output, network, abort, parse or HTTP 200 provider errors', async () => {
  for (const [response, kind, partial] of [
    [() => streamResponse(delta('partial'), { failure: new Error('fixture reader failure') }), 'interrupted', 'partial'],
    [() => { throw new Error('fixture network failure') }, 'network', ''],
    [() => { throw new DOMException('fixture abort', 'AbortError') }, 'aborted', ''],
    [() => new Response('{broken'), 'response', ''],
    [() => streamResponse('data: {"error":{"code":503,"message":"fixture unavailable"}}\n\n'), 'provider', ''],
    [() => streamResponse(delta('partial') + finish('error')), 'provider', 'partial'],
    [() => jsonResponse({}, 401), 'auth', ''],
    [() => jsonResponse({}, 402), 'credits', ''],
    [() => jsonResponse({}, 400), 'http', ''],
  ]) {
    let text = ''
    const requests = stubFetch(response)
    await assert.rejects(ask({ onDelta: (value) => { text += value }, onFallback: () => assert.fail('Unexpected fallback') }),
      (error) => safeError(error, kind))
    assert.equal(requests.length, 1)
    assert.equal(text, partial)
  }
  for (const response of [
    () => streamResponse(delta('partial')),
    () => streamResponse('data: broken\n\n' + done),
    () => jsonResponse({ choices: [{ message: { content: 'partial' } }] }),
  ]) {
    const requests = stubFetch(response)
    assert.equal((await ask({ onFallback: () => assert.fail('Unexpected fallback') })).status, 'interrupted')
    assert.equal(requests.length, 1)
  }
})
await contract('Gateway binds stored sessions to the configured origin and keeps provider settings off the wire', async () => {
  const gatewayMessages = [{ role: 'user', content: 'current question' }]
  stored['gateway.session'] = { token: 'old-origin-token-12345678901234567890', expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, gatewayOrigin: 'https://another-gateway.test' }
  delete stored['gateway.installation']
  const requests = []
  runtime.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    requests.push({ url, ...init, body })
    if (url.endsWith('/api/v1/session')) return jsonResponse({
      token: 'gateway-token-12345678901234567890', expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      installationId: '123e4567-e89b-12d3-a456-426614174000', installationSecret: 'a'.repeat(43),
    }, 201)
    if (url.endsWith('/api/v1/generations')) return streamResponse(
      'event: context\ndata: {"estimatedInputTokens":17,"inputBudget":100000,"estimateHeadroom":20000}\n\n' +
      'event: delta\ndata: {"text":"bounded"}\n\n' +
      'event: complete\ndata: {"status":"complete","model":"server-model","usage":{"promptTokens":17,"completionTokens":2}}\n\n',
    )
    throw new Error('Unexpected gateway fixture request: ' + url)
  }
  let context
  const result = await gateway.createGateway().ask({
    requestId: 'request-fixture', task: 'ask', answerLanguage: 'en', uiLanguage: 'en', titleNeeded: false,
    taskInput: 'current question', messages: gatewayMessages, onContext: value => { context = value },
  })
  assert.deepEqual(plain(result), { text: 'bounded', status: 'complete', model: 'server-model', usage: { promptTokens: 17, completionTokens: 2 } })
  assert.deepEqual(plain(context), { estimatedInputTokens: 17, inputBudget: 100000, estimateHeadroom: 20000 })
  assert.equal(requests.length, 2)
  assert(requests[0].url.endsWith('/api/v1/session'), 'cross-origin stale token is discarded instead of sent')
  assert.equal(requests[1].body.requestId, 'request-fixture')
  assert.deepEqual(requests[1].body.messages, gatewayMessages)
  assert(!('system' in requests[1].body) && !('temperature' in requests[1].body) && !('model' in requests[1].body))
  assert.equal(requests[1].headers.Authorization, 'Bearer gateway-token-12345678901234567890')
  assert.deepEqual(plain(stored['gateway.session']), {
    token: 'gateway-token-12345678901234567890',
    expiresAt: stored['gateway.session'].expiresAt,
    gatewayOrigin: 'https://gateway.test',
  })

  assert.equal(stored['gateway.installation'].installationId, '123e4567-e89b-12d3-a456-426614174000')
  assert.equal(stored['gateway.installation'].gatewayOrigin, 'https://gateway.test')

  const beforeLegacy = requests.length
  delete stored['gateway.installation']
  stored['gateway.session'] = { token: 'legacy-session-token-12345678901234567890', expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }
  await gateway.createGateway().ask({
    requestId: 'request-legacy-session', task: 'ask', answerLanguage: 'en', uiLanguage: 'en', titleNeeded: false,
    taskInput: 'current question', messages: gatewayMessages,
  })
  assert.equal(requests.length, beforeLegacy + 2, 'legacy unbound session is discarded and replaced before generation')
  assert.equal(stored['gateway.session'].gatewayOrigin, 'https://gateway.test')
})
await contract('expired bearer recovers the same origin-bound installation and invalid credentials never bootstrap', async () => {
  const installation = {
    installationId: '223e4567-e89b-12d3-a456-426614174000',
    installationSecret: 'b'.repeat(43),
    gatewayOrigin: 'https://gateway.test',
  }
  stored['gateway.installation'] = installation
  stored['gateway.session'] = {
    token: 'expired-session-token-12345678901234567890',
    expiresAt: Date.now() - 1,
    gatewayOrigin: 'https://gateway.test',
  }
  const requests = []
  runtime.fetch = async (url, init) => {
    requests.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined })
    if (url.endsWith('/api/v1/session/recover')) {
      assert.deepEqual(plain(JSON.parse(init.body)), {
        installationId: installation.installationId, installationSecret: installation.installationSecret,
      })
      return jsonResponse({ token: 'recovered-session-token-12345678901234567890', expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }, 201)
    }
    if (url.endsWith('/api/v1/generations')) return streamResponse(
      'event: complete\ndata: {"status":"complete","model":"server-model","usage":{"promptTokens":1,"completionTokens":1}}\n\n',
    )
    throw new Error('Unexpected recovery fixture request: ' + url)
  }
  await gateway.createGateway().ask({
    requestId: 'request-recovered', task: 'ask', answerLanguage: 'en', uiLanguage: 'en', titleNeeded: false,
    taskInput: 'current question', messages: [{ role: 'user', content: 'current question' }],
  })
  assert.equal(requests.length, 2)
  assert(requests[0].url.endsWith('/api/v1/session/recover'))
  assert.equal(requests[1].init.headers.Authorization, 'Bearer recovered-session-token-12345678901234567890')
  assert.equal(stored['gateway.installation'].installationId, installation.installationId)

  runtime.fetch = async (url) => {
    if (url.endsWith('/api/v1/session/recover')) return jsonResponse({ error: { code: 'installation.invalid' } }, 401)
    throw new Error('invalid credentials must not trigger bootstrap or generation')
  }
  stored['gateway.session'].expiresAt = Date.now() - 1
  await assert.rejects(gateway.createGateway().ask({
    requestId: 'request-invalid-installation', task: 'ask', answerLanguage: 'en', uiLanguage: 'en', titleNeeded: false,
    taskInput: 'current question', messages: [{ role: 'user', content: 'current question' }],
  }), (error) => error.code === 'installation.invalid')
  assert.equal(stored['gateway.installation'].installationId, installation.installationId)
})

await contract('service-wide budget denial is localized with reset date and is never treated as uncertain', async () => {
  stored['gateway.session'] = {
    token: 'service-budget-session-12345678901234567890',
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    gatewayOrigin: 'https://gateway.test',
  }
  stored['gateway.installation'] = {
    installationId: '323e4567-e89b-12d3-a456-426614174000',
    installationSecret: 'c'.repeat(43),
    gatewayOrigin: 'https://gateway.test',
  }
  const resetAt = Date.UTC(2026, 10, 1)
  let requests = 0
  runtime.fetch = async () => {
    requests++
    return jsonResponse({ error: { code: 'budget.service_exhausted', resetAt } }, 429)
  }
  await assert.rejects(gateway.createGateway().ask({
    requestId: 'request-service-budget', task: 'ask', answerLanguage: 'en', uiLanguage: 'en', titleNeeded: false,
    taskInput: 'current question', messages: [{ role: 'user', content: 'current question' }],
  }), (error) => {
    assert.equal(error.code, 'budget.service_exhausted')
    assert.equal(error.kind, 'rate')
    assert.equal(error.resetAt, resetAt)
    assert.match(gateway.gatewayErrorMessage(error, 'ru'), /Общий месячный лимит сервиса исчерпан/)
    assert(gateway.gatewayErrorMessage(error, 'ru').includes('01.11.2026'))
    return true
  })
  assert.equal(requests, 1, 'global denial makes one request and cannot trigger generation replay')
})

runtime.fetch = () => { throw new Error('Unexpected network request in contract test') }
console.log(`API CONTRACTS OK — ${apiCases} groups, synthetic fetch only`)
