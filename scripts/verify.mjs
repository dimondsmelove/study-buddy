// Phase-0 smoke test: loads the built extension in Chromium and drives the full
// capture flow:
//   START_SELECTION → overlay injection → drag a region → captureVisibleTab →
//   crop → chrome.storage.session → chat window host embedded in the page →
//   the chat page renders the capture image message.
//
// The toolbar path is invoked through Chromium's native extension action so
// activeTab is granted by the same browser gesture as a real click. The
// shortcut registration is verified here; dispatching the physical key still
// requires a headed browser.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import vm from 'node:vm'
import ts from 'typescript'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const root = resolve(fileURLToPath(import.meta.url), '..')
const dist = resolve(root, '..', 'dist')
const i18nModule = { exports: {} }
const i18nSource = ts.transpileModule(readFileSync(resolve(root, '..', 'src/shared/i18n.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
vm.runInNewContext(`(function(module, exports) {${i18nSource}\n})(module, module.exports)`, { module: i18nModule })
const answerActionLabels = ['en', 'ru'].map(lang => i18nModule.exports.t(lang, 'msg.actions'))

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
      if (responseMode === 'long') {
        const answer = 'A longer worked explanation with enough detail to read at normal size. Each step follows from the captured question and keeps the reasoning visible instead of compressing the result.\n\nFor the quadratic formula,\n\n$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$\n\nThis display equation is rendered with KaTeX. The surrounding prose remains selectable and wraps within the answer column.'
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: answer } }] }) + '\n\ndata: [DONE]\n\n')
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
  const chatFrameOn = async (targetPage) => {
    const find = () => targetPage.frames().find((frame) => frame.url().startsWith(chatOrigin))
    const current = find()
    if (current) return current
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout)
        targetPage.off('frameattached', inspect)
        targetPage.off('framenavigated', inspect)
      }
      const inspect = (frame) => {
        if (!frame.url().startsWith(chatOrigin)) return
        cleanup()
        resolve(frame)
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('The embedded Study Buddy frame did not navigate to its extension page.'))
      }, 5000)
      targetPage.on('frameattached', inspect)
      targetPage.on('framenavigated', inspect)
      const attached = find()
      if (attached) inspect(attached)
    })
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
  const liveFrame = await chatFrameOn(page)
  await liveFrame.waitForFunction(() => document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)?.naturalWidth > 0)

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
  await chat.waitForFunction(() => document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)?.naturalWidth > 0)
  const imgLoaded = await chat.evaluate(async () => {
    const img = document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)
    await img.decode().catch(() => {})
    return img.naturalWidth > 0
  })
  check(imgLoaded, 'chat page renders the captured crop')
  await chat.close()
  const beforeCleanSelection = await liveFrame.locator('.turn-image').last().getAttribute('src')
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
  const cleanCapture = cleanCrop ? await sw.evaluate(async (id) => {
    const capture = (await chrome.storage.session.get(`capture.${id}`))[`capture.${id}`]
    if (!capture?.dataUrl) return undefined
    const bitmap = await createImageBitmap(await (await fetch(capture.dataUrl)).blob())
    return { dataUrl: capture.dataUrl, width: bitmap.width, height: bitmap.height }
  }, cleanCrop) : undefined
  const cleanSizeMatchesSelection = Boolean(cleanCapture
    && Math.abs(cleanCapture.width - 100) <= 2
    && Math.abs(cleanCapture.height - 60) <= 2)
  check(cleanSizeMatchesSelection,
    `new crop matches its 100×60 selection (${cleanCapture?.width}×${cleanCapture?.height})`)
  const exactCleanImage = cleanSizeMatchesSelection
    && await liveFrame.waitForFunction(({ previous, width, height }) => {
      const img = document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)
      return img?.src !== previous && img.complete && img.naturalWidth === width && img.naturalHeight === height
    }, { previous: beforeCleanSelection, width: cleanCapture.width, height: cleanCapture.height }, { timeout: 5000 }).then(() => true, () => false)
  const cleanPixel = exactCleanImage ? await liveFrame.evaluate(async ({ dataUrl }) => {
    const img = document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)
    await img.decode()
    const expected = new Image()
    expected.src = dataUrl
    await expected.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')
    const expectedCanvas = document.createElement('canvas')
    expectedCanvas.width = expected.naturalWidth
    expectedCanvas.height = expected.naturalHeight
    const expectedContext = expectedCanvas.getContext('2d')
    context.drawImage(img, 0, 0)
    expectedContext.drawImage(expected, 0, 0)
    const x = Math.floor(canvas.width / 2)
    const y = Math.floor(canvas.height / 2)
    const pixel = [...context.getImageData(x, y, 1, 1).data]
    const actualPixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const expectedPixels = expectedContext.getImageData(0, 0, expectedCanvas.width, expectedCanvas.height).data
    const matchesCapture = canvas.width === expectedCanvas.width
      && canvas.height === expectedCanvas.height
      && actualPixels.length === expectedPixels.length
      && actualPixels.every((value, index) => value === expectedPixels[index])
    return { width: canvas.width, height: canvas.height, x, y, pixel, matchesCapture }
  }, cleanCapture) : undefined
  check(Boolean(exactCleanImage && cleanPixel?.matchesCapture),
    'chat renders the exact newly selected image message at its stored dimensions')
  const sampleInBounds = Boolean(cleanPixel
    && cleanPixel.x >= 0 && cleanPixel.y >= 0
    && cleanPixel.x < cleanPixel.width && cleanPixel.y < cleanPixel.height)
  const sampleIsVisibleGreen = Boolean(sampleInBounds
    && cleanPixel.pixel[3] > 0
    && cleanPixel.pixel[1] > 100
    && cleanPixel.pixel[1] > cleanPixel.pixel[0] * 2)
  check(sampleIsVisibleGreen,
    `capture excludes the overlapping chat panel (${cleanPixel?.width}×${cleanPixel?.height}, sample ${cleanPixel?.x},${cleanPixel?.y} rgba ${cleanPixel?.pixel.join(',')})`)

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

  const priorToastSrc = await liveFrame.locator('.turn-image').last().getAttribute('src')
  const beforeToastCaptureId = await sw.evaluate(async () => Object.entries(await chrome.storage.session.get())
    .filter(([key]) => key.startsWith('capture.')).sort(([, a], [, b]) => a.ts - b.ts).at(-1)?.[0].slice('capture.'.length))
  await triggerAction(page)
  await page.waitForSelector('[data-study-buddy="overlay"]')
  const viewport = page.viewportSize()
  const toastLeft = Math.max(0, noticeScreenPoint.x - 4)
  const toastWidth = Math.min(250, viewport.width - toastLeft - 1)
  await page.mouse.move(toastLeft, 20)
  await page.mouse.down()
  await page.mouse.move(toastLeft + toastWidth, 140, { steps: 5 })
  await page.mouse.up()
  const toastCaptureId = await sw.evaluate(async (previousId) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const captures = Object.entries(await chrome.storage.session.get())
        .filter(([key]) => key.startsWith('capture.')).sort(([, a], [, b]) => a.ts - b.ts)
      const id = captures.at(-1)?.[0].slice('capture.'.length)
      if (id && id !== previousId) return id
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return undefined
  }, beforeToastCaptureId)
  const toastCapture = toastCaptureId ? await sw.evaluate(async (id) => {
    const capture = (await chrome.storage.session.get(`capture.${id}`))[`capture.${id}`]
    if (!capture?.dataUrl) return undefined
    const bitmap = await createImageBitmap(await (await fetch(capture.dataUrl)).blob())
    return { dataUrl: capture.dataUrl, width: bitmap.width, height: bitmap.height }
  }, toastCaptureId) : undefined
  check(Boolean(toastCaptureId && toastCapture), 'retry selection stores a new crop after hiding the error notice')
  check(Boolean(toastCapture && Math.abs(toastCapture.width - toastWidth) <= 2 && Math.abs(toastCapture.height - 120) <= 2),
    'retry crop dimensions match the selection containing the prior notice border')
  await liveFrame.waitForFunction(({ previous, width, height }) => {
    const img = document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)
    return img?.src !== previous && img.complete && img.naturalWidth === width && img.naturalHeight === height
  }, { previous: priorToastSrc, width: toastCapture.width, height: toastCapture.height })
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
  const cropPoint = {
    x: Math.round((noticeScreenPoint.x - toastLeft) * devicePixelRatio),
    y: Math.round((noticeScreenPoint.y - 20) * devicePixelRatio),
  }
  const toastCropPixel = toastCapture ? await liveFrame.evaluate(async ({ x, y, dataUrl, width, height }) => {
    const img = document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)
    await img.decode()
    const expected = new Image()
    expected.src = dataUrl
    await expected.decode()
    const inBounds = x >= 0 && y >= 0 && x < img.naturalWidth && y < img.naturalHeight
      && img.naturalWidth === width && img.naturalHeight === height
      && expected.naturalWidth === width && expected.naturalHeight === height
    if (!inBounds) return { inBounds, alpha: 0, pixel: [], expectedPixel: [], matchesCapture: false }
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(img, 0, 0)
    const expectedContext = document.createElement('canvas').getContext('2d')
    expectedContext.canvas.width = expected.naturalWidth
    expectedContext.canvas.height = expected.naturalHeight
    expectedContext.drawImage(expected, 0, 0)
    const pixel = [...context.getImageData(x, y, 1, 1).data]
    const expectedPixel = [...expectedContext.getImageData(x, y, 1, 1).data]
    const actual = context.getImageData(0, 0, width, height).data
    const stored = expectedContext.getImageData(0, 0, width, height).data
    return {
      inBounds,
      alpha: pixel[3],
      pixel,
      expectedPixel,
      matchesCapture: actual.length === stored.length && actual.every((value, index) => value === stored[index]),
    }
  }, { ...cropPoint, dataUrl: toastCapture.dataUrl, width: toastCapture.width, height: toastCapture.height }) : undefined
  check(Boolean(toastCropPixel?.inBounds && toastCropPixel.alpha > 0 && toastCropPixel.matchesCapture
    && toastCropPixel.pixel.every((value, index) => value === toastCropPixel.expectedPixel[index])
    && !noticeIsRed(toastCropPixel.pixel) && (await alertState())?.hidden),
    `retry crop excludes the prior error notice border (${toastCropPixel?.pixel.join(',')}; expected ${toastCropPixel?.expectedPixel.join(',')}; inBounds=${toastCropPixel?.inBounds})`)
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

  // Language-only Settings keep the existing development connection intact.
  const settingsFixture = { provider: 'custom', baseUrl: `${origin}/v1`, apiKey: 'sk-test-123', uiLanguage: 'en', answerLanguage: 'auto' }
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), settingsFixture)
  const settings = await ctx.newPage()
  await settings.goto(`${chatOrigin}/src/chat/chat.html?kind=error&message=Settings%20fixture`)
  await settings.waitForSelector('#view-error:not([hidden])')
  await settings.click('#view-error:not([hidden]) [data-goto-settings]')
  await settings.waitForSelector('#view-settings:not([hidden])')
  const noConnectionDetails = await settings.evaluate(() => {
    const settingsMarkup = document.getElementById('view-settings').outerHTML.toLowerCase()
    const pageMarkup = document.documentElement.outerHTML
    return !/(api.?key|provider|base.?url|openrouter|deepseek|model|advanced)/.test(settingsMarkup) &&
      !pageMarkup.includes('sk-test-123') &&
      !document.querySelector('#set-api-key,#set-provider,#set-base-url,[data-key-toggle],.advanced')
  })
  check(noConnectionDetails, 'Settings exposes only language controls; no connection fields or stored secret appear anywhere in the DOM')

  const beforeSettingsWrites = await sw.evaluate(async () => chrome.storage.local.get('settings'))
  await settings.evaluate(() => {
    globalThis.fixtureStorageGet = chrome.storage.local.get
    globalThis.fixtureStorageSet = chrome.storage.local.set
    chrome.storage.local.get = async () => { throw new Error('expected fixture read failure') }
    globalThis.fixtureWriteCount = 0
    globalThis.fixtureFailedWriteCount = 0
    chrome.storage.local.set = async (...args) => { globalThis.fixtureWriteCount++; return globalThis.fixtureStorageSet(...args) }
  })
  await settings.selectOption('#set-ui-lang', 'ru')
  await settings.click('#set-save')
  check(
    await settings.locator('#set-msg').textContent() === 'Could not read settings. Nothing was saved; please retry.' &&
      await settings.locator('#view-settings').isVisible() &&
      JSON.stringify(await sw.evaluate(async () => chrome.storage.local.get('settings'))) === JSON.stringify(beforeSettingsWrites) &&
      await settings.evaluate(() => globalThis.fixtureWriteCount) === 0,
    'Settings read failure is visible and performs no write',
  )
  await settings.evaluate(() => { chrome.storage.local.get = globalThis.fixtureStorageGet })

  await settings.evaluate(() => { chrome.storage.local.set = async () => { globalThis.fixtureFailedWriteCount++; throw new Error('expected fixture write failure') } })
  await settings.selectOption('#set-ans-lang', 'fr')
  await settings.click('#set-save')
  check(
    await settings.locator('#set-msg').textContent() === 'Could not save settings. Existing data was kept; please retry.' &&
      await settings.locator('#view-settings').isVisible() &&
      JSON.stringify(await sw.evaluate(async () => chrome.storage.local.get('settings'))) === JSON.stringify(beforeSettingsWrites) &&
      await settings.evaluate(() => globalThis.fixtureFailedWriteCount) === 1,
    'Settings write failure stays visible and preserves the previous connection',
  )
  await settings.evaluate(() => { chrome.storage.local.set = globalThis.fixtureStorageSet })
  const requestsBeforeLanguageSave = requestCount
  await settings.click('#set-save')
  await settings.waitForSelector('#view-settings[hidden]', { state: 'attached' })
  const savedSettings = (await sw.evaluate(async () => chrome.storage.local.get('settings'))).settings
  check(
    savedSettings.provider === settingsFixture.provider &&
      savedSettings.baseUrl === settingsFixture.baseUrl &&
      savedSettings.apiKey === settingsFixture.apiKey &&
      savedSettings.uiLanguage === 'ru' &&
      savedSettings.answerLanguage === 'fr' &&
      requestCount === requestsBeforeLanguageSave,
    'language Save retains the stored runtime connection and sends no model request (credentials redacted)',
  )
  await settings.close()

  // AI answering: point settings at the mock endpoint and send the captured
  // crop through the Solve preset. The reply must stream into the thread, and
  // the request must carry the crop as an image_url. The model is fixed by the
  // app's chain (settings.model no longer exists).
  const PRIMARY = 'deepseek/deepseek-v4-flash-vision-exp'
  const FALLBACK = 'google/gemini-3.1-flash-lite'
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
      const i = document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)
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
  // With no development connection, an attempted task explains the state and
  // does not open credential setup or send a request.
  await sw.evaluate(() => chrome.storage.local.set({ settings: { provider: 'custom', baseUrl: 'http://127.0.0.1/unconfigured', apiKey: '', uiLanguage: 'en', answerLanguage: 'auto' } }))
  const disconnected = await openCapture()
  const beforeDisconnected = requestCount
  await disconnected.click('.preset[data-preset="solve"]')
  await disconnected.waitForFunction(() => !document.getElementById('operation-error')?.hidden)
  check(
    await disconnected.locator('#operation-error').textContent() === 'The answer service is not connected. Try again later.' &&
      await disconnected.locator('#view-settings').isHidden() &&
      requestCount === beforeDisconnected,
    'missing runtime connection is a clear service error with no key prompt or provider request',
  )
  await disconnected.close()
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), {
    provider: 'custom', baseUrl: `${origin}/v1`, apiKey: 'sk-test-123', uiLanguage: 'en', answerLanguage: 'auto',
  })

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
  const userMessages = lastAiRequest?.messages?.filter((m) => m.role === 'user') ?? []
  const firstUser = userMessages.find((m) => Array.isArray(m.content) && m.content.some(part => part?.type === 'text'))
  const imageMessage = userMessages.find((m) => Array.isArray(m.content) && m.content.some(part => part?.type === 'image_url'))
  const sentImage =
    Array.isArray(imageMessage?.content) &&
    imageMessage.content.some((p) => p?.type === 'image_url' && typeof p.image_url?.url === 'string' && p.image_url.url.startsWith('data:image/png'))
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
  const solveText = Array.isArray(firstUser?.content) ? firstUser.content.find(part => part?.type === 'text')?.text : null
  check(
    typeof solveText === 'string' && solveText.startsWith('Solve the problem shown in the image'),
    `solve prompt sent as expected (${String(solveText ?? '').slice(0, 40)}…)`,
  )
  check(
    lastAiRequest?.temperature === 0 && lastAiRequest?.max_tokens === 2048,
    `request carried solve params (t=${lastAiRequest?.temperature}, max_tokens=${lastAiRequest?.max_tokens})`,
  )
  await ai.close()

  responseMode = 'long'
  const longAnswer = await openCapture()
  await longAnswer.setViewportSize({ width: 480, height: 568 })
  await longAnswer.click('.preset[data-preset="solve"]')
  await longAnswer.waitForFunction(() => {
    const status = [...document.querySelectorAll('.reply-status')].at(-1)?.textContent
    return status?.includes('Complete')
  })
  await longAnswer.waitForSelector('.msg.assistant .katex-display .katex')
  const longRendered = await longAnswer.evaluate(() => ({
    textLength: document.querySelector('.msg.assistant .msg-body')?.textContent?.length ?? 0,
    math: !!document.querySelector('.msg.assistant .katex-display .katex'),
    answerFont: getComputedStyle(document.querySelector('.msg.assistant .msg-body')).fontSize,
    lineHeight: getComputedStyle(document.querySelector('.msg.assistant .msg-body')).lineHeight,
  }))
  check(longRendered.textLength > 250 && longRendered.math && longRendered.answerFont === '16px',
    'long answer renders wrapped prose and display LaTeX at readable answer typography (' + JSON.stringify(longRendered) + ')')
  await longAnswer.locator('.msg.assistant').last().hover()
  const longActionGeometry = await longAnswer.locator('.msg.assistant').last().evaluate(message => {
    const body = message.querySelector('.msg-body').getBoundingClientRect()
    const tray = message.querySelector('.msg-actions').getBoundingClientRect()
    const buttons = [...message.querySelectorAll('.msg-actions .msg-action-items button')].map(button => {
      const r = button.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, radius: getComputedStyle(button).borderRadius }
    })
    const container = message.querySelector('.msg-actions')
    return { bodyBottom: body.bottom, trayTop: tray.top, trayBottom: tray.bottom, messageBottom: message.getBoundingClientRect().bottom, trayRadius: getComputedStyle(container).borderRadius, buttons }
  })
  check(longActionGeometry.trayTop >= longActionGeometry.bodyBottom && longActionGeometry.trayBottom <= longActionGeometry.messageBottom &&
    longActionGeometry.buttons.length >= 2 && longActionGeometry.buttons.every(button => button.radius === longActionGeometry.trayRadius && button.left >= 0 && button.right <= 480),
    'long answer reserves a non-overlapping action row with rounded buttons inside the tray (' + JSON.stringify(longActionGeometry) + ')')
  const longEvidence = resolve(root, '..', 'review', 'loop')
  mkdirSync(longEvidence, { recursive: true })
  await longAnswer.screenshot({ path: join(longEvidence, 'long-answer.png'), fullPage: true })
  await longAnswer.close()
  responseMode = 'normal'

  // RU dictionary: with uiLanguage 'ru' the NATIVE RU templates and system
  // prompt must go out (answerLanguage auto + ru UI resolves to Russian).
  await sw.evaluate(
    async (s) => chrome.storage.local.set({ settings: s }),
    { provider: 'custom', baseUrl: `${origin}/v1`, apiKey: 'sk-test-123', uiLanguage: 'ru', answerLanguage: 'auto' },
  )
  const aiRu = await openCapture()
  await aiRu.click('.preset[data-preset="solve"]')
  await waitReply(aiRu)
  const ruUser = lastAiRequest?.messages?.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some(part => part?.type === 'text'))
  const ruText = Array.isArray(ruUser?.content) ? ruUser.content.find(part => part?.type === 'text')?.text : null
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
  check(requestCount === beforeReadFailure && await settingsReadFailure.locator('.msg').count() === 1 && await settingsReadFailure.locator('.turn-image').count() === 1, 'failed settings read is visible and cannot silently switch to defaults or start a request')
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
  check(requestCount === beforeRapid + 1 && await rapid.locator('.msg.user').count() === 2 && await rapid.locator('#ask-btn').getAttribute('aria-label') === 'Stop' && !await rapid.locator('#ask-btn').isDisabled(), 'rapid same-page events reserve one start before settings resolve and retain its Stop controller')
  await rapid.click('#ask-btn')
  await waitSaved(rapid, 'Stopped')
  check((await readSaved(rapid)).conversations.find(c => c.id === (rapid.url().match(/conversation=([^&]+)/)?.[1])).turns.at(-1).status === 'cancelled', 'the surviving same-page request can still be cancelled and saved')
  await rapid.close()
  responseMode = 'normal'

  const layout = await openCapture()
  await layout.setViewportSize({ width: 480, height: 564 })
  const defaultGeometry = await layout.evaluate(() => {
    const thread = document.querySelector('#thread').getBoundingClientRect()
    const composer = document.querySelector('#composer').getBoundingClientRect()
    return { width: document.documentElement.scrollWidth, thread: thread.height, composerBottom: composer.bottom, viewport: innerHeight }
  })
  check(defaultGeometry.width <= 480 && defaultGeometry.thread >= 300 && defaultGeometry.composerBottom <= 564,
    'default 480×564 chat reserves a readable thread (' + JSON.stringify(defaultGeometry) + ')')
  await layout.locator('.turn-image').last().focus()
  await layout.keyboard.press('Enter')
  await layout.waitForFunction(() => document.querySelector('#lightbox')?.open)
  check(await layout.locator('#lightbox-close').evaluate(button => button === document.activeElement),
    'image preview opens as a modal and moves keyboard focus inside')
  await layout.keyboard.press('Tab')
  check(await layout.locator('#lightbox-close').evaluate(button => button === document.activeElement),
    'image preview keeps keyboard focus within its modal controls')
  await layout.keyboard.press('Escape')
  await layout.waitForFunction(() => !document.querySelector('#lightbox')?.open)
  check(await layout.locator('.turn-image').last().evaluate(figure => figure === document.activeElement),
    'Escape closes image preview and restores focus to the exact image opener')
  const beforeMoreOpen = requestCount
  await layout.getByRole('button', { name: 'More', exact: true }).click()
  await layout.waitForFunction(() => document.querySelector('#more-actions')?.matches(':popover-open'))
  await layout.screenshot({ path: join(evidence, 'more.png') })
  const expandedMore = await layout.evaluate(() => {
    const popover = document.querySelector('#more-actions')
    const rect = popover.getBoundingClientRect()
    return {
      expanded: document.querySelector('#more-btn')?.getAttribute('aria-expanded'),
      actions: [...popover.querySelectorAll('button')].map(button => button.textContent),
      bounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: { width: innerWidth, height: innerHeight },
    }
  })
  check(expandedMore.expanded === 'true' && expandedMore.actions.length === 4 &&
    expandedMore.bounds.left >= 0 && expandedMore.bounds.top >= 0 &&
    expandedMore.bounds.right <= 480 && expandedMore.bounds.bottom <= 564 &&
    requestCount === beforeMoreOpen,
  'More opens as a bounded disclosure without sending a request (' + JSON.stringify(expandedMore) + ')')
  await layout.keyboard.press('Tab')
  check(await layout.locator('#more-actions').evaluate(popover => popover.contains(document.activeElement)),
    'Tab moves keyboard focus into the expanded More actions')
  await layout.keyboard.press('Escape')
  await layout.waitForFunction(() => !document.querySelector('#more-actions')?.matches(':popover-open'))
  await layout.waitForFunction(() => document.querySelector('#more-btn')?.getAttribute('aria-expanded') === 'false')
  check(await layout.locator('#more-btn').getAttribute('aria-expanded') === 'false', 'Escape closes More and resets its expanded state')
  await layout.getByRole('button', { name: 'More', exact: true }).click()
  await layout.click('#thread')
  await layout.waitForFunction(() => !document.querySelector('#more-actions')?.matches(':popover-open'))
  check(requestCount === beforeMoreOpen, 'clicking outside More closes it without starting an action')
  await layout.setViewportSize({ width: 320, height: 324 })
  await layout.getByRole('button', { name: 'More', exact: true }).click()
  const narrowGeometry = await layout.evaluate(() => {
    const popover = document.querySelector('#more-actions').getBoundingClientRect()
    const selection = document.querySelector('#new-selection-btn')
    const composer = document.querySelector('#composer').getBoundingClientRect()
    const input = document.querySelector('#ask-input').getBoundingClientRect()
    const send = document.querySelector('#ask-btn').getBoundingClientRect()
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height } }
    return { width: document.documentElement.scrollWidth, popover: { left: popover.left, top: popover.top, right: popover.right, bottom: popover.bottom }, selection: { ...rect('#new-selection-btn'), label: selection.getAttribute('aria-label'), title: selection.title }, hasContextUi: !!document.querySelector('#context-summary, #context-details-btn, #context-dialog'), layout: { header: rect('#capture-top'), presets: rect('#presets'), thread: rect('#thread'), composer: { top: composer.top, bottom: composer.bottom, inputBottom: input.bottom, sendBottom: send.bottom } }, viewport: { width: innerWidth, height: innerHeight } }
  })
  check(narrowGeometry.width <= 320 && narrowGeometry.popover.left >= 0 && narrowGeometry.popover.top >= 0 &&
    narrowGeometry.popover.right <= 320 && narrowGeometry.popover.bottom <= 324 &&
    !narrowGeometry.hasContextUi && narrowGeometry.selection.height === 44 && narrowGeometry.selection.bottom <= narrowGeometry.layout.header.bottom && !!narrowGeometry.selection.label && !!narrowGeometry.selection.title &&
    narrowGeometry.layout.composer.bottom <= 324 && narrowGeometry.layout.composer.inputBottom <= 324 && narrowGeometry.layout.composer.sendBottom <= 324 &&
    await layout.locator('#ask-input').isVisible() && await layout.locator('#ask-btn').isVisible(),
  '320×324 toolbar keeps New selection accessible and the menu/composer reachable (' + JSON.stringify(narrowGeometry) + ')')
  await layout.keyboard.press('Escape')
  await layout.getByRole('button', { name: 'More', exact: true }).click()
  await layout.getByRole('button', { name: 'Explain', exact: true }).click()
  await waitSaved(layout, 'Complete')
  check(lastAiRequest.messages.some(message => JSON.stringify(message.content).toLowerCase().includes('explain')),
    'a task selected from More sends the explicit Explain request')
  const seedExtraImages = () => layout.evaluate(() => new Promise((resolve, reject) => {
    const conversationId = new URL(location.href).searchParams.get('conversation')
    const open = indexedDB.open('study-buddy-conversations', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['conversations', 'attachments'], 'readwrite')
      const conversations = tx.objectStore('conversations')
      const request = conversations.get(conversationId)
      request.onsuccess = () => {
        const conversation = request.result
        const ids = [crypto.randomUUID(), crypto.randomUUID()]
        const largeTaskId = crypto.randomUUID()
        const oldAttachmentId = conversation.activeAttachmentId
        const largeText = 'word  '.repeat(100000)
        conversation.turns.push({ id: crypto.randomUUID(), role: 'user', text: 'Earlier task', display: 'Earlier task', input: 'Earlier task', kind: 'ask', attachmentId: oldAttachmentId, createdAt: Date.now(), locale: 'en', promptVersion: 'fixture' })
        for (const [index, id] of ids.entries()) {
          const createdAt = Date.now() + index * 2
          tx.objectStore('attachments').put({ id, data: new Blob(['fixture ' + index], { type: 'image/png' }), createdAt })
          conversation.turns.push({ id, role: 'user', text: '', kind: 'capture', attachmentId: id, createdAt, locale: 'en', promptVersion: 'capture' })
          if (index === 0) conversation.turns.push({ id: crypto.randomUUID(), role: 'user', text: largeText, display: 'Longer follow-up outside the current context', input: largeText, kind: 'ask', attachmentId: largeTaskId, createdAt: createdAt + 1, locale: 'en', promptVersion: 'fixture' })
        }
        conversation.activeAttachmentId = ids.at(-1)
        conversation.turns.push({ id: crypto.randomUUID(), role: 'user', text: 'Review the newest selection', display: 'Review the newest selection', input: 'Review the newest selection', kind: 'ask', createdAt: Date.now() + 3, locale: 'en', promptVersion: 'fixture' })
        conversations.put(conversation)
        tx.oncomplete = () => { db.close(); resolve(ids[0]) }
      }
      tx.onerror = () => reject(tx.error)
    }
  }))
  const reusableImageId = await seedExtraImages()
  await layout.reload()
  await layout.waitForFunction(() => document.querySelectorAll('.turn-image').length === 3)
  await layout.waitForFunction(() => !!document.querySelector('.msg.context-excluded .context-reuse'))
  const excludedMessages = await layout.evaluate(() => {
    const excluded = [...document.querySelectorAll('.msg.context-excluded')]
    const first = excluded.find(message => message.querySelector('.context-reuse') && message.querySelector('.turn-image'))
    const reuse = first?.querySelector('.context-reuse')
    const body = first?.querySelector('.msg-body')
    const includedBody = document.querySelector('.msg.user:not(.context-excluded) .msg-body')
    const image = first?.querySelector('.turn-image')
    return {
      count: excluded.length,
      marked: !!first && !!image,
      mutedBody: !body || getComputedStyle(body).backgroundColor !== getComputedStyle(includedBody).backgroundColor,
      mutedImage: !!image && getComputedStyle(image).opacity === '0.68',
      noteCount: document.querySelectorAll('.context-exclusion-note').length,
      reuseLabel: reuse?.getAttribute('aria-label'),
      reuseTitle: reuse?.title,
      reuseHasOnlyIcon: !!reuse?.querySelector('svg') && !reuse.textContent.trim(),
      reuseSize: reuse ? [reuse.getBoundingClientRect().width, reuse.getBoundingClientRect().height] : [],
    }
  })
  const reuseLabel = i18nModule.exports.t('en', 'context.reuseTitle')
  check(excludedMessages.count > 0 && excludedMessages.marked && excludedMessages.mutedBody && excludedMessages.mutedImage && excludedMessages.noteCount === 0 &&
    excludedMessages.reuseLabel === reuseLabel && excludedMessages.reuseTitle === reuseLabel && excludedMessages.reuseHasOnlyIcon && excludedMessages.reuseSize[0] === 44 && excludedMessages.reuseSize[1] === 44,
  'excluded history is visibly muted without explanatory text and keeps an accessible 44px reuse icon (' + JSON.stringify(excludedMessages) + ')')
  const reuseRequestCount = requestCount
  await resetCooldown(layout)
  await layout.reload()
  await layout.waitForFunction(() => document.querySelectorAll('.msg.context-excluded .context-reuse').length > 0)
  const reuseButton = layout.locator(`.msg.context-excluded[data-turn="${reusableImageId}"] .context-reuse`)
  check(await reuseButton.count() === 1, 'the excluded image has one reuse action')
  await reuseButton.click()
  const reuseDeadline = Date.now() + 5000
  while (requestCount === reuseRequestCount && Date.now() < reuseDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const reusedImageSent = requestCount === reuseRequestCount + 1 &&
    (lastAiRequest?.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')) ?? false)
  if (requestCount === reuseRequestCount + 1) await waitSaved(layout, 'Complete')
  check(reusedImageSent, 'reusing an excluded image sends it in the next request')
  const narrowToolbar = async (language) => {
    await layout.fill('#ask-input', 'Compare the saved images')
    await layout.setViewportSize({ width: 320, height: 324 })
    return layout.evaluate(() => {
      const selection = document.querySelector('#new-selection-btn')
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height } }
      return { label: selection.getAttribute('aria-label'), title: selection.title, hasContextUi: !!document.querySelector('#context-summary, #context-details-btn, #context-dialog'), bounds: { header: rect('#capture-top'), selection: rect('#new-selection-btn'), history: rect('#history-btn'), newChat: rect('#new-chat-btn'), presets: rect('#presets'), composer: rect('#composer'), ask: rect('#ask-input'), send: rect('#ask-btn') }, overflow: document.documentElement.scrollWidth > innerWidth }
    }).then(result => ({ language, ...result }))
  }
  const narrowEnglish = await narrowToolbar('en')
  check(!narrowEnglish.hasContextUi && narrowEnglish.label.includes('Select another screen area') && narrowEnglish.title === narrowEnglish.label && !narrowEnglish.overflow &&
    narrowEnglish.bounds.selection.height === 44 && narrowEnglish.bounds.selection.right <= narrowEnglish.bounds.newChat.left && narrowEnglish.bounds.composer.bottom <= 324 && narrowEnglish.bounds.ask.bottom <= 324 && narrowEnglish.bounds.send.bottom <= 324,
  '320×324 English toolbar keeps New selection, History, New chat and composer accessible (' + JSON.stringify(narrowEnglish) + ')')
  const mobileActionMenu = layout.locator('.msg.assistant').last().locator('.msg-actions')
  check(await mobileActionMenu.locator('.msg-actions-toggle').isVisible() && await mobileActionMenu.locator('.msg-actions-toggle').evaluate(button => button.getBoundingClientRect().width >= 44 && button.getBoundingClientRect().height >= 44), 'narrow no-hover layout keeps a persistent 44px answer-action menu trigger')
  await mobileActionMenu.locator('.msg-actions-toggle').click()
  check(await mobileActionMenu.locator('.msg-actions-toggle').getAttribute('aria-expanded') === 'true' &&
    await mobileActionMenu.locator('.msg-action-items').isVisible() &&
    await mobileActionMenu.locator('.msg-action-items button[aria-label="Copy"]').isVisible() &&
    await mobileActionMenu.locator('.msg-action-items button[aria-label="Explain simpler"]').isVisible(),
    'touch ellipsis opens visible Copy and Simpler actions')
  await mobileActionMenu.locator('.msg-actions-toggle').press('Escape')
  check(await mobileActionMenu.locator('.msg-actions-toggle').getAttribute('aria-expanded') === 'false', 'Escape closes the touch action menu')
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings')
    await chrome.storage.local.set({ settings: { ...settings, uiLanguage: 'ru' } })
  })
  await layout.reload()
  await layout.waitForFunction(() => document.querySelectorAll('.turn-image').length === 3)
  await layout.fill('#ask-input', 'Compare the saved images')
  await layout.setViewportSize({ width: 480, height: 568 })
  const wideRussian = await layout.evaluate(() => {
    const selection = document.querySelector('#new-selection-btn')
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height } }
    return { label: selection.getAttribute('aria-label'), title: selection.title, hasContextUi: !!document.querySelector('#context-summary, #context-details-btn, #context-dialog'), header: rect('#capture-top'), selection: rect('#new-selection-btn'), history: rect('#history-btn'), newChat: rect('#new-chat-btn'), composer: rect('#composer'), overflow: document.documentElement.scrollWidth > innerWidth }
  })
  check(!wideRussian.hasContextUi && wideRussian.label.includes('Выделить другую область') && wideRussian.title === wideRussian.label && !wideRussian.overflow && wideRussian.selection.height === 44 && wideRussian.selection.bottom <= wideRussian.header.bottom && wideRussian.composer.bottom === 558,
  '480px Russian title row keeps New selection accessible beside History/New chat (' + JSON.stringify(wideRussian) + ')')
  const narrowRussian = await narrowToolbar('ru')
  check(!narrowRussian.hasContextUi && narrowRussian.label.includes('Выделить другую область') && !narrowRussian.overflow && narrowRussian.bounds.selection.height === 44 && narrowRussian.bounds.selection.right <= narrowRussian.bounds.newChat.left && narrowRussian.bounds.composer.bottom <= 324 && narrowRussian.bounds.ask.bottom <= 324 && narrowRussian.bounds.send.bottom <= 324,
  '320×324 Russian toolbar keeps New selection and composer accessible (' + JSON.stringify(narrowRussian) + ')')
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings')
    await chrome.storage.local.set({ settings: { ...settings, uiLanguage: 'en' } })
  })
  await layout.close()

  const hint = await openCapture()
  await hint.setViewportSize({ width: 480, height: 564 })
  await hint.click('[data-preset="hint"]')
  await waitSaved(hint, 'Complete')
  check(lastAiRequest.max_tokens === 512 && lastAiRequest.temperature === 0.3, 'Hint UI uses its bounded one-step prompt budget')
  const hintDb = await readSaved(hint)
  const hintId = hintDb.state.lastConversationId
  check(hintDb.conversations.find(c => c.id === hintId).turns.at(-1).status === 'complete', 'completion status committed to IndexedDB')
  await hint.reload()
  await waitSaved(hint, 'Complete')
  check(await hint.locator('.msg.user').count() === 2, 'reload restores the capture image and prompt without duplicate turns')
  await hint.screenshot({ path: join(evidence, 'dialog.png') })
  const answerActions = hint.locator('.msg.assistant').last().locator('.msg-actions')
  await hint.mouse.move(0, 0)
  const hiddenActions = await answerActions.evaluate(node => getComputedStyle(node).opacity)
  await hint.locator('.msg.assistant').last().hover()
  await hint.waitForFunction(() => getComputedStyle(document.querySelector('.msg.assistant:last-of-type .msg-actions')).opacity === '1')
  const hoveredActions = await answerActions.evaluate(node => getComputedStyle(node).opacity)
  await hint.mouse.move(0, 0)
  await hint.waitForFunction(() => getComputedStyle(document.querySelector('.msg.assistant:last-of-type .msg-actions')).opacity === '0')
  await answerActions.locator('.msg-action-items button').first().focus()
  await hint.waitForFunction(() => getComputedStyle(document.querySelector('.msg.assistant:last-of-type .msg-actions')).opacity === '1')
  const focusedActions = await answerActions.evaluate(node => getComputedStyle(node).opacity)
  const desktopActionState = await answerActions.evaluate(node => ({
    toggleDisplay: getComputedStyle(node.querySelector('.msg-actions-toggle')).display,
    itemsDisplay: getComputedStyle(node.querySelector('.msg-action-items')).display,
    labels: [...node.querySelectorAll('.msg-action-items button')].map(button => button.getAttribute('aria-label')),
  }))
  const actionLabel = await answerActions.locator('.msg-actions-toggle').getAttribute('aria-label')
  const expectedDesktopActionLabels = ['msg.copy', 'msg.simpler', 'msg.retry'].map(key => i18nModule.exports.t('en', key))
  check(hiddenActions === '0' && hoveredActions === '1' && focusedActions === '1' && answerActionLabels.includes(actionLabel), 'answer action tray floats, reveals on hover/focus, and retains its localized label (' + JSON.stringify({ hiddenActions, hoveredActions, focusedActions, actionLabel }) + ')')
  check(desktopActionState.toggleDisplay === 'none' && desktopActionState.itemsDisplay === 'flex' &&
    JSON.stringify(desktopActionState.labels) === JSON.stringify(expectedDesktopActionLabels),
    'desktop answer tray hides its redundant menu toggle and shows only Copy, Simpler, and Retry (' + JSON.stringify(desktopActionState) + ')')
  await answerActions.locator('.msg-action-items button[aria-label="Copy"]').click()
  await hint.waitForSelector('.msg-copy-feedback')
  const copyFeedback = await hint.evaluate(() => ({
    text: document.querySelector('.msg-copy-feedback')?.textContent,
    role: document.querySelector('.msg-copy-feedback')?.getAttribute('role'),
    live: document.querySelector('.msg-copy-feedback')?.getAttribute('aria-live'),
    label: document.querySelector('.msg-action-items button[aria-label="Copied"]')?.getAttribute('aria-label'),
  }))
  check(copyFeedback.text === 'Copied' && copyFeedback.role === 'status' && copyFeedback.live === 'polite' && copyFeedback.label === 'Copied',
    'Copy confirms a successful clipboard write with a short accessible toast (' + JSON.stringify(copyFeedback) + ')')
  await hint.waitForSelector('.msg-copy-feedback', { state: 'detached', timeout: 2500 })
  await resetCooldown(hint)
  await hint.fill('#ask-input', 'What is the next step?')
  await hint.click('#ask-btn')
  await hint.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 2)
  await waitSaved(hint, 'Complete')
  check(lastAiRequest.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length === 1, 'attachment sent once across multiple turns')
  await resetCooldown(hint)
  const usersBeforeRetry = await hint.locator('.msg.user').count()
  await hint.locator('.msg.assistant').last().hover()
  await hint.click('[data-retry]')
  await hint.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 3)
  await waitSaved(hint, 'Complete')
  check(await hint.locator('.msg.user').count() === usersBeforeRetry && lastAiRequest.max_tokens === 2048, 'explicit Regenerate preserves the source user turn and its original turn budget')

  const checked = await openCapture()
  await checked.setViewportSize({ width: 480, height: 564 })
  check(await checked.locator('#ask-form').isVisible() && !(await checked.locator('#check-form').count()),
    'Check keeps the ordinary composer and has no separate attempt form')
  await checked.click('#check-btn')
  await waitSaved(checked, 'Complete')
  await checked.waitForFunction(() => document.querySelector('#ask-btn').disabled && !!document.querySelector('#ask-btn .cooldown-countdown')?.textContent)
  const cooldownStart = await checked.evaluate(() => ({ visible: document.querySelector('#ask-btn .cooldown-countdown').textContent, accessible: document.querySelector('#ask-btn').getAttribute('aria-label'), askDisabled: document.querySelector('#ask-btn').disabled, checkDisabled: document.querySelector('#check-btn').disabled, errorHidden: document.querySelector('#operation-error').hidden, hasBanner: !!document.querySelector('#cooldown-banner') }))
  const checkRequests = requestCount
  await checked.fill('#ask-input', 'Do not queue this draft')
  await checked.evaluate(() => document.querySelector('#ask-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  check(cooldownStart.askDisabled && cooldownStart.checkDisabled && cooldownStart.errorHidden && !cooldownStart.hasBanner && cooldownStart.accessible.includes(cooldownStart.visible) && requestCount === checkRequests && await checked.inputValue('#ask-input') === 'Do not queue this draft', 'send control shows countdown, disables send/Check, and never queues a typed draft (' + JSON.stringify(cooldownStart) + ')')
  await checked.waitForFunction((prior) => document.querySelector('#ask-btn .cooldown-countdown')?.textContent !== prior, cooldownStart.visible, { timeout: 2500 })
  check(true, 'disabled send-control countdown ticks down without changing the draft')
  await checked.waitForFunction(() => !document.querySelector('#cooldown-banner') && !document.querySelector('#ask-btn').disabled && !document.querySelector('#ask-btn .cooldown-countdown') && !document.querySelector('#check-btn').disabled, { timeout: 12000 })
  check(await checked.inputValue('#ask-input') === 'Do not queue this draft' && requestCount === checkRequests, 'cooldown expiry clears countdown, re-enables actions and does not auto-send the draft')
  const checkGeometry = await checked.evaluate(() => ({ width: document.documentElement.scrollWidth, thread: document.querySelector('#thread').getBoundingClientRect().height, composerBottom: document.querySelector('#composer').getBoundingClientRect().bottom, viewport: innerHeight }))
  check(checkGeometry.width <= 480 && checkGeometry.thread >= 180 && checkGeometry.composerBottom <= 564,
    'direct Check preserves the compact composer and dialogue (' + JSON.stringify(checkGeometry) + ')')
  await checked.screenshot({ path: join(evidence, 'check.png') })
  const checkedDb = await readSaved(checked)
  const checkedId = checkedDb.state.lastConversationId
  const checkedConversation = checkedDb.conversations.find(c => c.id === checkedId)
  const checkedTurn = checkedConversation.turns.find(turn => turn.role === 'user' && turn.kind === 'check')
  check(!!checkedTurn && checkedTurn.input === undefined && checkedTurn.attachmentId === capture.id, 'Check is stored as an image-grounded user turn without a required text attempt')
  check(lastAiRequest.max_tokens === 1024 && lastAiRequest.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.text?.includes('work or answer visible in the current image') && p.text?.includes('no student work or answer that can be checked'))), 'Check asks the model to inspect visible image work and state honestly when there is none')
  await resetCooldown(checked)
  responseMode = 'slow'
  await checked.fill('#ask-input', 'Accepted draft should clear immediately')
  await checked.click('#ask-btn')
  await checked.waitForFunction(() => [...document.querySelectorAll('.msg.user .msg-body')].at(-1)?.textContent?.includes('Accepted draft should clear immediately') && document.querySelector('#ask-input').value === '')
  check(await checked.inputValue('#ask-input') === '', 'accepted user turn clears its draft before the model finishes')
  await checked.click('#ask-btn')
  await waitSaved(checked, 'Stopped')
  responseMode = 'normal'
  const beforeCooldown = requestCount
  await checked.fill('#ask-input', 'Too soon')
  check(await checked.locator('#ask-btn').isDisabled() && requestCount === beforeCooldown, 'cooldown keeps Send disabled without queuing another request')
  check(await checked.inputValue('#ask-input') === 'Too soon', 'cooldown retains the typed question')
  await checked.click('#history-btn')
  await checked.locator(`.history-row:has([data-conversation="${checkedId}"])`).waitFor()
  await checked.waitForFunction(() => document.getElementById('storage-usage')?.textContent?.includes('MiB'))
  await checked.screenshot({ path: join(evidence, 'history.png') })
  const row = checked.locator(`.history-row:has([data-conversation="${checkedId}"])`)
  const rowGeometry = await row.evaluate(node => {
    const open = node.querySelector('.history-open').getBoundingClientRect()
    const remove = node.querySelector('.history-delete').getBoundingClientRect()
    return { children: node.children.length, title: node.querySelector('.history-title')?.textContent, date: node.querySelector('.history-date')?.textContent, deleteSize: [remove.width, remove.height], sameRow: Math.abs((open.top + open.height / 2) - (remove.top + remove.height / 2)) < 4 }
  })
  check(rowGeometry.children === 2 && rowGeometry.title === 'Accepted draft should clear immediately' && !rowGeometry.title.includes('\n') && !!rowGeometry.date && rowGeometry.sameRow && rowGeometry.deleteSize[0] >= 44 && rowGeometry.deleteSize[1] >= 44, 'history keeps a readable title/date and 44px delete target on one row (' + JSON.stringify(rowGeometry) + ')')
  check(!(await checked.locator('#settings-btn').count()) && !(await row.getByRole('button', { name: /Export/ }).count()), 'History has no gear or JSON export control')
  await row.locator('.history-delete').click()
  await checked.locator('#delete-dialog[open]').waitFor()
  await checked.click('#delete-cancel')
  check((await readSaved(checked)).conversations.some(c => c.id === checkedId) && await row.locator('.history-delete').evaluate(button => document.activeElement === button), 'cancel keeps the conversation and restores focus to its Delete opener')
  await row.locator('.history-delete').click()
  await sw.evaluate(() => {
    const original = IDBObjectStore.prototype.delete
    IDBObjectStore.prototype.delete = function (...args) {
      if (this.name === 'conversations') {
        IDBObjectStore.prototype.delete = original
        throw new DOMException('expected synthetic delete failure', 'QuotaExceededError')
      }
      return original.apply(this, args)
    }
  })
  await checked.click('#delete-confirm')
  await checked.locator('#delete-error:not([hidden])').waitFor()
  check(await checked.locator('#delete-dialog').evaluate(dialog => dialog.open) && await checked.locator('#delete-error').textContent() === "Couldn't delete this chat. Try again." && (await readSaved(checked)).conversations.some(c => c.id === checkedId), 'delete write failure shows a safe retry message inside the dialog and preserves the target')
  await checked.click('#delete-confirm')
  await checked.waitForFunction((id) => !document.querySelector(`[data-conversation="${id}"]`), checkedId)
  check(!(await readSaved(checked)).conversations.some(c => c.id === checkedId) && await checked.evaluate(() => document.activeElement?.id === 'history-back' || document.activeElement?.classList.contains('history-open')), 'in-app confirmation deletes the selected conversation and focuses a safe remaining target')

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
  const quotaRow = quota.locator('.history-row:has(.history-open[data-conversation="' + quotaId + '"])')
  check(await quotaRow.count() === 1 && quotaDb.conversations.find(c => c.id === quotaId).turns.at(-1).status === 'interrupted', 'failed write remains in History with its interrupted partial status and no export affordance')
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
  let embedded = await chatFrameOn(page)
  await embedded.waitForSelector('#view-capture:not([hidden])')
  const embeddedElement = await embedded.frameElement()
  const embeddedBounds = await embeddedElement.boundingBox()
  const outsidePoint = embeddedBounds.x > 24
    ? { x: Math.max(4, Math.floor(embeddedBounds.x - 8)), y: Math.max(8, Math.floor(embeddedBounds.y + 12)) }
    : { x: Math.min(1270, Math.ceil(embeddedBounds.x + embeddedBounds.width + 8)), y: Math.max(8, Math.floor(embeddedBounds.y + 12)) }
  const requestCountBeforeHostDismiss = requestCount
  await embedded.getByRole('button', { name: 'More', exact: true }).click()
  await embedded.waitForFunction(() => document.querySelector('#more-actions')?.matches(':popover-open'))
  await page.mouse.click(outsidePoint.x, outsidePoint.y)
  await embedded.waitForFunction(() => !document.querySelector('#more-actions')?.matches(':popover-open'))
  check(requestCount === requestCountBeforeHostDismiss,
    'a click on the host page outside the iframe dismisses More without starting an action')
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
  embedded = await chatFrameOn(page)
  await embedded.waitForFunction(() => document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)?.naturalWidth > 0)
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
  const oldRowText = ['Study Buddy', 'New chat', 'Hint', 'Check', 'Solve', 'Explain', 'Translate', 'Summarize'].includes(oldConversation.title)
    ? oldConversation.turns.find(turn => turn.role === 'assistant' && turn.text)?.text.split(/\r?\n/)[0] || 'New chat'
    : oldConversation.title
  const oldHistoryRow = historyOpen.filter({ hasText: oldRowText }).first()
  await oldHistoryRow.waitFor()
  await oldHistoryRow.click()
  await embedded.waitForSelector('#view-capture:not([hidden])')
  const tabBinding = async () => pageTabId === undefined ? undefined :
    sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${pageTabId}`)
  const selectedClosedId = await tabBinding()
  check(selectedClosedId === nativeId, `History opens the closed saved conversation (${oldConversation.id})`)
  await embedded.click('#history-btn')
  const nextRowText = ['Study Buddy', 'New chat', 'Hint', 'Check', 'Solve', 'Explain', 'Translate', 'Summarize'].includes(nextConversation.title) ? 'New chat' : nextConversation.title
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
  await duplicate.click('#new-chat-btn')
  await duplicate.waitForFunction(() => document.querySelectorAll('.msg').length === 0 && document.querySelector('.turn-image') === null)
  check((await readSaved(duplicate)).state.lastConversationId !== nativeId, 'New chat creates a distinct empty conversation without a prior image message')
  check(await duplicate.locator('#ask-input').inputValue() === '' && !(await duplicate.locator('#check-form').count()), 'New chat also clears the free-form draft and leaves no obsolete Check form')
  await duplicate.setViewportSize({ width: 340, height: 620 })
  await duplicate.click('#check-btn')
  await duplicate.screenshot({ path: join(evidence, 'narrow.png') })
  check(await duplicate.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow panel has no horizontal overflow')

  const dismissPage = await ctx.newPage()
  const dismissUrl = `${origin}/dismiss-error`
  await dismissPage.goto(dismissUrl)
  await triggerAction(dismissPage)
  await dismissPage.waitForSelector('[data-study-buddy="overlay"]')
  await dismissPage.keyboard.press('Escape')
  await dismissPage.waitForSelector('[data-study-buddy="overlay"]', { state: 'detached' })
  const dismissTabId = await sw.evaluate(async (targetUrl) => (await chrome.tabs.query({})).find(tab => tab.url === targetUrl)?.id, dismissUrl)
  if (dismissTabId === undefined) throw new Error('Could not find the initial error fixture tab.')
  const beforeDismissError = await readSaved(duplicate)
  await sw.evaluate(async (tabId) => new Promise((resolve) => chrome.tabs.sendMessage(tabId,
    { type: 'SHOW_CHAT', state: { kind: 'error', message: 'Dismiss fixture' } }, () => resolve())), dismissTabId)
  await dismissPage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  await clickHostButtonOn(dismissPage, '✕')
  await dismissPage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  const dismissBinding = dismissTabId === undefined ? undefined :
    await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${dismissTabId}`)
  const afterDismissError = await readSaved(duplicate)
  check(dismissBinding === undefined &&
    beforeDismissError.conversations.map(c => c.id).join(',') === afterDismissError.conversations.map(c => c.id).join(','),
  'Close dismisses an initial error host without creating or deleting a conversation')
  await dismissPage.close()

  const showChatOnTab = async (tabId, state) => sw.evaluate(async ({ tabId, state }) => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'SHOW_CHAT', state }, () => resolve())
  }), { tabId, state })
  const earlyClosePage = await ctx.newPage()
  await earlyClosePage.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || !location.pathname.endsWith('/chat.html')) return
    const originalGet = chrome.storage.local.get.bind(chrome.storage.local)
    chrome.storage.local.get = async (...args) => {
      sessionStorage.setItem('__studyBuddyEarlyClose', 'pending')
      await new Promise(resolve => setTimeout(resolve, 800))
      return originalGet(...args)
    }
  })
  const earlyCloseUrl = `${origin}/close-during-boot`
  await earlyClosePage.goto(earlyCloseUrl)
  await triggerAction(earlyClosePage)
  await earlyClosePage.waitForSelector('[data-study-buddy="overlay"]')
  await earlyClosePage.keyboard.press('Escape')
  await earlyClosePage.waitForSelector('[data-study-buddy="overlay"]', { state: 'detached' })
  const earlyCloseTabId = await sw.evaluate(async (targetUrl) => (await chrome.tabs.query({})).find(tab => tab.url === targetUrl)?.id, earlyCloseUrl)
  if (earlyCloseTabId === undefined) throw new Error('Could not find the early-close fixture tab.')
  await sw.evaluate(async ({ tabId, conversationId }) => chrome.storage.session.set({ [`dialog.tab.${tabId}`]: conversationId }),
    { tabId: earlyCloseTabId, conversationId: nativeId })
  await showChatOnTab(earlyCloseTabId, { kind: 'conversation', conversationId: nativeId })
  await earlyClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  const earlyCloseFrame = await chatFrameOn(earlyClosePage)
  await earlyCloseFrame.waitForFunction(() => sessionStorage.getItem('__studyBuddyEarlyClose') === 'pending')
  await clickHostButtonOn(earlyClosePage, '✕')
  await earlyClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  await earlyClosePage.waitForTimeout(900)
  const earlyCloseBinding = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${earlyCloseTabId}`)
  check(earlyCloseBinding === undefined, 'Close during delayed chat boot prevents initialization from restoring the released tab binding')
  await triggerAction(earlyClosePage)
  await earlyClosePage.waitForSelector('[data-study-buddy="overlay"]')
  await earlyClosePage.mouse.move(60, 160)
  await earlyClosePage.mouse.down()
  await earlyClosePage.mouse.move(180, 210, { steps: 5 })
  await earlyClosePage.mouse.up()
  await earlyClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  const earlyCaptureFrame = await chatFrameOn(earlyClosePage)
  await earlyCaptureFrame.waitForFunction(() => document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)?.naturalWidth > 0)
  const earlyCaptureId = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${earlyCloseTabId}`)
  check(typeof earlyCaptureId === 'string' && earlyCaptureId !== nativeId,
    'the next toolbar capture after Close during boot creates a fresh conversation')
  await clickHostButtonOn(earlyClosePage, '✕')
  await earlyClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  await earlyClosePage.close()

  const boundDismissPage = await ctx.newPage()
  const boundDismissUrl = `${origin}/dismiss-bound-error`
  await boundDismissPage.goto(boundDismissUrl)
  await triggerAction(boundDismissPage)
  await boundDismissPage.waitForSelector('[data-study-buddy="overlay"]')
  await boundDismissPage.keyboard.press('Escape')
  await boundDismissPage.waitForSelector('[data-study-buddy="overlay"]', { state: 'detached' })
  const boundDismissTabId = await sw.evaluate(async (targetUrl) => (await chrome.tabs.query({})).find(tab => tab.url === targetUrl)?.id, boundDismissUrl)
  if (boundDismissTabId === undefined) throw new Error('Could not find the existing-dialog fixture tab.')
  await sw.evaluate(async ({ tabId, conversationId }) => chrome.storage.session.set({ [`dialog.tab.${tabId}`]: conversationId }),
    { tabId: boundDismissTabId, conversationId: nativeId })
  await showChatOnTab(boundDismissTabId, { kind: 'conversation', conversationId: nativeId })
  await boundDismissPage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  const boundDismissFrame = await chatFrameOn(boundDismissPage)
  await boundDismissFrame.waitForSelector('#view-capture:not([hidden])')
  await boundDismissFrame.click('#history-btn')
  await boundDismissFrame.waitForSelector('#view-history:not([hidden])')
  const historyOrder = await boundDismissFrame.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('study-buddy-conversations', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction('conversations', 'readonly').objectStore('conversations').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return rows.sort((a, b) => Math.max(...b.turns.map(turn => turn.createdAt), b.createdAt) - Math.max(...a.turns.map(turn => turn.createdAt), a.createdAt)).map(conversation => ({
      id: conversation.id,
      title: conversation.title,
      turnCount: conversation.turns.length,
    }))
  })
  const historyTargetIndex = historyOrder.findIndex(conversation => conversation.id === nextConversationId)
  if (historyTargetIndex < 0) throw new Error('Could not locate the saved History target conversation.')
  await boundDismissFrame.waitForFunction((expected) => {
    const visible = [...document.querySelectorAll('.history-row .history-open')]
    return visible.length === expected.length && expected.every((row, index) => visible[index]?.dataset.conversation === row.id)
  }, historyOrder)
  await boundDismissFrame.locator('.history-row .history-open').nth(historyTargetIndex).click()
  const selectedHistoryBinding = await sw.evaluate(async ({ key, expected }) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await chrome.storage.session.get(key))[key] === expected) return expected
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return undefined
  }, { key: `dialog.tab.${boundDismissTabId}`, expected: nextConversationId })
  if (selectedHistoryBinding !== nextConversationId) throw new Error('History did not select the other saved conversation for its tab.')
  await showChatOnTab(boundDismissTabId, { kind: 'error', message: 'Dismiss bound fixture' })
  await boundDismissFrame.waitForSelector('#view-error:not([hidden])')
  await clickHostButtonOn(boundDismissPage, '✕')
  await boundDismissPage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  const boundDismissBinding = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${boundDismissTabId}`)
  const afterBoundDismiss = await readSaved(duplicate)
  check(boundDismissBinding === undefined && afterBoundDismiss.conversations.some(conversation => conversation.id === nextConversationId),
    'History selection updates the host ID; SHOW_CHAT error then Close removes the host and clears that dialog binding')
  await boundDismissPage.close()

  const newChatClosePage = await ctx.newPage()
  const newChatCloseUrl = `${origin}/new-chat-close`
  await newChatClosePage.goto(newChatCloseUrl)
  await triggerAction(newChatClosePage)
  await newChatClosePage.waitForSelector('[data-study-buddy="overlay"]')
  await newChatClosePage.keyboard.press('Escape')
  await newChatClosePage.waitForSelector('[data-study-buddy="overlay"]', { state: 'detached' })
  const newChatCloseTabId = await sw.evaluate(async (targetUrl) => (await chrome.tabs.query({})).find(tab => tab.url === targetUrl)?.id, newChatCloseUrl)
  if (newChatCloseTabId === undefined) throw new Error('Could not find the New chat fixture tab.')
  await sw.evaluate(async ({ tabId, conversationId }) => chrome.storage.session.set({ [`dialog.tab.${tabId}`]: conversationId }),
    { tabId: newChatCloseTabId, conversationId: nativeId })
  await showChatOnTab(newChatCloseTabId, { kind: 'conversation', conversationId: nativeId })
  await newChatClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  const newChatCloseFrame = await chatFrameOn(newChatClosePage)
  await newChatCloseFrame.waitForSelector('#view-capture:not([hidden])')
  await newChatCloseFrame.waitForFunction(() => !!document.getElementById('conversation-title')?.textContent?.trim())
  await newChatCloseFrame.evaluate(() => {
    const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (...args) => {
      const response = originalSend(...args)
      if (args[0]?.type === 'CONVERSATION' && args[0]?.action === 'select') {
        return response.then(async value => {
          if (value?.ok && value.value?.id !== new URLSearchParams(location.search).get('conversation')) {
            sessionStorage.setItem('__studyBuddySelectMutated', value.value.id)
            await new Promise(() => {}) // keep select pending until the host closes this frame
          }
          return value
        })
      }
      return response
    }
  })
  await newChatCloseFrame.click('#new-chat-btn')
  await newChatCloseFrame.waitForFunction(() => !!sessionStorage.getItem('__studyBuddySelectMutated'))
  const newChatBinding = await newChatCloseFrame.evaluate(() => sessionStorage.getItem('__studyBuddySelectMutated'))
  const selectedBeforeClose = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${newChatCloseTabId}`)
  if (!newChatBinding || selectedBeforeClose !== newChatBinding) throw new Error('New chat selection did not reach its tab binding before the delayed reply.')
  await clickHostButtonOn(newChatClosePage, '✕')
  await newChatClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  const newChatBindingAfterClose = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${newChatCloseTabId}`)
  const afterNewChatClose = await readSaved(duplicate)
  check(newChatBinding !== nativeId && newChatBindingAfterClose === undefined &&
    afterNewChatClose.conversations.some(conversation => conversation.id === newChatBinding),
  'Close during a delayed New chat select acknowledgement clears its pending ID and removes the host')
  await newChatClosePage.close()

  const createClosePage = await ctx.newPage()
  const createCloseUrl = `${origin}/create-close`
  await createClosePage.goto(createCloseUrl)
  await triggerAction(createClosePage)
  await createClosePage.waitForSelector('[data-study-buddy="overlay"]')
  await createClosePage.keyboard.press('Escape')
  await createClosePage.waitForSelector('[data-study-buddy="overlay"]', { state: 'detached' })
  const createCloseTabId = await sw.evaluate(async (targetUrl) => (await chrome.tabs.query({})).find(tab => tab.url === targetUrl)?.id, createCloseUrl)
  if (createCloseTabId === undefined) throw new Error('Could not find the delayed-create fixture tab.')
  await sw.evaluate(async ({ tabId, conversationId }) => chrome.storage.session.set({ [`dialog.tab.${tabId}`]: conversationId }),
    { tabId: createCloseTabId, conversationId: nativeId })
  await showChatOnTab(createCloseTabId, { kind: 'conversation', conversationId: nativeId })
  await createClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  const createCloseFrame = await chatFrameOn(createClosePage)
  await createCloseFrame.waitForSelector('#view-capture:not([hidden])')
  const beforeDelayedCreate = await readSaved(duplicate)
  await createCloseFrame.evaluate(() => {
    const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (...args) => {
      const response = originalSend(...args)
      if (args[0]?.type === 'CONVERSATION' && args[0]?.action === 'create') {
        return response.then(async value => {
          if (value?.ok) {
            sessionStorage.setItem('__studyBuddyCreateMutated', value.value.id)
            await new Promise(resolve => setTimeout(resolve, 700))
          }
          return value
        })
      }
      return response
    }
  })
  await createCloseFrame.click('#new-chat-btn')
  await createCloseFrame.waitForFunction(() => !!sessionStorage.getItem('__studyBuddyCreateMutated'))
  const createdBeforeClose = await createCloseFrame.evaluate(() => sessionStorage.getItem('__studyBuddyCreateMutated'))
  const bindingDuringCreateReply = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${createCloseTabId}`)
  if (bindingDuringCreateReply !== nativeId) throw new Error('Create changed the tab binding before the delayed client reply.')
  await clickHostButtonOn(createClosePage, '✕')
  await createClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  await createClosePage.waitForTimeout(800)
  const afterCreateCloseBinding = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${createCloseTabId}`)
  const afterDelayedCreate = await readSaved(duplicate)
  check(afterCreateCloseBinding === undefined && afterDelayedCreate.conversations.some(conversation =>
    conversation.id === createdBeforeClose && !beforeDelayedCreate.conversations.some(saved => saved.id === conversation.id)),
  'Close during a delayed New chat create releases the old binding and leaves the created dialog saved without reselecting it')
  await createClosePage.close()

  const closeRacePage = await ctx.newPage()
  const closeRaceUrl = `${origin}/late-close-response`
  await closeRacePage.goto(closeRaceUrl)
  await triggerAction(closeRacePage)
  await closeRacePage.waitForSelector('[data-study-buddy="overlay"]')
  await closeRacePage.keyboard.press('Escape')
  await closeRacePage.waitForSelector('[data-study-buddy="overlay"]', { state: 'detached' })
  const closeRaceTabId = await sw.evaluate(async (targetUrl) => (await chrome.tabs.query({})).find(tab => tab.url === targetUrl)?.id, closeRaceUrl)
  if (closeRaceTabId === undefined) throw new Error('Could not find the late-close fixture tab.')
  await sw.evaluate(async ({ tabId, conversationId }) => chrome.storage.session.set({ [`dialog.tab.${tabId}`]: conversationId }),
    { tabId: closeRaceTabId, conversationId: nativeId })
  await showChatOnTab(closeRaceTabId, { kind: 'conversation', conversationId: nativeId })
  await closeRacePage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  const closeRaceFrame = await chatFrameOn(closeRacePage)
  await closeRaceFrame.waitForSelector('#view-capture:not([hidden])')
  await closeRaceFrame.evaluate(() => {
    window.addEventListener('message', event => {
      if (event.data?.source !== 'study-buddy-host' || event.data.action !== 'close') return
      const ids = JSON.parse(sessionStorage.getItem('__studyBuddyHostCloseIds') || '[]')
      ids.push(event.data.closeId)
      sessionStorage.setItem('__studyBuddyHostCloseIds', JSON.stringify(ids))
    })
  })
  await sw.evaluate(async (tabId) => chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => {
    const original = chrome.runtime.sendMessage
    let closeResponseCount = 0
    const releaseCloseResponses = []
    let delayedClosed
    let replaying = false
    chrome.runtime.sendMessage = function (message, ...args) {
      const response = original.apply(chrome.runtime, [message, ...args])
      if (message?.type === 'DIALOG_CLOSED') {
        closeResponseCount++
        sessionStorage.setItem('__studyBuddyCloseResponseCount', String(closeResponseCount))
        const calls = JSON.parse(sessionStorage.getItem('__studyBuddyCloseCalls') || '[]')
        calls.push(message.conversationId)
        sessionStorage.setItem('__studyBuddyCloseCalls', JSON.stringify(calls))
        return Promise.resolve(response).then(value => new Promise(resolve => {
          releaseCloseResponses.push({ conversationId: message.conversationId, release: () => resolve(value) })
          sessionStorage.setItem('__studyBuddyCloseResponsePending', 'yes')
          sessionStorage.setItem('__studyBuddyPendingCloseConversations', JSON.stringify(releaseCloseResponses.map(item => item.conversationId)))
        }))
      }
      return response
    }
    window.addEventListener('message', event => {
      const message = event.data
      if (replaying) return
      if (!delayedClosed && event.source !== window && message?.source === 'study-buddy-chat' && message.action === 'closed') {
        delayedClosed = { data: message, origin: event.origin, source: event.source }
        sessionStorage.setItem('__studyBuddyStaleClosed', message.closeId)
        return
      }
      if (event.source === window && message?.__studyBuddyReleaseStaleClosed && delayedClosed) {
        event.stopImmediatePropagation()
        replaying = true
        window.dispatchEvent(new MessageEvent('message', delayedClosed))
        replaying = false
        sessionStorage.setItem('__studyBuddyStaleClosedReplayed', 'yes')
      }
      if (event.source === window && message?.__studyBuddyReleaseCloseResponse) {
        event.stopImmediatePropagation()
        for (let index = releaseCloseResponses.length - 1; index >= 0; index--) {
          const response = releaseCloseResponses[index]
          if (response.conversationId !== message.conversationId) continue
          releaseCloseResponses.splice(index, 1)
          response.release()
        }
        sessionStorage.setItem('__studyBuddyPendingCloseConversations', JSON.stringify(releaseCloseResponses.map(item => item.conversationId)))
        sessionStorage.setItem('__studyBuddyReleasedCloseConversation', message.conversationId)
      }
    }, true)
  } }), closeRaceTabId)
  await clickHostButtonOn(closeRacePage, '✕')
  await closeRacePage.waitForFunction(() => !!sessionStorage.getItem('__studyBuddyStaleClosed'))
  const newerConversationId = await closeRaceFrame.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'CONVERSATION', action: 'create', title: 'Late close target' })
    if (!response?.ok) throw new Error('Could not create the newer SHOW_CHAT fixture.')
    return response.value.id
  })
  await showChatOnTab(closeRaceTabId, { kind: 'conversation', conversationId: newerConversationId })
  await closeRaceFrame.waitForFunction(() => document.getElementById('conversation-title')?.textContent === 'Late close target')
  const newerBinding = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${closeRaceTabId}`)
  if (newerBinding !== newerConversationId) throw new Error('The newer SHOW_CHAT did not select its conversation before Close.')
  await closeRacePage.waitForFunction(() => sessionStorage.getItem('__studyBuddyCloseResponsePending') === 'yes')
  await closeRacePage.evaluate(conversationId => window.postMessage({ __studyBuddyReleaseCloseResponse: true, conversationId }, '*'), nativeId)
  await closeRacePage.waitForFunction(id => sessionStorage.getItem('__studyBuddyReleasedCloseConversation') === id, nativeId)
  check(await closeRacePage.locator('[data-study-buddy="chat"]').count() === 1 &&
    await sw.evaluate(async ({ key, id }) => (await chrome.storage.session.get(key))[key] === id,
      { key: `dialog.tab.${closeRaceTabId}`, id: newerConversationId }),
    'a late unlink response for A preserves the newer SHOW_CHAT B and its binding')
  await clickHostButtonOn(closeRacePage, '✕')
  await closeRacePage.waitForFunction(id => JSON.parse(sessionStorage.getItem('__studyBuddyPendingCloseConversations') || '[]').includes(id), newerConversationId)
  const callsBeforeStaleReplay = await closeRacePage.evaluate(() => Number(sessionStorage.getItem('__studyBuddyCloseResponseCount')))
  if (callsBeforeStaleReplay !== 2) throw new Error('The two explicit X clicks did not produce exactly two distinct unlink requests.')
  await closeRacePage.evaluate(() => window.postMessage({ __studyBuddyReleaseStaleClosed: true }, '*'))
  await closeRacePage.waitForFunction(() => sessionStorage.getItem('__studyBuddyStaleClosedReplayed') === 'yes')
  const closeRaceCalls = await closeRacePage.evaluate(() => sessionStorage.getItem('__studyBuddyCloseResponseCount'))
  const closeRaceHostCount = await closeRacePage.locator('[data-study-buddy="chat"]').count()
  const closeRaceCallIds = await closeRacePage.evaluate(() => sessionStorage.getItem('__studyBuddyCloseCalls'))
  const closeRaceHostIds = await closeRaceFrame.evaluate(() => sessionStorage.getItem('__studyBuddyHostCloseIds'))
  const staleClosedId = await closeRacePage.evaluate(() => sessionStorage.getItem('__studyBuddyStaleClosed'))
  check(Number(closeRaceCalls) === callsBeforeStaleReplay && closeRaceHostCount === 1,
    `a stale closed(A) cannot borrow the newer X(B) request or start another unlink (before=${callsBeforeStaleReplay}, after=${closeRaceCalls}, hosts=${closeRaceHostCount}, stale=${staleClosedId}, closes=${closeRaceHostIds}, unlinks=${closeRaceCallIds})`)
  await closeRacePage.evaluate(conversationId => window.postMessage({ __studyBuddyReleaseCloseResponse: true, conversationId }, '*'), newerConversationId)
  await closeRacePage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  const closeRaceBindingAfter = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${closeRaceTabId}`)
  check(closeRaceBindingAfter === undefined, 'the newer conversation remains closable after the stale response is discarded')
  await closeRacePage.close()

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
  const recaptured = await chatFrameOn(page)
  await recaptured.waitForFunction(() => document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)?.naturalWidth > 0)
  const recaptureDb = await readSaved(recaptured)
  const recaptureDialog = recaptureDb.conversations.find(c => c.id === nextConversationId)
  const pageBinding = pageTabId === undefined ? undefined : await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.tab.${pageTabId}`)
  check(pageBinding === nextConversationId && recaptureDialog.activeAttachmentId !== nextAttachmentId && recaptureDialog.turns.some(turn => turn.kind === 'capture' && turn.attachmentId === nextAttachmentId) && recaptureDialog.turns.some(turn => turn.kind === 'capture' && turn.attachmentId === recaptureDialog.activeAttachmentId), 'new capture continues the tab-selected dialog while keeping old turn attachment links')
  await resetCooldown(recaptured)
  const oldCount = await recaptured.locator('.msg.assistant').count()
  await recaptured.fill('#ask-input', 'Use the newly selected task')
  await recaptured.click('#ask-btn')
  await recaptured.waitForFunction(count => document.querySelectorAll('.msg.assistant').length > count, oldCount)
  await waitSaved(recaptured, 'Complete')
  check(lastAiRequest.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length === 2, 'multi-capture request includes both unique source images')

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
  const quickFrame = await chatFrameOn(quickPage)
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
  const otherFrame = await chatFrameOn(otherPage)
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
    await resumed.waitForFunction(() => document.querySelectorAll('.turn-image').item(document.querySelectorAll('.turn-image').length - 1)?.naturalWidth > 0)
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
