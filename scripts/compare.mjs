// Model-quality comparison: render a few varied screenshots in Chromium and
// ask several OpenRouter vision models to solve / explain / translate them.
// Prints a compact report and writes the full answers to /tmp/opencode.
//
// The API key is read from ~/.config/study-buddy/credentials.json (or
// OPENROUTER_API_KEY). Usage:
//   node scripts/compare.mjs                 # default model shortlist
//   node scripts/compare.mjs qwen/qwen3.7-flash openai/gpt-5-nano
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const OUT_DIR = '/tmp/opencode'
mkdirSync(OUT_DIR, { recursive: true })

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim()
  const file = join(homedir(), '.config', 'study-buddy', 'credentials.json')
  const creds = JSON.parse(readFileSync(file, 'utf8'))
  const key = creds?.openrouter?.apiKey
  if (!key) throw new Error(`No OpenRouter key in ${file}`)
  return key
}
const KEY = apiKey()

const DEFAULT_MODELS = [
  'qwen/qwen3.7-flash',
  'openai/gpt-5-nano',
  'google/gemini-2.5-flash-lite',
  'z-ai/glm-5.3-flash',
  'deepseek/deepseek-v4-flash-vision-exp',
]
const MODELS = process.argv.slice(2).filter((a) => a.includes('/') && !a.startsWith('--'))
const models = MODELS.length ? MODELS : DEFAULT_MODELS

// Each case is a small HTML page plus the question. Languages and task types
// are mixed on purpose: the point is to see where a cheap model folds.
const BASE_CSS = `body{margin:0;background:#fff;font:22px/1.5 Georgia,serif;color:#111}
.card{padding:34px 40px;min-width:560px}
h2{font:600 20px system-ui;color:#4f9cff;margin:0 0 16px}
table{border-collapse:collapse}td,th{border:1px solid #999;padding:6px 12px;font:20px system-ui}
code{font:18px/1.5 ui-monospace,monospace;background:#f3f4f6;padding:2px 5px}`

const CASES = [
  {
    id: 'math-en',
    label: 'Math (English)',
    prompt: 'Solve the problem in the image. Give the answer and the steps.',
    html: `<div class="card"><h2>Problem 3</h2>
      <p>A train travels 240&nbsp;km in 3 hours, then 180&nbsp;km in 2 hours.</p>
      <p>What is its average speed for the whole journey?</p></div>`,
  },
  {
    id: 'text-ru',
    label: 'Russian text (translate)',
    prompt: 'Translate all the text in the image into English.',
    html: `<div class="card"><h2>Отрывок</h2>
      <p>Осенью лес становится особенно красивым. Листья клёнов и берёз
      окрашиваются в золотой и багряный цвета, а воздух наполняется запахом
      грибов и влажной земли. Именно в это время года лучше всего гулять по
      тихим тропинкам и слушать, как шумит ветер в кронах.</p></div>`,
  },
  {
    id: 'text-de',
    label: 'German text (explain)',
    prompt: 'Explain in English what this German text says.',
    html: `<div class="card"><h2>Fotoapparat</h2>
      <p>Ein Fotoapparat ist ein Gerät, mit dem man Bilder aufnimmt. Das Licht
      fällt durch das Objektiv auf einen Sensor, der die Helligkeit in
      elektrische Signale umwandelt. Diese Signale werden dann als digitale
      Datei gespeichert.</p></div>`,
  },
  {
    id: 'table-en',
    label: 'Table (reason)',
    prompt: 'Look at the table. Which city had the highest average temperature, and by how much over the second?',
    html: `<div class="card"><h2>Average temperature (°C)</h2>
      <table><tr><th>City</th><th>Jan</th><th>Jul</th></tr>
      <tr><td>Oslo</td><td>-4</td><td>17</td></tr>
      <tr><td>Rome</td><td>8</td><td>25</td></tr>
      <tr><td>Cairo</td><td>14</td><td>29</td></tr></table></div>`,
  },
  {
    id: 'code-en',
    label: 'Code (explain)',
    prompt: 'What does this code do? Be concise.',
    html: `<div class="card"><h2>snippet.js</h2><pre><code>const once = (fn) =&gt; {
  let called = false
  return (...args) =&gt; {
    if (called) return
    called = true
    return fn(...args)
  }
}</code></pre></div>`,
  },
]

async function shoot(browser, html) {
  const page = await browser.newPage({ viewport: { width: 900, height: 460 }, deviceScaleFactor: 1 })
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${BASE_CSS}</style>${html}`)
  const png = await page.screenshot({ type: 'png' })
  await page.close()
  return `data:image/png;base64,${png.toString('base64')}`
}

async function ask(model, prompt, imageUrl) {
  const started = Date.now()
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Study Buddy compare' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] }],
    }),
  })
  const ms = Date.now() - started
  const body = await res.json().catch(() => null)
  if (!res.ok) return { ok: false, ms, error: body?.error?.message || `HTTP ${res.status}` }
  const text = typeof body?.choices?.[0]?.message?.content === 'string' ? body.choices[0].message.content : JSON.stringify(body?.choices?.[0]?.message?.content)
  return { ok: true, ms, text, usage: body?.usage }
}

const browser = await chromium.launch()
const images = new Map()
for (const c of CASES) images.set(c.id, await shoot(browser, c.html))
await browser.close()

console.log(`Models: ${models.join(', ')}`)
console.log(`Cases:  ${CASES.map((c) => c.id).join(', ')}\n`)

const report = [`# Study Buddy — model quality comparison`, `Date: ${new Date().toISOString()}`, `Models: ${models.join(', ')}`, '']
const summary = []

for (const model of models) {
  console.log(`\n══════ ${model} ══════`)
  report.push(`\n## ${model}\n`)
  for (const c of CASES) {
    const r = await ask(model, c.prompt, images.get(c.id))
    if (!r.ok) {
      console.log(`  ✗ ${c.id}: ${r.error}`)
      report.push(`### ${c.label}\n**ERROR:** ${r.error}\n`)
      continue
    }
    const u = r.usage ? `in ${r.usage.prompt_tokens} / out ${r.usage.completion_tokens}` : 'usage?'
    console.log(`  ✓ ${c.id}  ${r.ms}ms  ${u}`)
    console.log(`      ${r.text.trim().replace(/\s+/g, ' ').slice(0, 220)}${r.text.length > 220 ? '…' : ''}`)
    report.push(`### ${c.label}\n_prompt:_ ${c.prompt}\n_latency:_ ${r.ms}ms · _tokens:_ ${u}\n\n${r.text.trim()}\n`)
    summary.push({ model, case: c.id, ms: r.ms, in: r.usage?.prompt_tokens, out: r.usage?.completion_tokens })
  }
}

const outFile = join(OUT_DIR, 'study-buddy-compare.md')
writeFileSync(outFile, report.join('\n'))
writeFileSync(join(OUT_DIR, 'study-buddy-compare.json'), JSON.stringify(summary, null, 2))
console.log(`\nFull report: ${outFile}`)
