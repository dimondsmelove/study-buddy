// Build a visual review gallery of the CURRENT extension, captured from the
// real UI: the snip overlay, the panel with each task (real model answers,
// rendered Markdown + LaTeX), settings, permission and error states. Output
// goes to review/ as PNGs plus an index.html gallery.
//
//   npm run review
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const dist = join(root, 'dist')
const out = join(root, 'review')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim()
  const c = JSON.parse(readFileSync(join(homedir(), '.config', 'study-buddy', 'credentials.json'), 'utf8')).openrouter
  return c.apiKey
}
const KEY = apiKey()

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

const PAGE_CSS = `body{margin:0;background:#f3f4f6;font:17px/1.6 Georgia,serif;color:#18181b}
header{padding:12px 22px;background:#111827;color:#fff;font:14px system-ui}
main{max-width:720px;margin:0 auto;padding:26px 22px}h1{font:600 26px system-ui;margin:0 0 16px}
code{font:15px/1.5 ui-monospace,monospace;background:#f3f4f6;padding:2px 5px;border-radius:4px}
.opt{margin:4px 0}`
const page = (body) => `<!doctype html><meta charset="utf-8"><style>${PAGE_CSS}</style><header>Canvas · Homework 4</header><main>${body}</main>`

const FIXTURES = [
  { id: 'math', preset: 'solve', title: 'Solve — math', pageHtml: page('<h1>Problem 3</h1><p>A train travels 240 km in 3 hours, then 180 km in 2 hours. What is its average speed?</p>'), crop: '<h2>Problem 3</h2><p>A train travels 240 km in 3 h, then 180 km in 2 h. What is its average speed?</p>' },
  { id: 'quiz', preset: 'quiz', title: 'Quiz — multiple choice', pageHtml: page('<h1>Which process do plants use to make food?</h1><p class="opt">A) Respiration</p><p class="opt">B) Photosynthesis</p><p class="opt">C) Digestion</p><p class="opt">D) Fermentation</p>'), crop: '<h2>Which process do plants use to make food?</h2><p>A) Respiration&nbsp;&nbsp;B) Photosynthesis&nbsp;&nbsp;C) Digestion&nbsp;&nbsp;D) Fermentation</p>' },
  { id: 'code', preset: 'explain', title: 'Explain — code', pageHtml: page('<h1>Why is sum 0?</h1><pre><code>const nums = [1, 2, 3]\nlet sum = 0\nfor (let i = 0; i &lt;= nums.length; i++) {\n  sum += nums[i]\n}\nconsole.log(sum) // expected 6</code></pre>'), crop: '<h2>Why is sum 0?</h2><p>const nums = [1,2,3]; for (let i = 0; i &lt;= nums.length; i++) sum += nums[i]</p>' },
  { id: 'ru', preset: 'translate', title: 'Translate — Russian', pageHtml: page('<h1>Отрывок</h1><p>Осенью лес становится особенно красивым. Листья клёнов и берёз окрашиваются в золотой и багряный цвета.</p>'), crop: '<h2>Отрывок</h2><p>Осенью лес становится особенно красивым. Листья клёнов и берёз окрашиваются в золотой и багряный цвета.</p>' },
  { id: 'article', preset: 'summarize', title: 'Summarize — article', pageHtml: page('<h1>Rewilding</h1><p>Rewilding is a form of ecological restoration that lets natural processes shape an ecosystem rather than freezing it at a chosen point. Keystone species such as the Yellowstone wolf can trigger cascades that change rivers and forests.</p>'), crop: '<h2>Rewilding</h2><p>Rewilding lets natural processes shape an ecosystem rather than freezing it. Keystone species such as the Yellowstone wolf can trigger cascades.</p>' },
]

const server = createServer((req, res) => {
  // The same server serves the /models + chat endpoints the AI test build hits.
  if (req.url?.includes('/chat/completions')) {
    res.writeHead(400)
    res.end('{}')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><meta charset="utf-8"><body style="font:22px Georgia">page</body>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const profile = join('/tmp/opencode', 'sb-review-profile')
rmSync(profile, { recursive: true, force: true })
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 420, height: 760 },
  args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`],
})
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker')
const origin = (await sw.evaluate(() => chrome.runtime.getURL(''))).replace(/\/$/, '')

await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), {
  provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY, uiLanguage: 'en', answerLanguage: 'auto',
})

async function cropDataUrl(html) {
  const p = await ctx.newPage()
  await p.setViewportSize({ width: 420, height: 220 })
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff;font:20px/1.5 Georgia,serif;padding:20px 24px}h2{font:600 17px system-ui;color:#4f9cff;margin:0 0 8px}</style>${html}`)
  const png = await p.screenshot({ type: 'png' })
  await p.close()
  return `data:image/png;base64,${png.toString('base64')}`
}

const shots = []
const shot = async (page, name, title, note) => {
  await page.screenshot({ path: join(out, `${name}.png`) })
  shots.push({ name, title, note })
  console.log('shot', name)
}

