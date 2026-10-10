// Launch a real-provider Chromium test session with a demo page. The profile
// persists under ~/.config/study-buddy/playtest-profile; saved languages and
// custom connections survive restarts. Close the browser window to finish.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const dist = join(root, 'dist')
const profile = process.env.PLAYTEST_PROFILE?.trim()
  ? resolve(process.env.PLAYTEST_PROFILE.trim())
  : join(homedir(), '.config', 'study-buddy', 'playtest-profile')
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

function openRouterCredentials() {
  const envKey = process.env.OPENROUTER_API_KEY?.trim()
  if (envKey) return { apiKey: envKey, baseUrl: DEFAULT_BASE_URL }
  const file = join(homedir(), '.config', 'study-buddy', 'credentials.json')
  if (!existsSync(file)) return undefined
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('credentials.json is invalid JSON.')
  }
  const c = parsed?.openrouter
  if (typeof c?.apiKey !== 'string' || !c.apiKey.trim()) return undefined
  const baseUrl = typeof c.baseUrl === 'string' ? c.baseUrl.trim() : ''
  return {
    apiKey: c.apiKey.trim(),
    baseUrl: baseUrl || DEFAULT_BASE_URL,
  }
}

mkdirSync(profile, { recursive: true })

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
<header>Study Buddy demo — drag a region here to start. <b>Ctrl+Shift+Y</b> or the toolbar icon starts selection; chat appears after a successful crop.</header>
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

