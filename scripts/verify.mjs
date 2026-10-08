// Phase-0 smoke test: loads the built extension in Chromium and drives the full
// capture flow:
//   START_SELECTION → overlay injection → drag a region → captureVisibleTab →
//   crop → chrome.storage.session → chat window host embedded in the page →
//   the chat page renders the crop.
//
// The toolbar path is invoked through Chromium's native extension action so
// activeTab is granted by the same browser gesture as a real click. The
// shortcut registration is verified here; dispatching the physical key still
// requires a headed browser.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const root = resolve(fileURLToPath(import.meta.url), '..')
const dist = resolve(root, '..', 'dist')

// Fresh profile each run: a reused persistent profile can restore a STALE
// service worker from the code cache (an old build!) — which once sent this
// very test in circles. Fresh dir = always the current dist/ code.
const profile = mkdtempSync(join(tmpdir(), 'study-buddy-verify-'))

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}`)
  if (!ok) failures++
}

// A local page to capture (data: URLs are restricted; file:// needs a toggle).
const pageHtml = `<!doctype html><meta charset="utf-8"><title>target</title>
<style>body{margin:0;font:24px system-ui}.capture-proof{position:fixed;left:220px;top:230px;width:140px;height:90px;background:rgb(19,135,64)}</style>
<body><p style="padding:40px">homework text 12345</p><div class="capture-proof"></div></body>`

// The same server doubles as a mock OpenAI-compatible endpoint for the AI
// tests below: /v1/chat/completions streams two SSE deltas, and the request
// body is kept so the test can assert the crop actually went out as an image.
// `failModel` makes that one model answer 503, to exercise the fallback chain.
let lastAiRequest = null
let failModel = null
let responseMode = 'normal'
let requestCount = 0
const server = createServer((req, res) => {
  if (req.url?.includes('/chat/completions')) {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requestCount++
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
      if (responseMode === 'slow') {
        const interval = setInterval(() => res.write('data: {"choices":[{"delta":{"content":" step"}}]}\n\n'), 180)
        const finish = setTimeout(() => { clearInterval(interval); res.end('data: [DONE]\n\n') }, 10_000)
        res.on('close', () => { clearInterval(interval); clearTimeout(finish) })
        return
      }
      if (responseMode === 'truncated') { res.end('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'); return }
      if (responseMode === 'interrupted') { res.end(); return }
      if (responseMode === 'provider-error') { res.end('data: {"error":{"message":"private-provider-fixture"}}\n\n'); return }
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
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
})

const pageErrors = []
ctx.on('page', (p) => p.on('pageerror', (err) => pageErrors.push(String(err))))
await ctx.route('https://**/*', route => route.abort()) // fail closed on accidental non-mock provider use

try {
  let [sw] = ctx.serviceWorkers()
  if (!sw) sw = await ctx.waitForEvent('serviceworker')
  check(true, 'service worker started')
  const extensionId = new URL(sw.url()).hostname
  const browserCdp = await ctx.browser().newBrowserCDPSession()
  const triggerAction = async (targetPage) => {
    await targetPage.bringToFront()
    const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] })
    const target = targetInfos.find((item) => item.type === 'tab' && item.url === targetPage.url())
    if (!target) throw new Error(`Could not find the browser tab for ${targetPage.url()}; targets: ${targetInfos.map((item) => `${item.type}:${item.url}`).join(' | ')}`)
    await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId })
  }

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
  check(await page.locator('[data-study-buddy]').count() === 0, 'fresh page has no Study Buddy host or selection overlay')

  const chatOrigin = (await sw.evaluate(() => chrome.runtime.getURL(''))).replace(/\/$/, '')
  await triggerAction(page)

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
  check(overlayOk, 'native extension action granted activeTab and started region selection')

  // Drag a 120x80 box at (60, 50).
  await page.mouse.move(60, 50)
  await page.mouse.down()
  await page.mouse.move(180, 130, { steps: 5 })
  await page.mouse.up()

  // state 'attached': the host wrapper is 0×0 (the panel lives inside its
  // closed shadow root) — "visible" waits would never pass.
  await page.waitForSelector('[data-study-buddy="chat"]', { timeout: 5000, state: 'attached' })
  check(true, 'chat window host embedded near the selection')
  const liveFrame = page.frames().find((frame) => frame.url().startsWith(chatOrigin))
  await liveFrame.waitForFunction(() => document.getElementById('crop')?.naturalWidth > 0)

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
  await chat.waitForFunction(() => document.getElementById('crop')?.naturalWidth > 0)
  const imgLoaded = await chat.evaluate(async () => {
    const img = document.getElementById('crop')
    await img.decode().catch(() => {})
    return img.naturalWidth > 0
  })
  check(imgLoaded, 'chat page renders the captured crop')
  await chat.close()
  const beforeCleanSelection = await liveFrame.locator('#crop').getAttribute('src')
  await triggerAction(page)
  await page.waitForSelector('[data-study-buddy="overlay"]', { timeout: 5000 })
  await page.mouse.move(230, 240)
  await page.mouse.down()
  await page.mouse.move(330, 300, { steps: 4 })
  await page.mouse.up()
  const cleanCrop = await sw.evaluate(async (previousId) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const captures = Object.entries(await chrome.storage.session.get())
        .filter(([key]) => key.startsWith('capture.'))
        .sort(([, a], [, b]) => a.ts - b.ts)
      const id = captures.at(-1)?.[0].slice('capture.'.length)
      if (id && id !== previousId) return id
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return undefined
  }, capture.id)
  check(cleanCrop !== capture.id, 'a second native selection stores a fresh crop while the chat is open')
  await liveFrame.waitForFunction((previous) => {
    const img = document.getElementById('crop')
    return img?.src !== previous && img?.naturalWidth > 0
  }, beforeCleanSelection)
  const cleanPixel = await liveFrame.evaluate(() => {
    const img = document.getElementById('crop')
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(img, 0, 0)
    const pixel = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
    return [...pixel].slice(0, 3)
  })
  check(cleanPixel[1] > 100 && cleanPixel[1] > cleanPixel[0] * 2, `capture excludes the overlapping chat panel (${cleanPixel.join(',')})`)

  const alertCdp = await ctx.newCDPSession(page)
  const alertState = async () => {
    const { root: documentNode } = await alertCdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const find = (node) => {
      if (node.attributes?.includes('role') && node.attributes[node.attributes.indexOf('role') + 1] === 'alert') return node
      for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
        const found = find(child)
        if (found) return found
      }
    }
    const node = find(documentNode)
    if (!node) return undefined
    const hidden = node.attributes?.includes('hidden') ?? false
    const styleIndex = node.attributes?.indexOf('style') ?? -1
    const style = styleIndex < 0 ? '' : node.attributes[styleIndex + 1]
    const box = hidden ? undefined : (await alertCdp.send('DOM.getBoxModel', { nodeId: node.nodeId })).model.border
    return { hidden, style, box }
  }
  const errorTabId = await sw.evaluate(async (targetUrl) => (await chrome.tabs.query({ url: targetUrl }))[0]?.id, url)
  await sw.evaluate(async (tabId) => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_FAILED', message: 'synthetic technical failure' }, () => resolve())
  }), errorTabId)
  const visibleAlert = await alertState()
  check(Boolean(visibleAlert && !visibleAlert.hidden && visibleAlert.style.includes('display: flex')),
    'technical capture failure presents a dismissible host notice')
  const noticeScreenPoint = {
    x: Math.floor(visibleAlert.box[0]),
    y: Math.floor((visibleAlert.box[1] + visibleAlert.box[7]) / 2),
  }
  const visibleNoticePixel = await page.evaluate(async ({ screenshot, x, y }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${screenshot}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(img, 0, 0)
    return [...context.getImageData(x, y, 1, 1).data].slice(0, 3)
  }, { screenshot: (await page.screenshot()).toString('base64'), ...noticeScreenPoint })
  const noticeIsRed = ([red, green, blue]) => red > 150 && red > green * 1.3 && red > blue * 1.3
  check(noticeIsRed(visibleNoticePixel), `visible error notice has a detectable border pixel (${visibleNoticePixel.join(',')})`)
  await triggerAction(page)
  await page.waitForSelector('[data-study-buddy="overlay"]')
  let selectedAlert = await alertState()
  check(Boolean(selectedAlert?.hidden && selectedAlert.style.includes('display: none')),
    'selection hides the error notice before another screenshot')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'open')
  selectedAlert = await alertState()
  check(Boolean(selectedAlert && !selectedAlert.hidden && selectedAlert.style.includes('display: flex')),
    'Escape restores the visible error notice with the previous chat state')

  const priorToastSrc = await liveFrame.locator('#crop').getAttribute('src')
  await triggerAction(page)
  await page.waitForSelector('[data-study-buddy="overlay"]')
  const viewport = page.viewportSize()
  const toastLeft = viewport.width - 390
  await page.mouse.move(toastLeft, 20)
  await page.mouse.down()
  await page.mouse.move(toastLeft + 250, 140, { steps: 5 })
  await page.mouse.up()
  await liveFrame.waitForFunction((previous) => {
    const img = document.getElementById('crop')
    return img?.src !== previous && img?.naturalWidth > 0
  }, priorToastSrc)
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
  const cropPoint = {
    x: Math.round((noticeScreenPoint.x - toastLeft) * devicePixelRatio),
    y: Math.round((noticeScreenPoint.y - 20) * devicePixelRatio),
  }
  const toastCropPixel = await liveFrame.evaluate(({ x, y }) => {
    const img = document.getElementById('crop')
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(img, 0, 0)
    return [...context.getImageData(x, y, 1, 1).data].slice(0, 3)
  }, cropPoint)
  check(!noticeIsRed(toastCropPixel) && (await alertState())?.hidden,
    `retry crop excludes the prior error notice border (${toastCropPixel.join(',')})`)
  await alertCdp.detach()

  await triggerAction(page)
  await page.waitForSelector('[data-study-buddy="overlay"]', { timeout: 5000 })
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-study-buddy="overlay"]', { state: 'detached' })
  await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'open')
  check(page.frames().includes(liveFrame), 'Escape restores the expanded chat and retains its iframe')

  await triggerAction(page)
  await page.waitForSelector('[data-study-buddy="overlay"]', { timeout: 5000 })
  await page.mouse.move(75, 75)
  await page.mouse.down()
  await page.mouse.move(76, 76)
  await page.mouse.up()
  await page.waitForSelector('[data-study-buddy="overlay"]', { state: 'detached' })
  await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'open')
  check(page.frames().includes(liveFrame), 'a tiny accidental selection restores the same expanded chat')

  // Settings round trip: no onboarding any more — a bare chat page with no key
  // and no params shows the no-state error view, whose ⚙ Settings… button is
  // the rescue path, and Save persists. Clearing storage gives the clean state.
  await sw.evaluate(() => chrome.storage.local.remove('settings'))
  const settings = await ctx.newPage()
  await settings.goto(`${chatOrigin}/src/chat/chat.html?kind=error&message=Settings%20fixture`)
  await settings.waitForSelector('#view-error:not([hidden])')
  check(true, 'explicit error state retains the settings rescue path')
  await settings.click('#view-error:not([hidden]) [data-goto-settings]')
  await settings.waitForSelector('#view-settings:not([hidden])')
  check(true, 'settings view opens from the error view')
  await settings.click('.advanced summary') // advanced block is collapsed
  await settings.fill('#set-api-key', 'sk-test-123')
  await settings.evaluate(() => {
    globalThis.fixtureStorageSet = chrome.storage.local.set
    chrome.storage.local.set = async () => { throw new Error('expected fixture write failure') }
  })
  await settings.click('#set-save')
  await settings.waitForFunction(() => document.getElementById('set-msg')?.textContent?.includes('Could not save'))
  check(await settings.locator('#view-settings').isVisible() && !(await settings.evaluate(() => chrome.storage.local.get('settings'))).settings, 'failed settings save stays on the form without updating saved data')
  await settings.evaluate(() => { chrome.storage.local.set = globalThis.fixtureStorageSet; delete globalThis.fixtureStorageSet })
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
    await p.goto(`${chatOrigin}/src/chat/chat.html?kind=error&message=Fixture`)
    const fresh = await p.evaluate(() => chrome.runtime.sendMessage({ type: 'CONVERSATION', action: 'create', title: 'Verify fixture' }))
    if (!fresh.ok) throw new Error(fresh.error)
    await p.goto(`${chatOrigin}/src/chat/chat.html?kind=capture&id=${capture.id}&conversation=${fresh.value.id}`)
    await p.waitForFunction(() => {
      const i = document.getElementById('crop')
      return !!i?.src && i.naturalWidth > 0
    })
    // Test-owned database only: reset between independent scenarios. The real
    // interval boundary and concurrent starts are tested separately below.
    await resetCooldown(p)
    return p
  }
  const resetCooldown = (p) => p.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('study-buddy-conversations', 1)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('state', 'readwrite')
      const store = tx.objectStore('state')
      const get = store.get('state')
      get.onsuccess = () => store.put({ ...get.result, lastStartedAt: 0 })
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(new Error('fixture state abort')) }
    }
    request.onerror = () => reject(request.error)
  }))
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

  failModel = null
  const evidence = resolve(root, '..', 'review', 'loop')
  mkdirSync(evidence, { recursive: true })
  const waitSaved = (p, status = 'complete') => p.waitForFunction((expected) => {
    const nodes = [...document.querySelectorAll('.reply-status')]
    return nodes.at(-1)?.textContent?.includes(expected)
  }, status, { timeout: 7000 })
  const readSaved = (p) => p.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('study-buddy-conversations', 1)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['conversations', 'state'], 'readonly')
      const state = tx.objectStore('state').get('state')
      const conversations = tx.objectStore('conversations').getAll()
      tx.oncomplete = () => { db.close(); resolve({ state: state.result, conversations: conversations.result }) }
      tx.onabort = () => reject(tx.error)
    }
  }))

  const settingsReadFailure = await openCapture()
  const beforeReadFailure = requestCount
  await settingsReadFailure.evaluate(() => { chrome.storage.local.get = async () => { throw new Error('expected fixture read failure') } })
  await settingsReadFailure.click('[data-preset="hint"]')
  await settingsReadFailure.waitForFunction(() => !document.getElementById('operation-error')?.hidden)
  check(requestCount === beforeReadFailure && await settingsReadFailure.locator('.msg').count() === 0, 'failed settings read is visible and cannot silently switch to defaults or start a request')
  await settingsReadFailure.close()

  const rapid = await openCapture()
  const beforeRapid = requestCount
  responseMode = 'slow'
  await rapid.evaluate(() => {
    const originalGet = chrome.storage.local.get.bind(chrome.storage.local)
    chrome.storage.local.get = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 80))
      return originalGet(...args)
    }
    // Dispatch both handlers even after the first disables its button: exercise
    // the asynchronous reservation invariant, not just disabled DOM controls.
    for (const kind of ['hint', 'solve']) document.querySelector(`[data-preset="${kind}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await rapid.waitForFunction(() => document.querySelector('.msg.assistant .msg-body')?.textContent?.includes('Hello'))
  check(requestCount === beforeRapid + 1 && await rapid.locator('.msg.user').count() === 1 && await rapid.locator('#ask-btn').textContent() === 'Stop' && !await rapid.locator('#ask-btn').isDisabled(), 'rapid same-page events reserve one start before settings resolve and retain its Stop controller')
  await rapid.click('#ask-btn')
  await waitSaved(rapid, 'Stopped')
  check((await readSaved(rapid)).conversations.find(c => c.id === (rapid.url().match(/conversation=([^&]+)/)?.[1])).turns.at(-1).status === 'cancelled', 'the surviving same-page request can still be cancelled and saved')
  await rapid.close()
  responseMode = 'normal'

  const hint = await openCapture()
  await hint.setViewportSize({ width: 480, height: 660 })
  await hint.click('[data-preset="hint"]')
  await waitSaved(hint, 'Complete')
  check(lastAiRequest.max_tokens === 512 && lastAiRequest.temperature === 0.3, 'Hint UI uses its bounded one-step prompt budget')
  const hintDb = await readSaved(hint)
  const hintId = hintDb.state.lastConversationId
  check(hintDb.conversations.find(c => c.id === hintId).turns.at(-1).status === 'complete', 'completion status committed to IndexedDB')
  await hint.reload()
  await waitSaved(hint, 'Complete')
  check(await hint.locator('.msg.user').count() === 1, 'reload restores the saved conversation without duplicate turns')
  await hint.screenshot({ path: join(evidence, 'dialog.png') })
  await resetCooldown(hint)
  await hint.fill('#ask-input', 'What is the next step?')
  await hint.click('#ask-btn')
  await hint.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 2)
  await waitSaved(hint, 'Complete')
  check(lastAiRequest.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length === 1, 'attachment sent once across multiple turns')
  await resetCooldown(hint)
  await hint.click('[data-retry]')
  await hint.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 3)
  await waitSaved(hint, 'Complete')
  check(await hint.locator('.msg.user').count() === 2 && lastAiRequest.max_tokens === 2048, 'explicit Regenerate preserves the source user turn and its original turn budget')

  const checked = await openCapture()
  await checked.setViewportSize({ width: 480, height: 660 })
  await checked.click('#check-btn')
  check(await checked.locator('#ask-form').isHidden(), 'Check shows its multiline form without a second Ask composer')
  await checked.click('#check-submit')
  check(await checked.locator('#check-form').isVisible(), 'Check refuses an empty attempt and leaves the input visible')
  const attempt = '2(x+3)=10\n2x+3=10\nx=3.5'
  await checked.fill('#check-input', attempt)
  await checked.screenshot({ path: join(evidence, 'check.png') })
  await checked.click('#check-submit')
  await waitSaved(checked, 'Complete')
  const checkedDb = await readSaved(checked)
  const checkedId = checkedDb.state.lastConversationId
  check(checkedDb.conversations.find(c => c.id === checkedId).turns[0].input === attempt, 'raw multiline student attempt saved independently of its template')
  check(lastAiRequest.max_tokens === 1024 && lastAiRequest.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.text?.includes(attempt))), 'Check serializes the actual attempt and its budget')
  const beforeCooldown = requestCount
  await checked.fill('#ask-input', 'Too soon')
  await checked.click('#ask-btn')
  await checked.waitForTimeout(100)
  check(requestCount === beforeCooldown, 'accepted start imposes the ten-second interval without a queued request')
  check(await checked.inputValue('#ask-input') === 'Too soon', 'a rejected start retains the typed question instead of silently clearing it')
  await checked.click('#history-btn')
  await checked.locator('.history-row').filter({ hasText: '2(x+3)=10' }).waitFor()
  await checked.waitForFunction(() => document.getElementById('storage-usage')?.textContent?.includes('MiB'))
  await checked.screenshot({ path: join(evidence, 'history.png') })
  const row = checked.locator('.history-row').filter({ hasText: '2(x+3)=10' })
  const download = checked.waitForEvent('download')
  await row.getByRole('button', { name: 'Export JSON' }).click()
  const json = JSON.parse(readFileSync(await (await download).path(), 'utf8'))
  check(json.schema === 1 && json.conversation.id === checkedId && Object.values(json.attachments)[0]?.startsWith('data:image/png') && !JSON.stringify(json).includes('sk-test-123'), 'JSON export includes transcript/images and excludes settings/key')
  checked.once('dialog', d => d.dismiss())
  await row.getByRole('button', { name: 'Delete', exact: true }).click()
  check((await readSaved(checked)).conversations.some(c => c.id === checkedId), 'cancelled delete preserves the conversation')
  checked.once('dialog', d => d.accept())
  await row.getByRole('button', { name: 'Delete', exact: true }).click()
  await checked.waitForFunction(() => !document.querySelector('#history-list')?.textContent?.includes('2(x+3)=10'))
  check(!(await readSaved(checked)).conversations.some(c => c.id === checkedId), 'confirmed deletion removes the selected conversation')

  for (const [mode, label, status] of [['truncated', 'Length limit', 'truncated'], ['interrupted', 'Interrupted', 'interrupted'], ['provider-error', 'Provider error', 'provider_error']]) {
    responseMode = mode
    const p = await openCapture()
    await p.click('[data-preset="hint"]')
    await waitSaved(p, label)
    const saved = await readSaved(p)
    check(saved.conversations.find(c => c.id === saved.state.lastConversationId).turns.at(-1).status === status, `${status} preserves partial text and its actual saved status`)
    await p.close()
  }
  responseMode = 'normal'
  const quota = await openCapture()
  responseMode = 'slow'
  await quota.click('[data-preset="hint"]')
  await quota.waitForFunction(() => document.querySelector('.msg.assistant .msg-body')?.textContent?.includes('Hello'))
  await sw.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    const handler = event => event.preventDefault()
    self.addEventListener('error', handler, { once: true })
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'conversations') {
        IDBObjectStore.prototype.put = original
        throw new DOMException('expected synthetic quota failure', 'QuotaExceededError')
      }
      return original.apply(this, args)
    }
  })
  await waitSaved(quota, 'Not saved')
  check(await quota.locator('#operation-error').isVisible(), 'mid-stream quota failure stops the request and keeps a visible unsaved-text warning')
  await quota.click('#history-btn')
  const quotaDb = await readSaved(quota)
  const quotaId = quotaDb.state.lastConversationId
  const quotaRow = quota.locator('.history-row').filter({ has: quota.locator('.history-open').filter({ hasText: 'Hint' }) }).first()
  const quotaDownload = quota.waitForEvent('download')
  await quotaRow.getByRole('button', { name: 'Export JSON' }).click()
  const quotaJson = JSON.parse(readFileSync(await (await quotaDownload).path(), 'utf8'))
  check(quotaJson.conversation.id === quotaId && quotaJson.conversation.turns.at(-1).text.startsWith('Hello'), 'export rescues the latest visible partial after a failed write')
  await quota.close()
  responseMode = 'normal'
  await hint.close()
  await checked.close()

  await page.bringToFront()
  const hostCdp = await ctx.newCDPSession(page)
  const hostCdps = new Map([[page, hostCdp]])
  const findHostButtonOn = async (targetPage, text) => {
    let targetCdp = hostCdps.get(targetPage)
    if (!targetCdp) {
      targetCdp = await ctx.newCDPSession(targetPage)
      hostCdps.set(targetPage, targetCdp)
    }
    const { root: documentNode } = await targetCdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const attribute = (node, name) => {
      const index = node.attributes?.indexOf(name) ?? -1
      return index < 0 ? undefined : node.attributes[index + 1]
    }
    const find = (node) => {
      if (node.nodeName === 'BUTTON' && (
        node.children?.some(child => child.nodeValue === text) ||
        attribute(node, 'aria-label')?.startsWith(text) ||
        attribute(node, 'title')?.startsWith(text)
      )) return node
      for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
        const found = find(child)
        if (found) return found
      }
    }
    const node = find(documentNode)
    if (!node) throw new Error(`Missing rendered host button ${text}`)
    return { node, targetCdp }
  }
  const clickHostButtonOn = async (targetPage, text) => {
    const { node, targetCdp } = await findHostButtonOn(targetPage, text)
    const { model } = await targetCdp.send('DOM.getBoxModel', { nodeId: node.nodeId })
    await targetPage.mouse.click((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2)
  }
  const hostButtonBoxOn = async (targetPage, text) => {
    const { node, targetCdp } = await findHostButtonOn(targetPage, text)
    try { return (await targetCdp.send('DOM.getBoxModel', { nodeId: node.nodeId })).model.border }
    catch { return undefined }
  }
  const findHostButton = (text) => findHostButtonOn(page, text)
  const clickHostButton = (text) => clickHostButtonOn(page, text)
  let embedded = page.frames().find(f => f.url().startsWith(chatOrigin))
  await embedded.waitForSelector('#view-capture:not([hidden])')
  await resetCooldown(embedded)
  responseMode = 'slow'
  const nativeBefore = requestCount
  await embedded.click('[data-preset="hint"]')
  await embedded.waitForFunction(() => document.querySelector('.msg.assistant .msg-body')?.textContent?.includes('Hello'))
  const nativeState = await readSaved(embedded)
  const nativeId = nativeState.state.generation.conversationId
  const priorAttachmentId = nativeState.conversations.find((conversation) => conversation.id === nativeId).activeAttachmentId
  const duplicate = await ctx.newPage()
  await duplicate.goto(`${chatOrigin}/src/chat/chat.html?kind=conversation&conversation=${nativeId}`)
  await duplicate.waitForFunction(() => document.getElementById('ask-btn')?.disabled)
  check(await duplicate.locator('[data-preset="hint"]').isDisabled(), 'duplicate window observes the active writer and cannot start another answer')
  await page.bringToFront()
  await clickHostButton('−')
  await page.waitForSelector('[data-study-buddy="chat"][data-state="minimized"]', { state: 'attached' })
  const { node: launcher, targetCdp: launcherCdp } = await findHostButton('Restore Study Buddy')
  const launcherLabel = launcher.attributes[launcher.attributes.indexOf('aria-label') + 1]
  const launcherModel = await launcherCdp.send('DOM.getBoxModel', { nodeId: launcher.nodeId })
  const launcherWidth = Math.abs(launcherModel.model.border[2] - launcherModel.model.border[0])
  const launcherHeight = Math.abs(launcherModel.model.border[5] - launcherModel.model.border[1])
  check(launcherWidth === 40 && launcherHeight === 40 && launcherLabel.includes('Answering') &&
    launcher.children?.some(child => child.nodeName === 'IMG') &&
    !launcher.children?.some(child => child.nodeType === 3 && child.nodeValue?.trim()),
  'minimized launcher is a 40×40 icon-only button with an accessible live status')
  const partialLength = await embedded.locator('.msg.assistant .msg-body').textContent()
  await embedded.waitForFunction((length) => (document.querySelector('.msg.assistant .msg-body')?.textContent?.length ?? 0) > length, partialLength.length, { polling: 100 })
  check(true, 'minimize keeps the same iframe and its stream running')
  await page.screenshot({ path: join(evidence, 'minimized.png') })

  await triggerAction(page)
  await page.waitForSelector('[data-study-buddy="overlay"]')
  check(!await hostButtonBoxOn(page, 'Restore Study Buddy'), 'minimized launcher has no rendered box during selection')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'minimized')
  const restoredLauncherBox = await hostButtonBoxOn(page, 'Restore Study Buddy')
  check(Boolean(restoredLauncherBox && Math.abs(restoredLauncherBox[2] - restoredLauncherBox[0]) === 40 &&
    Math.abs(restoredLauncherBox[5] - restoredLauncherBox[1]) === 40), 'Escape restores the visible 40×40 launcher')
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-study-buddy="chat"][data-state="open"]', { state: 'attached' })
  check(!await hostButtonBoxOn(page, 'Restore Study Buddy'), 'restored open chat has no rendered launcher box')
  check(page.frames().includes(embedded) && requestCount === nativeBefore + 1, 'Escape restores minimized state and keyboard focus; Enter reuses the live iframe without a new provider call')
  await clickHostButton('−')
  await page.waitForSelector('[data-study-buddy="chat"][data-state="minimized"]', { state: 'attached' })
  await clickHostButton('Restore Study Buddy')
  await page.waitForSelector('[data-study-buddy="chat"][data-state="open"]', { state: 'attached' })
  check(page.frames().includes(embedded) && requestCount === nativeBefore + 1, 'icon click restores the same conversation without a duplicate provider call')
  const pageTabId = await sw.evaluate(async (targetUrl) => (await chrome.tabs.query({ url: targetUrl }))[0]?.id, url)
  await sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const original = chrome.runtime.sendMessage
      let failOnce = true
      chrome.runtime.sendMessage = function (message, ...args) {
        if (failOnce && message?.type === 'DIALOG_CLOSED') {
          failOnce = false
          return Promise.resolve({ ok: false })
        }
        return original.apply(chrome.runtime, [message, ...args])
      }
    } })
  }, pageTabId)
  await clickHostButton('✕')
  await embedded.waitForFunction(() => !document.getElementById('operation-error')?.hidden)
  check(await page.locator('[data-study-buddy="chat"]').count() === 1 &&
    (await readSaved(embedded)).conversations.find(c => c.id === nativeId).turns.at(-1).status === 'cancelled',
  'failed close unlink keeps the live frame and saved partial available for retry')
  await clickHostButton('✕')
  await page.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  const afterClose = await readSaved(duplicate)
  const savedClose = afterClose.conversations.find(c => c.id === nativeId).turns.at(-1)
  const closedBinding = pageTabId === undefined ? undefined : await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${pageTabId}`)
  check(savedClose.status === 'cancelled' && savedClose.text.startsWith('Hello') && !afterClose.state.generation &&
    await page.locator('[data-study-buddy]').count() === 0 && closedBinding === undefined,
  'Close commits the partial reply, removes panel and launcher, and releases this tab binding')

  await triggerAction(page)
  await page.waitForSelector('[data-study-buddy="overlay"]')
  await page.mouse.move(60, 160)
  await page.mouse.down()
  await page.mouse.move(180, 210, { steps: 5 })
  await page.mouse.up()
  await page.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  embedded = page.frames().find(f => f.url().startsWith(chatOrigin))
  await embedded.waitForFunction(() => document.getElementById('crop')?.naturalWidth > 0)
  const afterFreshCapture = await readSaved(embedded)
  const nextConversationId = pageTabId === undefined ? undefined : await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${pageTabId}`)
  const oldConversation = afterFreshCapture.conversations.find(c => c.id === nativeId)
  const nextConversation = afterFreshCapture.conversations.find(c => c.id === nextConversationId)
  const oldImageStillSaved = await embedded.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('study-buddy-conversations')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return await new Promise((resolve, reject) => {
      const request = db.transaction('attachments', 'readonly').objectStore('attachments').get(id)
      request.onsuccess = () => resolve(Boolean(request.result))
      request.onerror = () => reject(request.error)
    })
  }, priorAttachmentId)
  check(Boolean(nextConversationId && nextConversationId !== nativeId && oldConversation && nextConversation && oldImageStillSaved),
    'capture after Close creates a fresh dialog while preserving the old transcript and image')
  await embedded.click('#history-btn')
  const historyOpen = embedded.locator('.history-row .history-open')
  const oldRowText = `${oldConversation.title} · ${oldConversation.turns.length} ·`
  const oldHistoryRow = historyOpen.filter({ hasText: oldRowText }).first()
  await oldHistoryRow.waitFor()
  await oldHistoryRow.click()
  await embedded.waitForSelector('#view-capture:not([hidden])')
  const tabBinding = async () => pageTabId === undefined ? undefined :
    sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${pageTabId}`)
  const selectedClosedId = await tabBinding()
  check(selectedClosedId === nativeId, `History opens the closed saved conversation (${oldConversation.id})`)
  await embedded.click('#history-btn')
  const nextRowText = `${nextConversation.title} · ${nextConversation.turns.length} ·`
  const nextHistoryRow = embedded.locator('.history-row .history-open').filter({ hasText: nextRowText }).first()
  await nextHistoryRow.waitFor()
  await nextHistoryRow.click()
  await embedded.waitForSelector('#view-capture:not([hidden])')
  check(await tabBinding() === nextConversationId, 'History also reopens the newly selected conversation by its tab binding')
  const nextAttachmentId = nextConversation?.activeAttachmentId
  const freshPeer = await ctx.newPage()
  await freshPeer.goto(`${chatOrigin}/src/chat/chat.html?kind=conversation&conversation=${nextConversationId}`)
  await freshPeer.waitForSelector('#view-capture:not([hidden])')
  await resetCooldown(embedded)
  const existingAnswers = await embedded.locator('.msg.assistant').count()
  await embedded.click('[data-preset="hint"]')
  await embedded.waitForFunction((count) => document.querySelectorAll('.msg.assistant').length > count && [...document.querySelectorAll('.msg.assistant .msg-body')].at(-1)?.textContent?.includes('step'), existingAnswers)
  await embedded.waitForTimeout(400) // wait for the real bounded partial-save cadence
  await page.reload()
  await freshPeer.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent?.includes('Interrupted'))
  const navigation = await readSaved(freshPeer)
  check(navigation.conversations.find(c => c.id === nextConversationId).turns.at(-1).status === 'interrupted' && !navigation.state.generation, 'navigation releases the writer and retains the last committed partial as interrupted')
  responseMode = 'normal'
  await duplicate.waitForFunction(() => !document.getElementById('new-chat-btn')?.disabled)
  await duplicate.fill('#ask-input', 'Previous task question')
  await duplicate.click('#check-btn')
  await duplicate.fill('#check-input', 'Previous task attempt\nsecond line')
  await duplicate.click('#new-chat-btn')
  await duplicate.waitForFunction(() => document.querySelectorAll('.msg').length === 0 && document.getElementById('crop-figure')?.hidden)
  check((await readSaved(duplicate)).state.lastConversationId !== nativeId, 'New chat creates a distinct empty conversation without a hidden prior image')
  check(await duplicate.locator('#ask-input').inputValue() === '' && await duplicate.locator('#check-input').inputValue() === '' && await duplicate.locator('#check-form').isHidden(), 'New chat also clears drafts and the previous task attempt form')
  await duplicate.setViewportSize({ width: 340, height: 620 })
  await duplicate.click('#check-btn')
  await duplicate.screenshot({ path: join(evidence, 'narrow.png') })
  check(await duplicate.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow panel has no horizontal overflow')
  // Exercise the worker's atomic admission, not just disabled UI controls.
  await resetCooldown(duplicate)
  const raceId = (await readSaved(duplicate)).state.lastConversationId
  const racePeer = await ctx.newPage()
  await racePeer.goto(`${chatOrigin}/src/chat/chat.html?kind=conversation&conversation=${raceId}`)
  const admission = (p) => p.evaluate((id) => new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'study-buddy-generation' })
    const user = { id: crypto.randomUUID(), role: 'user', text: 'Race fixture', kind: 'ask', createdAt: Date.now(), locale: 'en', promptVersion: 'fixture' }
    const assistant = { ...user, id: crypto.randomUUID(), role: 'assistant', text: '', status: 'streaming', replyTo: user.id }
    port.onMessage.addListener((response) => {
      if (response.seq === 1) {
        if (response.ok) port.postMessage({ seq: 2, action: 'update', text: '', status: 'cancelled' })
        else { port.disconnect(); resolve(response) }
      } else { port.disconnect(); resolve({ ok: true }) }
    })
    port.postMessage({ seq: 1, action: 'start', conversationId: id, user, assistant })
  }), raceId)
  const races = await Promise.all([admission(duplicate), admission(racePeer)])
  check(races.filter(r => r.ok).length === 1 && races.some(r => !r.ok && /dialog.busy|dialog.cooldown/.test(r.error)), 'two concurrent native window starts admit exactly one writer')
  await sw.evaluate(() => {
    globalThis.fixtureOriginalNow = Date.now
    globalThis.fixtureNow = 1_000_000
    Date.now = () => globalThis.fixtureNow
  })
  try {
    await resetCooldown(duplicate)
    const atZero = await admission(duplicate)
    await sw.evaluate(() => { globalThis.fixtureNow += 9999 })
    const early = await admission(racePeer)
    await sw.evaluate(() => { globalThis.fixtureNow += 1 })
    const boundary = await admission(racePeer)
    check(atZero.ok && !early.ok && early.error === 'dialog.cooldown:1' && boundary.ok, 'native coordinator rejects t=9.999s and admits t=10s across windows')
  } finally { await sw.evaluate(() => { Date.now = globalThis.fixtureOriginalNow; delete globalThis.fixtureNow; delete globalThis.fixtureOriginalNow }) }
  check(JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')).incognito === 'not_allowed', 'incognito is explicitly disabled')
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  check(!manifest.host_permissions && !manifest.permissions.includes('<all_urls>'), 'native-action capture needs no persistent site grant')
  await racePeer.close()

  await page.bringToFront()
  await duplicate.evaluate(() => chrome.runtime.sendMessage({ type: 'START_SELECTION' }))
  await page.waitForSelector('[data-study-buddy="overlay"]')
  await page.mouse.move(60, 160)
  await page.mouse.down()
  await page.mouse.move(180, 210, { steps: 5 })
  await page.mouse.up()
  await page.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  const recaptured = page.frames().find(f => f.url().startsWith(chatOrigin))
  await recaptured.waitForFunction(() => document.getElementById('crop')?.naturalWidth > 0)
  const recaptureDb = await readSaved(recaptured)
  const recaptureDialog = recaptureDb.conversations.find(c => c.id === nextConversationId)
  const pageBinding = pageTabId === undefined ? undefined : await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${pageTabId}`)
  check(pageBinding === nextConversationId && recaptureDialog.activeAttachmentId !== nextAttachmentId && recaptureDialog.turns[0].attachmentId === nextAttachmentId, 'new capture continues the tab-selected dialog while keeping old turn attachment links')
  await resetCooldown(recaptured)
  const oldCount = await recaptured.locator('.msg.assistant').count()
  await recaptured.fill('#ask-input', 'Use the newly selected task')
  await recaptured.click('#ask-btn')
  await recaptured.waitForFunction(count => document.querySelectorAll('.msg.assistant').length > count, oldCount)
  await waitSaved(recaptured, 'Complete')
  check(lastAiRequest.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length === 2, 'multi-capture request retains at most two unique source images')

  const quickPage = await ctx.newPage()
  const quickUrl = `${origin}/quick`
  await quickPage.goto(quickUrl)
  await triggerAction(quickPage)
  await quickPage.waitForSelector('[data-study-buddy="overlay"]')
  await quickPage.mouse.move(60, 160)
  await quickPage.mouse.down()
  await quickPage.mouse.move(180, 210, { steps: 5 })
  await quickPage.mouse.up()
  await quickPage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  const quickFrame = quickPage.frames().find(f => f.url().startsWith(chatOrigin))
  await quickFrame.waitForSelector('#view-capture:not([hidden])')
  await resetCooldown(quickFrame)
  await quickFrame.evaluate(() => {
    const original = chrome.storage.local.get.bind(chrome.storage.local)
    chrome.storage.local.get = (...args) => new Promise((resolve, reject) => {
      setTimeout(() => original(...args).then(resolve, reject), 1000)
    })
  })
  await quickFrame.fill('#ask-input', 'This start must be cancelled by Close')
  const beforeRapidClose = requestCount
  await quickFrame.click('#ask-btn')
  await clickHostButtonOn(quickPage, '✕')
  await quickPage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  await quickPage.waitForTimeout(1100)
  const rapidCloseState = await readSaved(freshPeer)
  const quickTabId = await sw.evaluate(async (targetUrl) => (await chrome.tabs.query({ url: targetUrl }))[0]?.id, quickUrl)
  const quickBinding = quickTabId === undefined ? undefined : await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${quickTabId}`)
  check(requestCount === beforeRapidClose && !rapidCloseState.state.generation &&
    !rapidCloseState.conversations.some(c => c.turns.some(turn => turn.text === 'This start must be cancelled by Close')) && quickBinding === undefined,
  'Close during settings load prevents a queued Solve from starting and releases only that tab')
  await quickPage.close()

  // Two tabs can deliberately view the same conversation. Closing the older
  // host must release only its binding and leave the other tab's writer alive.
  const otherPage = await ctx.newPage()
  const otherUrl = `${origin}/other`
  await otherPage.goto(otherUrl)
  await triggerAction(otherPage)
  await otherPage.waitForSelector('[data-study-buddy="overlay"]')
  await otherPage.keyboard.press('Escape')
  await otherPage.waitForSelector('[data-study-buddy="overlay"]', { state: 'detached' })
  const otherTabId = await sw.evaluate(async ({ targetUrl, conversationId }) => {
    const tab = (await chrome.tabs.query({ url: targetUrl }))[0]
    await new Promise((resolve) => chrome.tabs.sendMessage(tab.id, {
      type: 'SHOW_CHAT', state: { kind: 'conversation', conversationId },
    }, () => resolve()))
    return tab.id
  }, { targetUrl: otherUrl, conversationId: nextConversationId })
  await otherPage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  const otherFrame = otherPage.frames().find(f => f.url().startsWith(chatOrigin))
  await otherFrame.waitForSelector('#view-capture:not([hidden])')
  const otherBinding = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${otherTabId}`)
  check(otherBinding === nextConversationId, 'second tab can select the same saved conversation independently')
  responseMode = 'slow'
  await resetCooldown(otherFrame)
  await otherFrame.click('[data-preset="hint"]')
  let otherState
  for (let attempt = 0; attempt < 40; attempt++) {
    otherState = await readSaved(otherFrame)
    if (otherState.state.generation?.conversationId === nextConversationId) break
    await otherPage.waitForTimeout(50)
  }
  const activeOtherTurn = otherState?.state.generation?.turnId
  if (!activeOtherTurn) throw new Error(`Second-tab stream did not start: ${JSON.stringify(otherState?.state)}`)
  const activeOtherSelector = `[data-turn="${activeOtherTurn}"] .msg-body`
  await otherFrame.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes('Hello'), activeOtherSelector)
  const otherPartial = await otherFrame.locator(activeOtherSelector).textContent()
  await page.bringToFront()
  await clickHostButton('✕')
  await page.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  const bindingsAfterFirstClose = await sw.evaluate(async (keys) => chrome.storage.session.get(keys), [
    `dialog.tab.${pageTabId}`, `dialog.tab.${otherTabId}`,
  ])
  await otherPage.waitForTimeout(400)
  const continuedPartial = await otherFrame.locator(activeOtherSelector).textContent()
  const afterFirstClose = await readSaved(otherFrame)
  check(bindingsAfterFirstClose[`dialog.tab.${pageTabId}`] === undefined &&
    bindingsAfterFirstClose[`dialog.tab.${otherTabId}`] === nextConversationId &&
    afterFirstClose.state.generation?.conversationId === nextConversationId && continuedPartial.length > otherPartial.length,
  `closing one tab releases its association without cancelling the other tab's writer (main=${pageTabId}, owner=${otherTabId}, partial=${otherPartial.length}->${continuedPartial.length})`)
  await clickHostButtonOn(otherPage, '✕')
  await otherPage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  await freshPeer.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent?.includes('Stopped'))
  const stoppedOther = await readSaved(freshPeer)
  const otherBindingAfterClose = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${otherTabId}`)
  check(stoppedOther.conversations.find(c => c.id === nextConversationId).turns.at(-1).status === 'cancelled' &&
    !stoppedOther.state.generation && otherBindingAfterClose === undefined,
  'the owning tab can still cancel and close its live partial reply')
  responseMode = 'normal'
  await otherPage.close()
  await duplicate.close()

  // Actual browser restart with the same isolated profile, not just page reload.
  await ctx.close()
  const restarted = await chromium.launchPersistentContext(profile, { channel: 'chromium', args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`] })
  await restarted.route('https://**/*', route => route.abort())
  restarted.on('page', p => p.on('pageerror', err => pageErrors.push(String(err))))
  try {
    const resumed = await restarted.newPage()
    await resumed.goto(`${chatOrigin}/src/chat/chat.html?kind=conversation&conversation=${nextConversationId}`)
    await waitSaved(resumed, 'Stopped')
    await resumed.waitForFunction(() => document.getElementById('crop')?.naturalWidth > 0)
    const volatile = await resumed.evaluate(() => chrome.storage.session.get())
    check(!Object.keys(volatile).some(k => k.startsWith('capture.')), 'browser restart clears session crops without losing saved Blob attachments')
    check((await readSaved(resumed)).conversations.find(c => c.id === nextConversationId).turns.at(-1).status === 'cancelled', 'full browser restart preserves the cancelled transcript/status and settings')
    const retainedSettings = (await resumed.evaluate(() => chrome.storage.local.get('settings'))).settings
    check(retainedSettings?.uiLanguage === 'en' && retainedSettings?.answerLanguage === 'auto', 'interface and answer language survive a full browser restart')
    const privilegedEvent = restarted.waitForEvent('page')
    await resumed.evaluate(() => chrome.tabs.create({ url: 'chrome://version' }))
    const privileged = await privilegedEvent
    await privileged.waitForURL(/chrome:\/\/version/)
    await privileged.bringToFront()
    const restartedBrowserCdp = await restarted.browser().newBrowserCDPSession()
    const { targetInfos } = await restartedBrowserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] })
    const restrictedTarget = targetInfos.find(item => item.type === 'tab' && item.url === privileged.url())
    if (!restrictedTarget) throw new Error(`Could not find restricted browser tab ${privileged.url()}`)
    const popupEvent = restarted.waitForEvent('page')
    await restartedBrowserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: restrictedTarget.targetId })
    const popup = await popupEvent
    await popup.waitForURL(url => url.href.startsWith(`${chatOrigin}/src/chat/chat.html?kind=restricted&`))
    await popup.waitForSelector('#view-restricted:not([hidden])')
    check(true, 'native action on a restricted page uses the limited restricted-state rescue popup')
  } finally { await restarted.close() }

  writeFileSync(join(evidence, 'runtime.json'), JSON.stringify({ requestCount, pageErrors, fixture: 'localhost mock only', physicalShortcut: 'not dispatched by headless Chromium' }, null, 2))

  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`)
} finally {
  await ctx.close()
  server.close()
  rmSync(profile, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
