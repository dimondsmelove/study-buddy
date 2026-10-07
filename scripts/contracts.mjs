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
  __SB_DEFAULT_API_KEY__: 'fixture-default-key',
  __SB_DEFAULT_BASE_URL__: 'https://default.test/v1',
  chrome: { storage: { local: {
    get: async () => structuredClone(stored),
    set: async (value) => Object.assign(stored, structuredClone(value)),
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

const settings = load('src/shared/settings.ts')
const defaults = { apiKey: 'fixture-baked-key', baseUrl: 'https://default.test/v1/' }
assert.equal(settings.resolveSettings({ ...settings.DEFAULT_SETTINGS, apiKey: ' byok ', baseUrl: 'https://custom.test/v1/' }, defaults).apiKey, 'byok')
const effective = settings.resolveSettings({ ...settings.DEFAULT_SETTINGS, apiKey: '', baseUrl: '' }, defaults)
assert.equal(effective.baseUrl, 'https://default.test/v1')
assert.equal(effective.apiKey, 'fixture-baked-key')
assert.equal(settings.resolveSettings({ ...settings.DEFAULT_SETTINGS, baseUrl: 'https://custom.test/v1' }, defaults).apiKey, '')
assert.equal(settings.resolveSettings({ ...settings.DEFAULT_SETTINGS, baseUrl: '' }, { ...defaults, apiKey: '' }).apiKey, '')
for (const url of ['javascript:alert(1)', 'ftp://host.test', 'https://user:secret@host.test', 'https://host.test?key=secret', 'https://host.test#secret', 'bad URL']) {
  assert.throws(() => settings.resolveSettings({ ...settings.DEFAULT_SETTINGS, baseUrl: url }, defaults))
}
for (const value of [null, 'old', { apiKey: 42, baseUrl: [], uiLanguage: 'bad' }, { apiKey: 'legacy', uiLanguage: 'ru', model: 'old' }]) {
  stored.settings = value
  const got = await settings.getSettings()
  assert.equal(typeof got.apiKey, 'string')
  assert.equal(typeof got.baseUrl, 'string')
  assert(!('model' in got))
}
runtime.chrome.storage.local.get = async () => { throw new Error('fixture storage failure') }
assert.equal((await settings.getSettings()).apiKey, '')
console.log('SETTINGS CONTRACTS OK — defaults, BYOK, custom isolation, malformed/legacy records, storage failure')

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
const delta = (text) => frame({ delta: { content: text } })
const finish = (reason) => frame({ delta: {}, finish_reason: reason })
const done = 'data: [DONE]\n\n'
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})
function streamResponse(text, { width = 4096, failure } = {}) {
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
  }), { headers: { 'content-type': 'text/event-stream' } })
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
const plain = (value) => JSON.parse(JSON.stringify(value))
const expected = (text, status, finishReason) => ({
  text, status, ...(finishReason !== undefined ? { finishReason } : {}),
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
    stubFetch(() => jsonResponse({ choices: [{ message: { content }, finish_reason: reason }] }))
    assert.deepEqual(plain(await complete({ onDelta: (value) => deltas.push(value) })), result)
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
await contract('404/429/503 before any delta fall back once with the same per-turn params', async () => {
  for (const status of [404, 429, 503]) {
    const switches = []
    const requests = stubFetch((_request, count) => count === 1
      ? jsonResponse({ error: { message: 'fixture unavailable' } }, status)
      : streamResponse(delta('fallback') + finish('stop') + done))
    const result = await ask({ temperature: 0.2, maxTokens: 321, onFallback: (...args) => switches.push(args) })
    assert.deepEqual(plain(result), expected('fallback', 'complete', 'stop'))
    assert.equal(requests.length, 2)
    assert.equal(switches.length, 1)
    assert.deepEqual(requests.map((request) => request.body.model), plain(ai.MODEL_CHAIN.slice(0, 2)))
    for (const request of requests) {
      assert.equal(request.body.temperature, 0.2)
      assert.equal(request.body.max_tokens, 321)
      assert.deepEqual(request.body.messages, messages)
      assert.equal(request.body.stream, true)
    }
  }
  const requests = stubFetch(() => jsonResponse({}, 503))
  await assert.rejects(ask(), (error) => safeError(error, 'http', 503))
  assert.equal(requests.length, ai.MODEL_CHAIN.length)
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
await contract('Gateway exposes CompletionResult and passes turn parameters to the existing model chain', async () => {
  const requests = stubFetch(() => streamResponse(delta('bounded') + finish('length')))
  const result = await gateway.createGateway(fixtureSettings).ask({ messages, temperature: 0, maxTokens: 99 })
  assert.deepEqual(plain(result), expected('bounded', 'truncated', 'length'))
  assert.equal(requests[0].body.temperature, 0)
  assert.equal(requests[0].body.max_tokens, 99)
})
runtime.fetch = () => { throw new Error('Unexpected network request in contract test') }
console.log(`API CONTRACTS OK — ${apiCases} groups, synthetic fetch only`)
