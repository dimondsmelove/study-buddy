// Phase-0 smoke test: loads the built extension in Chromium and drives the full
// capture flow:
//   START_SELECTION → overlay injection → drag a region → captureVisibleTab →
//   crop → chrome.storage.session → chat window host embedded in the page →
//   the chat page renders the crop.
//
// Trigger note: the keyboard shortcut itself (keypress → onCommand) is browser
// machinery that stays dormant in headless Chromium, so the flow is started
// from an extension page with the same runtime message the chat window will
// use for its "new selection" action. The shortcut's registration IS verified
// (chrome.commands.getAll). Verify the physical keypress in a real browser.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const root = resolve(fileURLToPath(import.meta.url), '..')
const dist = resolve(root, '..', 'dist')

// Test build: a copy of dist with host_permissions added, so capture works
// WITHOUT the activeTab grant that only a real toolbar click / shortcut press
// provides (Playwright can't click the browser action; its evaluate() trigger
// is not a user gesture). Production keeps activeTab-only; this only changes
// HOW capture is authorized, not the capture/crop/chat code path.
// (Solution inherited from OCR Buddy's verify-ux.mjs.)
const distTest = resolve(root, '..', 'dist-test')
rmSync(distTest, { recursive: true, force: true })
cpSync(dist, distTest, { recursive: true })
{
  const mf = join(distTest, 'manifest.json')
  const m = JSON.parse(readFileSync(mf, 'utf8'))
  m.host_permissions = ['<all_urls>']
  writeFileSync(mf, JSON.stringify(m, null, 2))
}

// Fresh profile each run: a reused persistent profile can restore a STALE
// service worker from the code cache (an old build!) — which once sent this
// very test in circles. Fresh dir = always the current dist/ code.
const profile = join('/tmp/opencode', 'study-buddy-profile')
rmSync(profile, { recursive: true, force: true })

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}`)
  if (!ok) failures++
}

// A local page to capture (data: URLs are restricted; file:// needs a toggle).
const pageHtml = `<!doctype html><meta charset="utf-8"><title>target</title>
<body style="font:24px system-ui"><p style="padding:40px">homework text 12345</p></body>`

// The same server doubles as a mock OpenAI-compatible endpoint for the AI
// tests below: /v1/chat/completions streams two SSE deltas, and the request
// body is kept so the test can assert the crop actually went out as an image.
// `failModel` makes that one model answer 503, to exercise the fallback chain.
let lastAiRequest = null
let failModel = null
const server = createServer((req, res) => {
  if (req.url?.includes('/chat/completions')) {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        lastAiRequest = JSON.parse(body)
      } catch {
        lastAiRequest = null
      }
      if (failModel && lastAiRequest?.model === failModel) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'model unavailable' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(pageHtml)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const url = `${origin}/`

const ctx = await chromium.launchPersistentContext(profile, {
  // channel 'chromium' = the full build with the NEW headless, which loads
  // extensions (the default "headless shell" does not).
  channel: 'chromium',
  args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`],
})

const pageErrors = []
ctx.on('page', (p) => p.on('pageerror', (err) => pageErrors.push(String(err))))

