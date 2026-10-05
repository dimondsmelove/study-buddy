// Turnkey manual test: launch a real (headed) Chromium with the built
// extension already loaded and the OpenRouter key/model pre-seeded, open a
// demo page with tasks in several languages and formats, and leave the window
// open for you to drag-select on. Close the window to finish.
//
//   npm run playtest                 # default model
//   npm run playtest -- <model-id>   # another model
//
// The key is read from ~/.config/study-buddy/credentials.json (or
// OPENROUTER_API_KEY) and written only into this throwaway profile's
// chrome.storage.local — never into the repo.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { cpSync, rmSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const dist = join(root, 'dist')

function creds() {
  if (process.env.OPENROUTER_API_KEY) {
    return { apiKey: process.env.OPENROUTER_API_KEY.trim(), baseUrl: 'https://openrouter.ai/api/v1' }
  }
  const file = join(homedir(), '.config', 'study-buddy', 'credentials.json')
  const c = JSON.parse(readFileSync(file, 'utf8')).openrouter
  if (!c?.apiKey) throw new Error(`No OpenRouter key in ${file}`)
  return { apiKey: c.apiKey, baseUrl: c.baseUrl ?? 'https://openrouter.ai/api/v1' }
}

const { apiKey, baseUrl } = creds()

// Test build: dist + host_permissions, so capture is authorized without the
// activeTab gesture Playwright can't produce (a real user click still grants
// it, but this removes one moving part). Production stays activeTab-only.
const distTest = join(root, 'dist-test')
rmSync(distTest, { recursive: true, force: true })
cpSync(dist, distTest, { recursive: true })
{
  const mf = join(distTest, 'manifest.json')
  const m = JSON.parse(readFileSync(mf, 'utf8'))
  m.host_permissions = ['<all_urls>']
  const { writeFileSync } = await import('node:fs')
  writeFileSync(mf, JSON.stringify(m, null, 2))
}

const DEMO = `<!doctype html><meta charset="utf-8"><title>Study Buddy — demo</title>
<style>
 body{margin:0;background:#eef1f5;font:16px/1.5 system-ui;color:#18181b}
 header{padding:14px 20px;background:#111827;color:#fff}
 header b{color:#7db8ff}
 main{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px;max-width:1200px;margin:0 auto}
 .card{background:#fff;border:1px solid #d4d4d8;border-radius:10px;padding:16px 18px}
 .card h2{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#4f9cff}
 p{margin:.4em 0}
 table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:5px 9px;text-align:left}
 code{font:14px/1.5 ui-monospace,monospace}
 pre{margin:0;background:#f7f7f8;padding:10px;border-radius:8px;overflow:auto}
</style>
<header>Study Buddy demo — dragging a region here helps test. <b>Ctrl+Shift+Y</b> (or the toolbar icon) to select. ⚙ in the chat window to switch model, then click ↻ to load the list.</header>
<main>
 <section class="card"><h2>Math → Solve</h2>
   <p>Problem 3. A train travels 240 km in 3 hours, then 180 km in 2 hours.</p>
   <p>What is its average speed for the whole journey?</p></section>
 <section class="card"><h2>Quiz → Quiz</h2>
   <p>Which process do plants use to make food?</p>
   <p>A) Respiration&nbsp;&nbsp; B) Photosynthesis&nbsp;&nbsp; C) Digestion&nbsp;&nbsp; D) Fermentation</p></section>
 <section class="card"><h2>Code → Explain</h2>
   <pre><code>const nums = [1, 2, 3]
let sum = 0
for (let i = 0; i &lt;= nums.length; i++) {
  sum += nums[i]
}
console.log(sum) // expected 6</code></pre></section>
 <section class="card"><h2>Русский текст → Translate</h2>
   <p>Осенью лес становится особенно красивым. Листья клёнов и берёз окрашиваются
   в золотой и багряный цвета, а воздух наполняется запахом грибов и влажной земли.</p></section>
 <section class="card"><h2>Deutscher Text → Translate</h2>
   <p>Ein Fotoapparat ist ein Gerät, mit dem man Bilder aufnimmt. Das Licht fällt durch
   das Objektiv auf einen Sensor, der die Helligkeit in elektrische Signale umwandelt.</p></section>
 <section class="card"><h2>Article → Summarize</h2>
   <p>Rewilding is a form of ecological restoration that aims to return land to a wilder
   state, letting natural processes — and keystone species such as the Yellowstone wolf —
   shape the ecosystem rather than freezing it at a chosen point.</p></section>
</main>`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(DEMO)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`

const profile = join('/tmp/opencode', 'study-buddy-playtest')
rmSync(profile, { recursive: true, force: true })

const headless = process.env.PLAYTEST_HEADLESS === '1'
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless,
  viewport: headless ? { width: 1200, height: 800 } : null,
  args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`],
})

let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker')
await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), {
  provider: 'openrouter',
  baseUrl,
  apiKey,
})

const page = await ctx.newPage()
await page.goto(url)
await page.bringToFront()

console.log(`\nStudy Buddy test browser is up.`)
console.log(`  model:    DeepSeek (auto-fallback to Gemini / GPT-5 Nano)`)
console.log(`  endpoint: ${baseUrl}`)
console.log(`  demo:     ${url}`)
console.log(`\nSelect a region with Ctrl+Shift+Y, choose Solve/Explain/Translate or ask.`)
console.log(`Close the browser window to exit.\n`)

await new Promise((resolve) => ctx.on('close', resolve))
server.close()