const uiLanguageOverride = process.env.PLAYTEST_UI_LANGUAGE?.trim()
const answerLanguageOverride = process.env.PLAYTEST_ANSWER_LANGUAGE?.trim()
if (uiLanguageOverride && !['en', 'ru', 'auto'].includes(uiLanguageOverride)) throw new Error('PLAYTEST_UI_LANGUAGE must be en, ru or auto.')
if (answerLanguageOverride && !['auto', 'en', 'ru', 'uk', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr', 'zh', 'ja'].includes(answerLanguageOverride)) throw new Error('PLAYTEST_ANSWER_LANGUAGE is not a supported answer language.')
const headless = process.env.PLAYTEST_HEADLESS === '1'
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(DEMO)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`

let ctx
try {
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless,
    viewport: headless ? { width: 1200, height: 800 } : null,
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  })

  const extensionPrefix = 'chrome-extension://'
  let sw = ctx.serviceWorkers().find(worker => worker.url().startsWith(extensionPrefix))
  if (!sw) {
    sw = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ctx.off('serviceworker', onWorker)
        reject(new Error('Study Buddy extension worker did not start.'))
      }, 15_000)
      const onWorker = worker => {
        if (!worker.url().startsWith(extensionPrefix)) return
        clearTimeout(timeout)
        ctx.off('serviceworker', onWorker)
        resolve(worker)
      }
      ctx.on('serviceworker', onWorker)
      const current = ctx.serviceWorkers().find(worker => worker.url().startsWith(extensionPrefix))
      if (current) onWorker(current)
    })
  }

  // Ask Chromium to reload the unpacked extension from disk. This refreshes
  // built files while keeping chrome.storage.local and IndexedDB in the profile.
  const extensionId = new URL(sw.url()).hostname
  const previousWorker = sw
  const browserCdp = await ctx.browser().newBrowserCDPSession()
  const loaded = await browserCdp.send('Extensions.loadUnpacked', { path: dist })
  if (loaded.id !== extensionId) throw new Error('Chromium loaded a different Study Buddy extension.')
  sw = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ctx.off('serviceworker', onWorker)
      reject(new Error('Study Buddy extension worker did not restart from the current build.'))
    }, 15_000)
    const onWorker = worker => {
      if (worker === previousWorker || !worker.url().startsWith(`chrome-extension://${extensionId}/`)) return
      clearTimeout(timeout)
      ctx.off('serviceworker', onWorker)
      resolve(worker)
    }
    ctx.on('serviceworker', onWorker)
    const current = ctx.serviceWorkers().find(worker => worker !== previousWorker && worker.url().startsWith(`chrome-extension://${extensionId}/`))
    if (current) onWorker(current)
  })

  // Confirm that the refreshed worker still sees the dedicated profile's saved data.
  const envKey = process.env.OPENROUTER_API_KEY?.trim()
  const existing = await sw.evaluate(async (defaultBaseUrl) => {
    const saved = (await chrome.storage.local.get('settings')).settings
    const endpoint = typeof saved?.baseUrl === 'string' ? saved.baseUrl.trim().replace(/\/+$/, '') : ''
    const apiKey = typeof saved?.apiKey === 'string' ? saved.apiKey.trim() : ''
    return {
      hasKey: !!apiKey,
      customConnection: saved?.provider === 'custom' || !!(endpoint && endpoint !== defaultBaseUrl),
    }
  }, DEFAULT_BASE_URL)
  const credentials = existing.customConnection || (existing.hasKey && !envKey) ? undefined : openRouterCredentials()
  const merged = await sw.evaluate(async ({ defaultBaseUrl, envKey, credentials, uiLanguageOverride, answerLanguageOverride }) => {
    const saved = (await chrome.storage.local.get('settings')).settings ?? {}
    const endpoint = typeof saved.baseUrl === 'string' ? saved.baseUrl.trim().replace(/\/+$/, '') : ''
    const savedApiKey = typeof saved.apiKey === 'string' ? saved.apiKey.trim() : ''
    const savedBaseUrl = typeof saved.baseUrl === 'string' ? saved.baseUrl.trim() : ''
    const customConnection = saved.provider === 'custom' || !!(endpoint && endpoint !== defaultBaseUrl)
    const settings = {
      ...saved,
      uiLanguage: uiLanguageOverride || (typeof saved.uiLanguage === 'string' ? saved.uiLanguage : 'en'),
      answerLanguage: answerLanguageOverride || (typeof saved.answerLanguage === 'string' ? saved.answerLanguage : 'en'),
    }
    if (customConnection) {
      if (!settings.provider) settings.provider = 'custom'
      settings.baseUrl = savedBaseUrl
      settings.apiKey = savedApiKey
      await chrome.storage.local.set({ settings })
      return { ok: true, provider: 'custom', source: 'saved custom connection' }
    }
    settings.provider = 'openrouter'
    settings.baseUrl = envKey ? defaultBaseUrl : credentials?.baseUrl || savedBaseUrl || defaultBaseUrl
    settings.apiKey = envKey || savedApiKey || credentials?.apiKey || ''
    if (!settings.apiKey) return { ok: false, error: 'No OpenRouter key is configured in saved settings, OPENROUTER_API_KEY, or credentials.json.' }
    await chrome.storage.local.set({ settings })
    const source = envKey ? 'OPENROUTER_API_KEY' : savedApiKey ? 'saved OpenRouter connection' : 'credentials file'
    return { ok: true, provider: 'openrouter', source }
  }, { defaultBaseUrl: DEFAULT_BASE_URL, envKey, credentials, uiLanguageOverride, answerLanguageOverride })
  if (!merged.ok) throw new Error(merged.error)

  const page = await ctx.newPage()
  await page.goto(url)
  await page.bringToFront()

  const close = new Promise((resolve) => ctx.once('close', resolve))
  process.once('SIGINT', () => void ctx.close())
  process.once('SIGTERM', () => void ctx.close())
  console.log(`\nStudy Buddy test browser is up.`)
  console.log(`  profile:  ${profile}`)
  console.log(`  provider: ${merged.provider} (${merged.source})`)
  console.log(`  models:   DeepSeek → Gemini 2.5 Flash Lite → GPT-5 Nano (automatic fallback)`)
  console.log(`  demo:     ${url}`)
  console.log(`\nSelect a region with Ctrl+Shift+Y or the toolbar icon; chat opens after capture. Choose a task or ask a question.`)
  console.log(`Saved settings and History remain in this profile after closing the browser.\n`)

  await close
} finally {
  await ctx?.close().catch(() => {})
  server.close()
}
