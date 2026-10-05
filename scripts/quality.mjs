// Task-quality check: drive the REAL extension UI (headless) against the real
// OpenRouter API with concrete study fixtures, one per task button, and print
// what each preset actually returns. This is the "test on concrete things"
// pass — it exercises capture -> preset -> streamed answer end to end.
//
//   node scripts/quality.mjs
//
// The key is read from ~/.config/study-buddy/credentials.json (or
// OPENROUTER_API_KEY) and seeded into a throwaway profile only.
import { chromium } from 'playwright'
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const dist = join(root, 'dist')
const OUT = '/tmp/opencode'
mkdirSync(OUT, { recursive: true })

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim()
  const c = JSON.parse(readFileSync(join(homedir(), '.config', 'study-buddy', 'credentials.json'), 'utf8')).openrouter
  if (!c?.apiKey) throw new Error('No OpenRouter key in ~/.config/study-buddy/credentials.json')
  return c.apiKey
}
const KEY = apiKey()

const BASE_CSS = `body{margin:0;background:#fff;font:22px/1.55 Georgia,serif;color:#111}
.card{padding:30px 36px;min-width:560px}h2{font:600 20px system-ui;color:#4f9cff;margin:0 0 14px}
code{font:17px/1.5 ui-monospace,monospace}pre{background:#f3f4f6;padding:10px;border-radius:8px}
.opt{margin:4px 0}`

const FIXTURES = [
  {
    id: 'math',
    preset: 'solve',
    title: 'Solve — quadratic',
    html: `<div class="card"><h2>Problem</h2><p>Solve for x: 2x² − 5x − 3 = 0</p></div>`,
  },
  {
    id: 'quiz',
    preset: 'quiz',
    title: 'Quiz — multiple choice',
    html: `<div class="card"><h2>Which process do plants use to make food?</h2>
      <div class="opt">A) Respiration</div><div class="opt">B) Photosynthesis</div>
      <div class="opt">C) Digestion</div><div class="opt">D) Fermentation</div></div>`,
  },
  {
    id: 'code',
    preset: 'explain',
    title: 'Explain — code with a bug',
    html: `<div class="card"><h2>Why is sum 0?</h2><pre><code>const nums = [1, 2, 3]
let sum = 0
for (let i = 0; i <= nums.length; i++) {
  sum += nums[i]
}
console.log(sum) // expected 6</code></pre></div>`,
  },
  {
    id: 'translate',
    preset: 'translate',
    title: 'Translate — Russian',
    html: `<div class="card"><h2>Отрывок</h2><p>Вода кипит при ста градусах Цельсия на уровне моря,
      но в горах температура кипения ниже из-за меньшего атмосферного давления.</p></div>`,
  },
  {
    id: 'summarize',
    preset: 'summarize',
    title: 'Summarize — article',
    html: `<div class="card"><h2>Rewilding</h2><p>Rewilding is a form of ecological restoration that
      aims to return land to a wilder state. Unlike traditional conservation, which often freezes an
      ecosystem at a chosen point, rewilding allows natural processes to shape it. A keystone species —
      the wolf in Yellowstone, for example — can trigger a cascade that changes rivers, forests, and
      even the course of streams. Critics note that the approach can be unpredictable and hard to
      measure, while supporters argue that unpredictability is exactly the point.</p></div>`,
  },
]

// Test build: host_permissions so capture works without the activeTab gesture.
const distTest = join(root, 'dist-test')
rmSync(distTest, { recursive: true, force: true })
cpSync(dist, distTest, { recursive: true })
{
  const mf = join(distTest, 'manifest.json')
  const m = JSON.parse(readFileSync(mf, 'utf8'))
  m.host_permissions = ['<all_urls>']
  writeFileSync(mf, JSON.stringify(m, null, 2))
}

const profile = join('/tmp/opencode', 'sb-quality-profile')
rmSync(profile, { recursive: true, force: true })
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 480, height: 760 },
  args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`],
})
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker')
const origin = (await sw.evaluate(() => chrome.runtime.getURL(''))).replace(/\/$/, '')

await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: KEY,
  uiLanguage: 'en',
  answerLanguage: 'auto',
})

const report = [`# Study Buddy — task quality (real API)`, `Date: ${new Date().toISOString()}`, '']

for (const fx of FIXTURES) {
  const render = await ctx.newPage()
  await render.setViewportSize({ width: 720, height: 320 })
  await render.setContent(`<!doctype html><meta charset="utf-8"><style>${BASE_CSS}</style>${fx.html}`)
  const png = await render.screenshot({ type: 'png' })
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`
  await render.close()

  const id = `fx-${fx.id}`
  await sw.evaluate(
    ([key, url]) => chrome.storage.session.set({ [key]: { dataUrl: url, rect: { x: 0, y: 0, width: 600, height: 240 }, ts: Date.now() } }),
    [`capture.${id}`, dataUrl],
  )

  const chat = await ctx.newPage()
  await chat.goto(`${origin}/src/chat/chat.html?kind=capture&id=${id}`)
  await chat.waitForFunction(() => document.getElementById('crop')?.naturalWidth > 0)
  const started = Date.now()
  await chat.click(`.preset[data-preset="${fx.preset}"]`)
  // The retry action appears only once the answer has fully streamed.
  await chat.waitForSelector('.msg.assistant [data-retry]', { timeout: 60000 }).catch(() => {})
  const text = await chat.evaluate(() => {
    const bodies = document.querySelectorAll('.msg.assistant .msg-body')
    return bodies.length ? bodies[bodies.length - 1].textContent.trim() : '(no answer)'
  })
  const ms = Date.now() - started
  await chat.close()

  console.log(`\n════ ${fx.title}  [${fx.preset}]  ${(ms / 1000).toFixed(1)}s ════`)
  console.log(text.slice(0, 900))
  report.push(`## ${fx.title} — preset: ${fx.preset}`, `_latency:_ ${ms}ms`, '', text, '')
}

writeFileSync(join(OUT, 'study-buddy-quality.md'), report.join('\n'))
console.log(`\nFull report: ${OUT}/study-buddy-quality.md`)
await ctx.close()
