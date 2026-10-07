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