// 1. The snip overlay with a rectangle being drawn, on a real page.
{
  const target = await ctx.newPage()
  target.setViewportSize({ width: 900, height: 560 })
  await target.goto(`http://127.0.0.1:${server.address().port}/`)
  await target.setContent(FIXTURES[0].pageHtml)
  const trigger = await ctx.newPage()
  await trigger.goto(`${origin}/src/chat/chat.html?kind=error&message=x`)
  await target.bringToFront()
  await trigger.evaluate(() => chrome.runtime.sendMessage({ type: 'START_SELECTION' }))
  await target.waitForSelector('[data-study-buddy="overlay"]', { timeout: 5000 })
  await target.mouse.move(120, 120)
  await target.mouse.down()
  await target.mouse.move(560, 300, { steps: 6 })
  await target.screenshot({ path: join(out, 'overlay.png') })
  shots.push({ name: 'overlay', title: 'Snip the screen', note: 'Ctrl+Shift+Y → drag a box around the question.' })
  console.log('shot overlay')
  await target.mouse.up()
  await trigger.close()
  await target.close()
}

// 2. Capture panel, empty (crop + tasks + hint).
{
  const png = await cropDataUrl(FIXTURES[0].crop)
  await sw.evaluate(([k, u]) => chrome.storage.session.set({ [k]: { dataUrl: u, rect: { x: 0, y: 0, width: 400, height: 160 }, ts: Date.now() } }), ['capture.empty', png])
  const p = await ctx.newPage()
  await p.goto(`${origin}/src/chat/chat.html?kind=capture&id=empty`)
  await p.waitForFunction(() => document.getElementById('crop')?.naturalWidth > 0)
  await shot(p, 'capture-empty', 'The panel', 'The crop, five task buttons and a free-form Ask.')
  await p.close()
}

// 3. Each task, real answer from the model.
for (const fx of FIXTURES) {
  const png = await cropDataUrl(fx.crop)
  await sw.evaluate(([k, u]) => chrome.storage.session.set({ [k]: { dataUrl: u, rect: { x: 0, y: 0, width: 400, height: 160 }, ts: Date.now() } }), [`capture.${fx.id}`, png])
  const p = await ctx.newPage()
  await p.goto(`${origin}/src/chat/chat.html?kind=capture&id=${fx.id}`)
  await p.waitForFunction(() => document.getElementById('crop')?.naturalWidth > 0)
  await p.click(`.preset[data-preset="${fx.preset}"]`)
  await p.waitForSelector('.msg.assistant [data-retry]', { timeout: 60000 }).catch(() => {})
  await shot(p, fx.id, fx.title, `Preset “${fx.preset}” — real model answer, Markdown + LaTeX.`)
  await p.close()
}

// 4. Settings (languages + collapsed advanced).
{
  const p = await ctx.newPage()
  await p.goto(`${origin}/src/chat/chat.html?kind=error&message=Select%20a%20region%20to%20begin.`)
  await p.waitForSelector('#view-error:not([hidden])')
  await p.click('#view-error:not([hidden]) [data-goto-settings]')
  await p.waitForSelector('#view-settings:not([hidden])')
  await shot(p, 'settings', 'Settings', 'Language first; your own key is tucked under Advanced.')
  await p.close()
}

// 5. Permission + error states.
{
  const p = await ctx.newPage()
  await p.goto(`${origin}/src/chat/chat.html?kind=permission&origin=https://example.com`)
  await p.waitForSelector('#view-permission:not([hidden])')
  await shot(p, 'permission', 'Per-site permission', 'Asked only when a capture needs it.')
  await p.close()
}
{
  const p = await ctx.newPage()
  await p.goto(`${origin}/src/chat/chat.html?kind=restricted&reason=the%20Chrome%20Web%20Store`)
  await p.waitForSelector('#view-restricted:not([hidden])')
  await shot(p, 'restricted', 'Honest dead-end', 'Pages no extension may capture.')
  await p.close()
}

// Gallery.
const cards = shots
  .map(
    (s) => `<figure><img src="${s.name}.png" alt=""><figcaption><b>${s.title}</b><span>${s.note}</span></figcaption></figure>`,
  )
  .join('\n')
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Study Buddy — review</title><style>
  body{margin:0;background:#0f1115;color:#e5e7eb;font:14px/1.5 system-ui}
  h1{font-size:20px;margin:0;padding:20px 24px 4px}p.sub{margin:0 24px 16px;color:#9ca3af}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;padding:0 24px 40px}
  figure{margin:0;background:#1a1d23;border:1px solid #2a2e37;border-radius:12px;overflow:hidden}
  figure img{display:block;width:100%;background:#fff}
  figcaption{display:flex;flex-direction:column;gap:2px;padding:10px 12px}
  figcaption b{font-size:13px}figcaption span{color:#9ca3af;font-size:12px}
  </style><h1>Study Buddy — инкремент на ревью</h1><p class="sub">Реальные экраны текущей сборки. Открой live: <code>npm run playtest</code></p><div class="grid">${cards}</div>`,
)
console.log(`\nGallery: ${join(out, 'index.html')}`)
await ctx.close()
server.close()
