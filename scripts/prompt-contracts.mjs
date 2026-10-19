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
function approvedBody(markdown, heading) {
  const start = markdown.indexOf(heading)
  assert.notEqual(start, -1, `approved prompt section exists: ${heading}`)
  const block = markdown.slice(start).match(/```text\n([\s\S]*?)\n```/)
  assert.ok(block, `approved text block exists: ${heading}`)
  return block[1]
}

const prompts = load('src/shared/prompts/index.ts')
const doc = readFileSync(resolve(root, 'docs/prompts-review-stage4.md'), 'utf8')
assert.match(doc, /Статус: APPROVED/)
assert.equal(prompts.PROMPTS_VERSION, '2026-10-19.4')
const browserRu = { answerLanguage: 'auto', browserLanguage: 'ru', uiLang: 'en' }
const browserEnUiRu = { answerLanguage: 'auto', browserLanguage: 'en', uiLang: 'ru' }
const explicitDe = { answerLanguage: 'de', browserLanguage: 'ru', uiLang: 'ru' }
assert.equal(prompts.systemPrompt(browserRu), approvedBody(doc, '## Общая инструкция').replace('{{effective_answer_language}}', 'Russian'))
assert.equal(prompts.firstAnswerTitleInstruction(browserRu), approvedBody(doc, '## Первый ответ и заголовок'))
assert.equal(prompts.systemPrompt(browserRu).includes('Respond in Russian'), true)
assert.equal(prompts.systemPrompt(browserEnUiRu).includes('Respond in English'), true)
assert.equal(prompts.systemPrompt(explicitDe).includes('Respond in German'), true)
assert.equal(prompts.taskPrompt('solve', browserRu), approvedBody(doc, '**Solve**'))
assert.equal(prompts.taskPrompt('quiz', browserRu), prompts.taskPrompt('solve', browserRu), 'legacy quiz follows Solve')
assert.equal(prompts.taskPrompt('hint', browserRu), approvedBody(doc, '**Hint**'))
assert.equal(prompts.checkPrompt(undefined, browserRu), approvedBody(doc, '**Check**'))
assert.equal(prompts.taskPrompt('explain', browserRu), approvedBody(doc, '**Explain**'))
assert.equal(prompts.taskPrompt('translate', browserRu), approvedBody(doc, '**Translate').replaceAll('{{effective_answer_language}}', 'Russian'))
assert.equal(prompts.taskPrompt('summarize', browserRu), approvedBody(doc, '**Summarize**'))
assert.equal(prompts.simplerPrompt(browserRu), approvedBody(doc, '**Simpler**').replace('{{effective_answer_language}}', 'Russian'))
assert.equal(prompts.simplerPrompt(browserEnUiRu), approvedBody(doc, '**Simpler**').replace('{{effective_answer_language}}', 'English'))
assert.equal(prompts.simplerPrompt(explicitDe), approvedBody(doc, '**Simpler**').replace('{{effective_answer_language}}', 'German'))
assert.ok(prompts.taskPrompt('translate', explicitDe).includes('into German'))

for (const kind of ['solve', 'quiz', 'translate', 'explain', 'summarize', 'hint', 'check', 'ask', 'simpler']) {
  const params = prompts.turnParams(kind)
  assert.equal(params.maxTokens, 16_384)
  assert.equal(Object.hasOwn(params, 'temperature'), false)
  assert.equal(Object.hasOwn(params, 'reasoning'), false)
}
console.log('PROMPT CONTRACTS OK — approved text matches docs exactly, browser/selected answer languages remain independent, legacy quiz maps to Solve; no provider calls')
