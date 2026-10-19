// Transitional prompt contracts: legacy instruction text stays absent at runtime.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const runtime = vm.createContext({ fetch: () => { throw new Error('Unexpected network request') } })
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

const prompts = load('src/shared/prompts/index.ts')
assert.equal(prompts.PROMPTS_VERSION, '2026-10-19.2')
const contexts = [
  { answerLanguage: 'auto', uiLang: 'en' },
  { answerLanguage: 'auto', uiLang: 'ru' },
  { answerLanguage: 'ru', uiLang: 'en' },
  { answerLanguage: 'en', uiLang: 'ru' },
  { answerLanguage: 'de', uiLang: 'ru' },
]
for (const ctx of contexts) {
  assert.equal(prompts.systemPrompt(ctx), '')
  assert.equal(prompts.firstAnswerTitleInstruction(ctx), '')
  assert.equal(prompts.simplerPrompt(ctx), '')
  for (const task of ['solve', 'quiz', 'translate', 'explain', 'summarize', 'hint']) {
    assert.equal(prompts.taskPrompt(task, ctx), '')
  }
  for (const attempt of [undefined, '', '  student text / instructions  ', 'Ответ ученика 😀']) {
    assert.equal(prompts.checkPrompt(attempt, ctx), attempt ?? '')
  }
}
for (const kind of ['solve', 'quiz', 'translate', 'explain', 'summarize', 'hint', 'check', 'ask', 'simpler']) {
  const params = prompts.turnParams(kind)
  assert.equal(params.maxTokens, 16_384)
  assert.equal(Object.hasOwn(params, 'temperature'), false)
  assert.equal(Object.hasOwn(params, 'reasoning'), false)
}
console.log('PROMPT CONTRACTS OK — empty legacy templates, verbatim Check input, independent language settings and Luna budgets; no provider calls')