try {
  let [sw] = ctx.serviceWorkers()
  if (!sw) sw = await ctx.waitForEvent('serviceworker')
  check(true, 'service worker started')

  // The shortcut must be registered (its physical dispatch needs a real window).
  const commands = await sw.evaluate(() => chrome.commands.getAll())
  const shortcut = commands.find((c) => c.name === 'start-capture')?.shortcut
  check(Boolean(shortcut), `start-capture command registered (${shortcut || 'MISSING'})`)

  // Seed a key so the chat pages used by the capture-flow tests don't detour
  // into onboarding; the onboarding path itself is tested later on clean storage.
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), {
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-test-123',
    uiLanguage: 'auto',
    answerLanguage: 'auto',
  })

  const page = await ctx.newPage()
  await page.goto(url)
  await page.bringToFront()

  // An extension page that triggers the same flow the chat window's
  // "new selection" action will use. It must NOT be the active tab when the
  // message is sent, or the SW would select on it instead of the target page.
  // chrome-extension:// URLs have an opaque origin: URL.origin is the literal
  // string "null" — so build the origin by hand.
  const chatOrigin = (await sw.evaluate(() => chrome.runtime.getURL(''))).replace(/\/$/, '')
  const trigger = await ctx.newPage()
  await trigger.goto(`${chatOrigin}/src/chat/chat.html`)
  await page.bringToFront()
  await trigger.evaluate(() => chrome.runtime.sendMessage({ type: 'START_SELECTION' }))

  let overlayOk = true
  try {
    // DOM marker, not a window flag: content scripts run in an ISOLATED world,
    // so window.__studyBuddyOverlay is invisible to the page's main world —
    // but the overlay's DOM is shared.
    await page.waitForSelector('[data-study-buddy="overlay"]', { timeout: 5000 })
  } catch (err) {
    overlayOk = false
    // Diagnostic dump (kept for future failures): pages, session storage, and a
    // manual replication of each injection step.
    console.log('  DIAG pages:', ctx.pages().map((p) => p.url()))
    console.log('  DIAG session:', JSON.stringify(await sw.evaluate(() => chrome.storage.session.get()).catch((e) => String(e))))
    console.log('  DIAG manual:', JSON.stringify(
      await sw
        .evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
          const out = { activeTab: tab && { id: tab.id, url: tab.url } }
          if (!tab?.id) return out
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/overlay.js'] })
            out.inject = 'ok'
          } catch (e) {
            out.inject = String(e)
          }
          try {
            await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_OVERLAY' })
            out.msg = 'ok'
          } catch (e) {
            out.msg = String(e)
          }
          return out
        })
        .catch((e) => String(e)),
    ))
  }
  check(overlayOk, 'selection overlay appeared (START_SELECTION → injection)')

  // Drag a 120x80 box at (60, 50).
  await page.mouse.move(60, 50)
  await page.mouse.down()
  await page.mouse.move(180, 130, { steps: 5 })
  await page.mouse.up()

  // state 'attached': the host wrapper is 0×0 (the panel lives inside its
  // closed shadow root) — "visible" waits would never pass.
  await page.waitForSelector('[data-study-buddy="chat"]', { timeout: 5000, state: 'attached' })
  check(true, 'chat window host embedded near the selection')

  // The SW should have captured, cropped, and stored the region.
  const capture = await sw.evaluate(async () => {
    const all = await chrome.storage.session.get()
    const key = Object.keys(all).find((k) => k.startsWith('capture.'))
    if (!key) return { ok: false, why: JSON.stringify(Object.keys(all)) }
    const { dataUrl } = all[key]
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
    return { ok: true, id: key.slice('capture.'.length), w: bitmap.width, h: bitmap.height }
  })
  check(capture.ok, `crop stored in session storage (${capture.why ?? `${capture.w}x${capture.h}px`})`)
  check(
    capture.ok && Math.abs(capture.w - 120) <= 2 && Math.abs(capture.h - 80) <= 2,
    `crop size matches the selection (${capture.w}x${capture.h}, expected ~120x80)`,
  )

  // The chat page must render the crop when opened with this capture id.
  const chat = await ctx.newPage()
  await chat.goto(`${chatOrigin}/src/chat/chat.html?kind=capture&id=${capture.id}`)
  const imgLoaded = await chat.evaluate(async () => {
    const img = document.getElementById('crop')
    await img.decode().catch(() => {})
    return img.naturalWidth > 0
  })
  check(imgLoaded, 'chat page renders the captured crop')
  await chat.close()
  await trigger.close()

  // Settings round trip: no onboarding any more — a bare chat page with no key
  // and no params shows the no-state error view, whose ⚙ Settings… button is
  // the rescue path, and Save persists. Clearing storage gives the clean state.
  await sw.evaluate(() => chrome.storage.local.remove('settings'))
  const settings = await ctx.newPage()
  await settings.goto(`${chatOrigin}/src/chat/chat.html`)
  await settings.waitForSelector('#view-error:not([hidden])')
  check(true, 'bare chat page shows the no-state error view')
  await settings.click('#view-error:not([hidden]) [data-goto-settings]')
  await settings.waitForSelector('#view-settings:not([hidden])')
  check(true, 'settings view opens from the error view')
  await settings.click('.advanced summary') // advanced block is collapsed
  await settings.fill('#set-api-key', 'sk-test-123')
  await settings.click('#set-save')
  // state 'attached': an element WITH [hidden] can never be "visible" — the
  // selector already encodes the hidden-ness we're waiting for.
  await settings.waitForSelector('#view-settings[hidden]', { state: 'attached' })
  const stored = (await settings.evaluate(() => chrome.storage.local.get())).settings
  check(
    stored && stored.provider === 'openrouter' &&
      stored.baseUrl === 'https://openrouter.ai/api/v1' &&
      stored.apiKey === 'sk-test-123' &&
      stored.uiLanguage === 'auto' &&
      stored.answerLanguage === 'auto' &&
      !('model' in stored),
    `settings persisted with languages and no model (${JSON.stringify(stored)})`,
  )
  await settings.close()

  // AI answering: point settings at the mock endpoint and send the captured
  // crop through the Solve preset. The reply must stream into the thread, and
  // the request must carry the crop as an image_url. The model is fixed by the
  // app's chain (settings.model no longer exists).
  const PRIMARY = 'deepseek/deepseek-v4-flash-vision-exp'
  const FALLBACK = 'google/gemini-2.5-flash-lite'
  // Pin uiLanguage 'en' so the prompt assertions below are deterministic
  // regardless of the test machine's browser locale (auto would follow it).
  await sw.evaluate(
    async (s) => chrome.storage.local.set({ settings: s }),
    { provider: 'custom', baseUrl: `${origin}/v1`, apiKey: 'sk-test-123', uiLanguage: 'en', answerLanguage: 'auto' },
  )
  // Wait until the stored crop is decoded — i.e. `activeImage` is set — or the
  // preset click could race the storage read and send a caption-less question.
  const openCapture = async () => {
    const p = await ctx.newPage()
    await p.goto(`${chatOrigin}/src/chat/chat.html?kind=capture&id=${capture.id}`)
    await p.waitForFunction(() => {
      const i = document.getElementById('crop')
      return !!i?.src && i.naturalWidth > 0
    })
    return p
  }
  const waitReply = (p) =>
    p
      .waitForFunction(
        () => {
          // The bubble is rendered as Markdown, so marked's trailing newline is
          // expected — compare on the trimmed text.
          const body = document.querySelector('.msg.assistant .msg-body')
          return body && body.textContent?.trim() === 'Hello world' ? 'Hello world' : false
        },
        { timeout: 5000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null)

  const ai = await openCapture()
  await ai.click('.preset[data-preset="solve"]')
  const reply = await waitReply(ai)
  check(reply === 'Hello world', `assistant reply streamed into the thread (${reply ?? 'no reply'})`)
  const firstUser = lastAiRequest?.messages?.find((m) => m.role === 'user')
  const sentImage =
    Array.isArray(firstUser?.content) &&
    firstUser.content.some((p) => p?.type === 'image_url' && typeof p.image_url?.url === 'string' && p.image_url.url.startsWith('data:image/png'))
  check(sentImage, 'request carried the crop as an image_url data URL')
  check(lastAiRequest?.model === PRIMARY, `request used the fixed primary model (${lastAiRequest?.model ?? 'MISSING'})`)
  // Prompt regression: the system prompt carries the grounding rules, the
  // Solve template goes out verbatim, and the factual-task params are set
  // (temperature 0 + max_tokens cutoff from src/shared/prompts).
  const sysMsg = lastAiRequest?.messages?.[0]
  check(
    sysMsg?.role === 'system' &&
      typeof sysMsg.content === 'string' &&
      sysMsg.content.includes('# Grounding') &&
      sysMsg.content.includes('Ground every answer in the image'),
    'system prompt carries the grounding rules',
  )
  const solveText = Array.isArray(firstUser?.content) ? firstUser.content[0]?.text : null
  check(
    typeof solveText === 'string' && solveText.startsWith('Solve the problem shown in the image'),
    `solve prompt sent as expected (${String(solveText ?? '').slice(0, 40)}…)`,
  )
  check(
    lastAiRequest?.temperature === 0 && lastAiRequest?.max_tokens === 2048,
    `request carried solve params (t=${lastAiRequest?.temperature}, max_tokens=${lastAiRequest?.max_tokens})`,
  )
  await ai.close()

  // RU dictionary: with uiLanguage 'ru' the NATIVE RU templates and system
  // prompt must go out (answerLanguage auto + ru UI resolves to Russian).
  await sw.evaluate(
    async (s) => chrome.storage.local.set({ settings: s }),
    { provider: 'custom', baseUrl: `${origin}/v1`, apiKey: 'sk-test-123', uiLanguage: 'ru', answerLanguage: 'auto' },
  )
  const aiRu = await openCapture()
  await aiRu.click('.preset[data-preset="solve"]')
  await waitReply(aiRu)
  const ruUser = lastAiRequest?.messages?.find((m) => m.role === 'user')
  const ruText = Array.isArray(ruUser?.content) ? ruUser.content[0]?.text : null
  check(
    typeof ruText === 'string' && ruText.startsWith('Реши задачу, показанную на изображении'),
    `RU dictionary selected for ru UI (${String(ruText ?? '').slice(0, 30)}…)`,
  )
  const ruSys = lastAiRequest?.messages?.[0]
  check(
    ruSys?.role === 'system' && typeof ruSys.content === 'string' && ruSys.content.includes('# Опора на изображение'),
    'RU system prompt sent for ru UI',
  )
  await aiRu.close()
  // Back to EN for the fallback test below.
  await sw.evaluate(
    async (s) => chrome.storage.local.set({ settings: s }),
    { provider: 'custom', baseUrl: `${origin}/v1`, apiKey: 'sk-test-123', uiLanguage: 'en', answerLanguage: 'auto' },
  )

  // Fallback: make the primary answer 503; the next model must take over and
  // the thread must note the switch.
  failModel = PRIMARY
  const fb = await openCapture()
  await fb.click('.preset[data-preset="solve"]')
  const fbReply = await waitReply(fb)
  check(fbReply === 'Hello world', `fallback model answered (${fbReply ?? 'no reply'})`)
  check(lastAiRequest?.model === FALLBACK, `fallback used the next model (${lastAiRequest?.model ?? 'MISSING'})`)
  check(await fb.evaluate(() => !!document.querySelector('.msg.note')), 'fallback notice shown in the thread')
  await fb.close()

  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`)
} finally {
  await ctx.close()
  server.close()
}

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
