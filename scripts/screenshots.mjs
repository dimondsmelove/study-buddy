// Generate Chrome Web Store screenshots (1280x800) that look like real use:
// a homework page as the backdrop with the actual floating chat panel (420px,
// dark title bar, rounded, shadowed) composited on top. Panel contents come
// from the real chat UI; answers are injected as DOM so shots are deterministic.
//
//   npm run screenshots
import { chromium } from 'playwright'
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const dist = join(root, 'dist')
const out = join(root, 'store', 'screenshots')
mkdirSync(out, { recursive: true })

const distTest = join(root, 'dist-test')
rmSync(distTest, { recursive: true, force: true })
cpSync(dist, distTest, { recursive: true })
{
  const mf = join(distTest, 'manifest.json')
  const m = JSON.parse(readFileSync(mf, 'utf8'))
  m.host_permissions = ['<all_urls>']
  writeFileSync(mf, JSON.stringify(m, null, 2))
}

const profile = join('/tmp/opencode', 'sb-shots-profile')
rmSync(profile, { recursive: true, force: true })
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`],
})
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker')
const origin = (await sw.evaluate(() => chrome.runtime.getURL(''))).replace(/\/$/, '')

const setSettings = (s) => sw.evaluate((v) => chrome.storage.local.set({ settings: v }), s)
const setCapture = (id, dataUrl, w, h) =>
  sw.evaluate(
    ([key, url, ww, hh]) => chrome.storage.session.set({ [key]: { dataUrl: url, rect: { x: 0, y: 0, width: ww, height: hh }, ts: Date.now() } }),
    [`capture.${id}`, dataUrl, w, h],
  )

async function shotPair(html, viewport) {
  const p = await ctx.newPage()
  await p.setViewportSize(viewport)
  await p.setContent(html)
  const png = await p.screenshot({ type: 'png' })
  await p.close()
  return `data:image/png;base64,${png.toString('base64')}`
}

const PAGE_CSS = `body{margin:0;background:#eef1f5;font:17px/1.6 Georgia,serif;color:#18181b}
header{padding:12px 22px;background:#111827;color:#fff;font:14px system-ui}
main{max-width:760px;margin:0 auto;padding:26px 22px}
h1{font:600 26px system-ui;margin:0 0 16px}p{margin:.6em 0}
code{font:15px/1.5 ui-monospace,monospace;background:#f3f4f6;padding:2px 5px;border-radius:4px}
.opt{margin:4px 0}`

const PAGE = (body) => `<!doctype html><meta charset="utf-8"><style>${PAGE_CSS}</style>
<header>Canvas · Homework 4 — Algebra</header><main>${body}</main>`

const PAGES = {
  math: PAGE(`<h1>Problem 3</h1><p>A train travels 240 km in 3 hours, then 180 km in 2 hours.</p><p>What is its average speed for the whole journey?</p>`),
  quiz: PAGE(`<h1>Which process do plants use to make food?</h1><p class="opt">A) Respiration</p><p class="opt">B) Photosynthesis</p><p class="opt">C) Digestion</p><p class="opt">D) Fermentation</p>`),
  ru: PAGE(`<h1>Отрывок</h1><p>Вода кипит при ста градусах Цельсия на уровне моря, но в горах температура кипения ниже из-за меньшего атмосферного давления.</p>`),
}

async function panelShot() {
  const p = await ctx.newPage()
  await p.setViewportSize({ width: 420, height: 700 })
  return p
}

async function injectConversation(page, user, answer) {
  await page.evaluate(
    ([u, a]) => {
      const thread = document.getElementById('thread')
      thread.innerHTML = ''
      const add = (role, text) => {
        const wrap = document.createElement('div')
        wrap.className = `msg ${role}`
        const body = document.createElement('div')
        body.className = 'msg-body'
        body.textContent = text
        wrap.appendChild(body)
        thread.appendChild(wrap)
      }
      add('user', u)
      add('assistant', a)
      const actions = document.createElement('div')
      actions.className = 'msg-actions'
      for (const label of ['Copy', 'Explain simpler', 'Retry']) {
        const b = document.createElement('button')
        b.textContent = label
        actions.appendChild(b)
      }
      thread.lastElementChild.appendChild(actions)
    },
    [user, answer],
  )
}

/** Compose the page backdrop + a real floating panel (dark bar, shadow). */
async function compose(id, name, bgPage, panelPage) {
  const bg = await shotPair(bgPage, { width: 1280, height: 800 })
  const panel = await panelPage.screenshot({ type: 'png' })
  await panelPage.close()
  const panelUrl = `data:image/png;base64,${panel.toString('base64')}`
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;width:1280px;height:800px;overflow:hidden;position:relative}
    .bg{position:absolute;inset:0;width:1280px;height:800px;object-fit:cover}
    .panel{position:absolute;right:40px;top:44px;width:420px;border-radius:12px;overflow:hidden;
      box-shadow:0 22px 60px rgba(15,23,42,.38);background:#fff;display:flex;flex-direction:column}
    .bar{height:36px;flex:0 0 auto;background:#111827;color:#fff;display:flex;align-items:center;
      justify-content:space-between;padding:0 12px;font:600 13px system-ui}
    .bar .x{color:#d1d5db;font-weight:400}
    .panel img{display:block;width:420px}
  </style>
  <img class="bg" src="${bg}">
  <div class="panel"><div class="bar"><span>Study Buddy</span><span class="x">✕</span></div><img src="${panelUrl}"></div>`
  const comp = await shotPair(html, { width: 1280, height: 800 })
  writeFileSync(join(out, name), Buffer.from(comp.split(',')[1], 'base64'))
  console.log('wrote', name)
}

// 1. Onboarding (Russian, no key).
await setSettings({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', uiLanguage: 'ru', answerLanguage: 'ru' })
{
  const p = await panelShot()
  await p.goto(`${origin}/src/chat/chat.html`)
  await p.waitForSelector('#view-welcome:not([hidden])')
  await compose('onboarding', '1-onboarding.png', PAGES.math, p)
}

// Key set, English UI from here on.
await setSettings({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-demo', uiLanguage: 'en', answerLanguage: 'en' })

async function capturePanel(id, cropHtml) {
  const png = await shotPair(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff;font:21px/1.5 Georgia,serif;padding:24px 28px}h2{font:600 18px system-ui;color:#4f9cff;margin:0 0 10px}</style>${cropHtml}`, { width: 420, height: 200 })
  await setCapture(id, png, 420, 200)
  const p = await panelShot()
  await p.goto(`${origin}/src/chat/chat.html?kind=capture&id=${id}`)
  await p.waitForFunction(() => document.getElementById('crop')?.naturalWidth > 0)
  return p
}

// 2. Solve.
{
  const p = await capturePanel('math', '<h2>Problem 3</h2><p>A train travels 240 km in 3 h, then 180 km in 2 h. What is its average speed?</p>')
  await injectConversation(p, 'Solve the problem shown in the image.',
    '1) Answer: 84 km/h\n\n2) Steps:\n• Distance = 240 + 180 = 420 km\n• Time = 3 + 2 = 5 h\n• Speed = 420 ÷ 5\n\n3) Check: 84 × 5 = 420 ✓')
  await compose('solve', '2-solve.png', PAGES.math, p)
}

// 3. Quiz.
{
  const p = await capturePanel('quiz', '<h2>Which process do plants use to make food?</h2><p>A) Respiration   B) Photosynthesis   C) Digestion   D) Fermentation</p>')
  await injectConversation(p, 'This is a multiple-choice question.',
    '1) Correct option: B) Photosynthesis\n\n2) Why: plants use sunlight, water and CO₂ to make glucose — that is making food.\n\n3) Why others are wrong:\n• A) Respiration releases energy from food, it does not make it.\n• C) Digestion breaks food down.\n• D) Fermentation converts sugars anaerobically.')
  await compose('quiz', '3-quiz.png', PAGES.quiz, p)
}

// 4. Translate.
{
  const p = await capturePanel('ru', '<h2>Отрывок</h2><p>Вода кипит при ста градусах Цельсия на уровне моря, но в горах температура кипения ниже.</p>')
  await injectConversation(p, 'Translate all the text in the image into English.',
    'Water boils at one hundred degrees Celsius at sea level, but in the mountains the boiling point is lower because of the reduced atmospheric pressure.')
  await compose('translate', '4-translate.png', PAGES.ru, p)
}

// 5. Settings (languages).
{
  const p = await panelShot()
  await p.goto(`${origin}/src/chat/chat.html?kind=error&message=Select%20a%20region%20to%20begin.`)
  await p.waitForSelector('#view-error:not([hidden])')
  await p.click('#view-error:not([hidden]) [data-goto-settings]')
  await p.waitForSelector('#view-settings:not([hidden])')
  await compose('settings', '5-settings.png', PAGES.math, p)
}

console.log(`Screenshots written to ${out}`)
await ctx.close()
