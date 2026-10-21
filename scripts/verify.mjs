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
import { DatabaseSync } from 'node:sqlite'
import { createServer as createNetServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { createServer as createViteServer } from 'vite'
import vm from 'node:vm'
import ts from 'typescript'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const root = resolve(fileURLToPath(import.meta.url), '..')
const repo = resolve(root, '..')
const reviewEvidence = resolve(repo, 'review', 'loop')
const acceptanceEvidence = { invalidInstallationCredential: null, installationRecovery: null, budgetLimit: null }
const dist = resolve(repo, 'review', 'verify-dist')
const i18nModule = { exports: {} }
const i18nSource = ts.transpileModule(readFileSync(resolve(root, '..', 'src/shared/i18n.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
vm.runInNewContext(`(function(module, exports) {${i18nSource}\n})(module, module.exports)`, { module: i18nModule })
const answerActionLabels = ['en', 'ru'].map(lang => i18nModule.exports.t(lang, 'msg.actions'))

// Fresh profile and isolated build output each run: a reused persistent profile
// can restore a stale service worker from the code cache.
const profile = mkdtempSync(join(tmpdir(), 'study-buddy-verify-'))
const portProbe = createNetServer()
await new Promise((resolve, reject) => portProbe.listen(0, '127.0.0.1', resolve).once('error', reject))
const gatewayPort = portProbe.address().port
await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()))
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`
execFileSync('npm', ['run', 'build', '--', '--outDir', dist], {
  cwd: repo,
  env: { ...process.env, STUDY_BUDDY_GATEWAY_URL: gatewayUrl },
  stdio: 'inherit',
})

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}`)
  if (!ok) failures++
}

// A local page to capture (data: URLs are restricted; file:// needs a toggle).
const pageHtml = `<!doctype html><meta charset="utf-8"><title>target</title>
<style>body{margin:0;font:24px system-ui}.capture-proof{position:fixed;left:220px;top:230px;width:140px;height:90px;background:rgb(19,135,64)}</style>
<body><p style="padding:40px">homework text 12345</p><div class="capture-proof"></div><script>window.hostClickCount=0;document.addEventListener("click",()=>window.hostClickCount++)</script></body>`

// This isolated HTTP server serves the local capture page and acts as the
// injected fake OpenAI-compatible upstream for the real backend process.
// `failModel` makes the sole model answer 503, to exercise surfaced provider errors.
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
      if (responseMode === 'title') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const content of ['[[STUDY_BUDDY_', 'TITLE]]Geometry basics\nThe first ', 'selected answer']) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
        }
        res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":2,"cost":0.0001}}\n\ndata: [DONE]\n\n')
        return
      }
      if (responseMode === 'formatted') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunks = [
          '### Working\n\n**First',
          ' step**: use $$\\frac{',
          '1}{2}',
          '$$.\n\n`const total = ',
          '5` and snake_case.\n\n```js\nconst price = "$5";',
          '\n```\n\nSafe <img src=x onerror="window.__streamXss=1">',
          ' inline \\(a+b\\), display \\[\n',
          'x=\\frac{1}{2}\n',
          '\\] and existing $$y=x+1$$.',
        ]
        const send = () => {
          const content = chunks.shift()
          if (content !== undefined) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
          else {
            clearInterval(interval)
            res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
          }
        }
        const interval = setInterval(send, 700)
        send()
        res.on('close', () => clearInterval(interval))
        return
      }
      if (responseMode === 'clipboard') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'clipboard-real-proof' } }] }) + '\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":2,"cost":0.0001}}\n\ndata: [DONE]\n\n')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
      if (responseMode === 'slow') {
        const interval = setInterval(() => res.write('data: {"choices":[{"delta":{"content":" step"}}]}\n\n'), 180)
        const finish = setTimeout(() => { clearInterval(interval); res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":2}}\n\ndata: [DONE]\n\n') }, 10_000)
        res.on('close', () => { clearInterval(interval); clearTimeout(finish) })
        return
      }
      if (responseMode === 'long') {
        const answer = 'A longer worked explanation with enough detail to read at normal size. Each step follows from the captured question and keeps the reasoning visible instead of compressing the result.\n\nFor the quadratic formula,\n\n$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$\n\nThis display equation is rendered with KaTeX. The surrounding prose remains selectable and wraps within the answer column.'
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: answer } }] }) + '\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":2,"cost":0.0001}}\n\ndata: [DONE]\n\n')
        return
      }
      if (responseMode === 'truncated') { res.end('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":2}}\n\ndata: [DONE]\n\n'); return }
      if (responseMode === 'interrupted') { res.end(); return }
      if (responseMode === 'context-error') { res.end('data: {"error":{"code":400,"metadata":{"error_type":"context_length_exceeded"},"message":"private-provider-fixture"}}\n\n'); return }
      res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n')
      res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":2,"cost":0.0001}}\n\ndata: [DONE]\n\n')
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(pageHtml)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const url = `${origin}/`

let backend
let vite
let backendLogs = []
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
  vite = await createViteServer({ configFile: false, root: repo, appType: 'custom', server: { middlewareMode: true } })
  const [{ createBackend }, { loadBackendConfig }] = await Promise.all([
    vite.ssrLoadModule('/src/backend/app.ts'),
    vite.ssrLoadModule('/src/backend/config.ts'),
  ])
  const backendConfig = loadBackendConfig({
    OPENROUTER_API_KEY: 'FAKE_PROVIDER_KEY',
    SESSION_HMAC_SECRET: 'verify-fixture-session-secret-0123456789',
    HOST: '127.0.0.1',
    PORT: String(gatewayPort),
    DATABASE_PATH: join(profile, 'gateway.sqlite'),
    ALLOWED_ORIGINS: `chrome-extension://${extensionId}`,
  })
  let backendClock = Date.now()
  backend = createBackend(backendConfig, {
    providerBaseUrl: origin,
    now: () => { backendClock += 11_000; return backendClock },
    log: (entry) => backendLogs.push(entry),
  })
  await new Promise((resolve, reject) => backend.server.listen(gatewayPort, '127.0.0.1', (error) => error ? reject(error) : resolve()))
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

  // The backend owns provider credentials; the browser stores only language.
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), {
    uiLanguage: 'auto',
    answerLanguage: 'auto',
  })

  const page = await ctx.newPage()
  await page.goto(url)
  await page.bringToFront()
  await page.waitForTimeout(150)
  check(await page.locator('[data-study-buddy="launcher"]').count() === 0 && page.frames().length === 1, 'fresh page has no launcher or chat before the user opens and minimizes the panel')

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
  const liveFrameAllow = await (await liveFrame.frameElement()).evaluate(element => element.getAttribute('allow'))
  check(liveFrameAllow === 'clipboard-write', 'production overlay delegates clipboard-write to its cross-origin chat iframe')
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
  const settingsFixture = { uiLanguage: 'en', answerLanguage: 'auto' }
  await sw.evaluate((s) => chrome.storage.local.set({ settings: { ...s, apiKey: 'legacy-fixture-secret', baseUrl: 'https://provider.invalid/v1', provider: 'custom' } }), settingsFixture)
  const settings = await ctx.newPage()
  await settings.goto(`${chatOrigin}/src/chat/chat.html?kind=error&message=Settings%20fixture`)
  await settings.waitForSelector('#view-error:not([hidden])')
  await settings.click('#view-error:not([hidden]) [data-goto-settings]')
  await settings.waitForSelector('#view-settings:not([hidden])')
  const noConnectionDetails = await settings.evaluate(() => {
    const settingsMarkup = document.getElementById('view-settings').outerHTML.toLowerCase()
    const pageMarkup = document.documentElement.outerHTML
    return !/(api.?key|provider|base.?url|openrouter|deepseek|model|advanced)/.test(settingsMarkup) &&
      !pageMarkup.includes('legacy-fixture-secret') &&
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
    'Settings write failure stays visible and preserves the prior language settings',
  )
  await settings.evaluate(() => { chrome.storage.local.set = globalThis.fixtureStorageSet })
  const requestsBeforeLanguageSave = requestCount
  await settings.click('#set-save')
  await settings.waitForSelector('#view-settings[hidden]', { state: 'attached' })
  const savedSettings = (await sw.evaluate(async () => chrome.storage.local.get('settings'))).settings
  check(
    Object.keys(savedSettings).sort().join(',') === 'answerLanguage,uiLanguage' &&
      savedSettings.uiLanguage === 'ru' &&
      savedSettings.answerLanguage === 'fr' &&
      requestCount === requestsBeforeLanguageSave,
    'language Save removes legacy provider fields and sends no model request',
  )
  await settings.close()

  // AI answering now traverses the local gateway and fake HTTP upstream. The
  // reply must stream into the thread, and
  // the request must carry the crop as an image_url. The model is fixed by the
  // app's chain (settings.model no longer exists).
  const PRIMARY = 'anthropic/claude-haiku-5.5'
  // Pin uiLanguage 'en' so the prompt assertions below are deterministic
  // regardless of the test machine's browser locale (auto would follow it).
  await sw.evaluate(
    async (s) => chrome.storage.local.set({ settings: s }),
    { uiLanguage: 'en', answerLanguage: 'auto' },
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
  // Seed a real anonymous identity through the UI so recovery can prove continuity.
  const identitySeedPage = await openCapture()
  await identitySeedPage.click('.preset[data-preset="solve"]')
  await identitySeedPage.waitForFunction(() => {
    const body = [...document.querySelectorAll('.msg.assistant .msg-body')].at(-1)
    return body?.textContent?.trim() === 'Hello world'
  })
  const savedInstallation = await sw.evaluate(async () => (await chrome.storage.local.get('gateway.installation'))['gateway.installation'])
  check(!!savedInstallation?.installationId && typeof savedInstallation?.installationSecret === 'string',
    'first real chat request stores a durable anonymous installation credential')
  await identitySeedPage.close()

  // A malformed durable credential must fail closed and preserve its stored subject.
  const poisonedInstallationId = '223e4567-e89b-12d3-a456-426614174000'
  await sw.evaluate(() => chrome.storage.local.remove('gateway.session'))
  await sw.evaluate(({ origin, installationId }) => chrome.storage.local.set({
    'gateway.installation': {
      installationId,
      installationSecret: 'x'.repeat(43),
      gatewayOrigin: origin,
    },
  }), { origin: gatewayUrl, installationId: poisonedInstallationId })
  const invalidCredentialPage = await openCapture()
  const beforeInvalidCredential = requestCount
  const invalidCredentialLogStart = backendLogs.length
  await invalidCredentialPage.click('.preset[data-preset="solve"]')
  await invalidCredentialPage.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .reply-status')].some(node => node.textContent?.includes('The answer session expired.')))
  const invalidCredentialResult = await sw.evaluate(async ({ origin, expectedId }) => {
    const values = await chrome.storage.local.get(['gateway.session', 'gateway.installation'])
    return {
      sessionAbsent: !values['gateway.session'],
      installationPreserved: values['gateway.installation']?.installationId === expectedId &&
        values['gateway.installation']?.gatewayOrigin === origin,
    }
  }, { origin: gatewayUrl, expectedId: poisonedInstallationId })
  const invalidCredentialLogs = backendLogs.slice(invalidCredentialLogStart)
  const recoveryRejected = invalidCredentialLogs.some(entry => entry.status === 401 && entry.route === 'other')
  const didNotBootstrap = !invalidCredentialLogs.some(entry => entry.route === '/api/v1/session' && entry.status === 201)
  acceptanceEvidence.invalidInstallationCredential =
    invalidCredentialResult.sessionAbsent && invalidCredentialResult.installationPreserved &&
    recoveryRejected && didNotBootstrap && requestCount === beforeInvalidCredential
  check(acceptanceEvidence.invalidInstallationCredential,
    'invalid durable credential receives recovery 401, is not replaced or bootstrapped, preserves its subject and starts no provider request')
  await invalidCredentialPage.close()

  // A stale but locally unexpired bearer gets one explicit 401; the next user action recovers.
  await sw.evaluate(async (installation) => chrome.storage.local.set({
    'gateway.installation': installation,
    'gateway.session': {
      token: 'revoked-session-token-12345678901234567890',
      expiresAt: Date.now() + 60 * 24 * 60 * 60 * 1000,
      gatewayOrigin: installation.gatewayOrigin,
    },
  }), { ...savedInstallation, gatewayOrigin: gatewayUrl })
  const identityDatabase = new DatabaseSync(backendConfig.databasePath)
  identityDatabase.prepare('DELETE FROM sessions WHERE installation_id = ?').run(savedInstallation.installationId)
  identityDatabase.close()
  const recoveryPage = await openCapture()
  const beforeRejectedGeneration = requestCount
  const routeLogStart = backendLogs.length
  await recoveryPage.click('.preset[data-preset="solve"]')
  await recoveryPage.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .reply-status')].some(node => node.textContent?.includes('The answer session expired.')))
  const rejectedState = await sw.evaluate(async () => {
    const values = await chrome.storage.local.get(['gateway.session', 'gateway.installation'])
    return {
      sessionAbsent: !values['gateway.session'],
      installationId: values['gateway.installation']?.installationId,
    }
  }, { expectedId: savedInstallation.installationId })
  const rejectedRoute = backendLogs.slice(routeLogStart).reverse().find(entry => entry.route === '/api/v1/generations')
  const firstAttemptWas401 = rejectedRoute?.status === 401
  const noAutomaticReplay = requestCount === beforeRejectedGeneration
  await resetCooldown(recoveryPage)
  await recoveryPage.click('.preset[data-preset="solve"]')
  await recoveryPage.waitForFunction(() => {
    const body = [...document.querySelectorAll('.msg.assistant .msg-body')].at(-1)
    return body?.textContent?.trim() === 'Hello world'
  })
  const recoveredState = await sw.evaluate(async () => {
    const values = await chrome.storage.local.get(['gateway.session', 'gateway.installation'])
    return {
      sessionRestored: typeof values['gateway.session']?.token === 'string',
      installationId: values['gateway.installation']?.installationId,
    }
  })
  const recoveredRecord = new DatabaseSync(backendConfig.databasePath)
  const recoveredSubject = recoveredRecord.prepare('SELECT installation_id FROM sessions ORDER BY created_at DESC LIMIT 1').get()?.installation_id
  recoveredRecord.close()
  acceptanceEvidence.installationRecovery = {
    firstGeneration401: firstAttemptWas401,
    noAutomaticReplay,
    bearerCleared: rejectedState.sessionAbsent,
    subjectPreservedBeforeRecovery: rejectedState.installationId === savedInstallation.installationId,
    recoveredSameInstallation: recoveredState.sessionRestored &&
      recoveredState.installationId === savedInstallation.installationId &&
      recoveredSubject === savedInstallation.installationId,
    upstreamDeltaAfterExplicitRetry: requestCount - beforeRejectedGeneration,
  }
  check(acceptanceEvidence.installationRecovery.firstGeneration401 &&
    acceptanceEvidence.installationRecovery.noAutomaticReplay &&
    acceptanceEvidence.installationRecovery.bearerCleared &&
    acceptanceEvidence.installationRecovery.subjectPreservedBeforeRecovery &&
    acceptanceEvidence.installationRecovery.recoveredSameInstallation &&
    acceptanceEvidence.installationRecovery.upstreamDeltaAfterExplicitRetry === 1,
  '401 clears the expired bearer; the explicit next request recovers the same installation and makes exactly one provider call')
  await recoveryPage.close()

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
  const waitReply = (p, expected = 'Hello world') =>
    p
      .waitForFunction(
        (expected) => {
          // The bubble is rendered as Markdown, so marked's trailing newline is
          // expected — compare on the trimmed text.
          const body = [...document.querySelectorAll('.msg.assistant .msg-body')].at(-1)
          return body && body.textContent?.trim() === expected ? expected : false
        },
        expected,
        { timeout: 5000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null)
  const waitForNewReply = async (page, previousCount, expected) => {
    await page.waitForFunction((count) => document.querySelectorAll('.msg.assistant').length > count, previousCount, { timeout: 5000 })
    return waitReply(page, expected)
  }
  const clickMessageAction = async (page, index, label) => {
    const message = page.locator('.msg.assistant').nth(index)
    await message.hover()
    const toggle = message.locator('.msg-actions-toggle')
    if (await toggle.isVisible()) await toggle.click()
    await message.getByRole('button', { name: label, exact: true }).click()
  }

  const ai = await openCapture()
  responseMode = 'title'
  await ai.click('.preset[data-preset="solve"]')
  const reply = await waitReply(ai, 'The first selected answer').catch(async () => {
    console.log('  DIAG first reply:', JSON.stringify(await ai.evaluate(() => ({ statuses: [...document.querySelectorAll('.reply-status')].map(node => node.textContent), operationError: document.getElementById('operation-error')?.textContent, composerError: document.getElementById('composer-error')?.textContent }))))
    console.log('  DIAG provider/backend:', requestCount, JSON.stringify(backendLogs.slice(-12).map(({ route, status }) => ({ route, status }))))
    throw new Error('first reply did not arrive')
  })
  check(reply === 'The first selected answer', `assistant reply streams with the title envelope hidden (${reply ?? 'no reply'})`)
  responseMode = 'normal'
  await ai.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent?.includes('Complete'))
  const savedAi = await readSaved(ai)
  const savedConversation = savedAi.conversations.find(item => item.id === savedAi.state.lastConversationId)
  const savedTaskTurn = [...(savedConversation?.turns ?? [])].reverse().find(turn => turn.role === 'user')
  check(savedTaskTurn?.kind === 'solve' && savedTaskTurn.text === '' && !!savedTaskTurn.attachmentId,
    'Solve intent and its selected image remain persisted locally')
  check(savedConversation?.title === 'Geometry basics' && !!savedConversation.titleGeneratedAt && savedConversation.turns.at(-1)?.text === 'The first selected answer',
    'the title is persisted separately while the assistant transcript contains only the answer body')
  const savedUsage = savedConversation?.turns.at(-1)?.usage
  check(savedUsage?.model === PRIMARY && savedUsage.promptTokens === 17 && savedUsage.completionTokens === 2 && savedUsage.cost === 0.0001,
    'final usage-only provider chunk is retained on the saved assistant turn')
  await ai.reload()
  await ai.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent?.includes('Complete'))
  await ai.waitForTimeout(200)
  check(await ai.locator('#composer-error').isHidden(), 'idle context preview after a completed answer does not require a new user message')
  const userMessages = lastAiRequest?.messages?.filter((m) => m.role === 'user') ?? []
  const firstUser = [...userMessages].reverse().find((m) => typeof m.content === 'string' || Array.isArray(m.content) && m.content.some(part => part?.type === 'text'))
  const imageMessage = userMessages.find((m) => Array.isArray(m.content) && m.content.some(part => part?.type === 'image_url'))
  const sentImage =
    Array.isArray(imageMessage?.content) &&
    imageMessage.content.some((p) => p?.type === 'image_url' && typeof p.image_url?.url === 'string' && p.image_url.url.startsWith('data:image/'))
  check(sentImage, 'request carried the crop as an image_url data URL')
  check(lastAiRequest?.model === PRIMARY, `request used the fixed primary model (${lastAiRequest?.model ?? 'MISSING'})`)
  check(
    lastAiRequest?.messages?.[0]?.role === 'system' &&
      lastAiRequest.messages[0].content.includes('[[STUDY_BUDDY_TITLE]]') &&
      lastAiRequest.messages[0].content.includes('Use the supplied text, images, and relevant conversation history as the source of task-specific facts'),
    'first response uses the approved common and title instructions in the system message',
  )
  check(
    typeof firstUser?.content === 'string' ? firstUser.content.includes('Solve the problem shown in the image') :
      firstUser?.content?.some(part => part.type === 'text' && part.text.includes('Solve the problem shown in the image')),
    'Solve instruction is added to the canonical user message while retaining the image',
  )
  check(
    Array.isArray(imageMessage?.content) && imageMessage.content.some(part => part.type === 'image_url') &&
      firstUser?.content && (typeof firstUser.content === 'string'
        ? firstUser.content.includes('Solve the problem shown in the image')
        : firstUser.content.some(part => part.type === 'text' && part.text.includes('Solve the problem shown in the image'))),
    'canonical Solve text and captured image are both present in the request history',
  )
  check(
    lastAiRequest?.max_tokens === 8_192 && !('temperature' in lastAiRequest) && JSON.stringify(lastAiRequest.reasoning) === JSON.stringify({ effort: 'medium', exclude: true }),
    `Haiku request carries max_tokens=8192 and medium excluded reasoning (${JSON.stringify(lastAiRequest && { max_tokens: lastAiRequest.max_tokens, temperature: lastAiRequest.temperature, reasoning: lastAiRequest.reasoning })})`,
  )
  let previousAssistantCount = await ai.locator('.msg.assistant').count()
  await clickMessageAction(ai, 0, 'Explain simpler')
  const firstSimplerReply = await waitForNewReply(ai, previousAssistantCount)
  const firstSimplerPrompt = lastAiRequest.messages.at(-1).content
  check(firstSimplerReply === 'Hello world' && JSON.stringify(firstSimplerPrompt).includes('The first selected answer') &&
    !JSON.stringify(lastAiRequest.messages).includes('[[STUDY_BUDDY_TITLE]]'),
    'Simpler targets the clicked answer and later requests omit the first-reply title instruction')
  await resetCooldown(ai)
  previousAssistantCount = await ai.locator('.msg.assistant').count()
  await ai.fill('#ask-input', 'A later independent question')
  await ai.click('#ask-btn')
  await waitForNewReply(ai, previousAssistantCount)
  await ai.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent?.includes('Complete'))
  await resetCooldown(ai)
  previousAssistantCount = await ai.locator('.msg.assistant').count()
  await clickMessageAction(ai, 0, 'Explain simpler')
  await waitForNewReply(ai, previousAssistantCount)
  const olderSimplerPrompt = lastAiRequest.messages.at(-1).content
  const simplerDb = await readSaved(ai)
  const simplerConversation = simplerDb.conversations.find(item => item.id === simplerDb.state.lastConversationId)
  const olderSimplerTurn = [...(simplerConversation?.turns ?? [])].reverse().find(turn => turn.role === 'user' && turn.kind === 'simpler')
  check(JSON.stringify(olderSimplerPrompt).includes('The first selected answer') &&
    olderSimplerTurn?.input === 'The first selected answer' && olderSimplerTurn.attachmentId === capture.id,
    'Simpler uses an older clicked reply even after later answers and stores that target for reuse (' + JSON.stringify({ prompt: olderSimplerPrompt, input: olderSimplerTurn?.input, attachmentId: olderSimplerTurn?.attachmentId, captureId: capture.id }) + ')')
  await resetCooldown(ai)
  previousAssistantCount = await ai.locator('.msg.assistant').count()
  await clickMessageAction(ai, previousAssistantCount - 1, 'Retry')
  await waitForNewReply(ai, previousAssistantCount)
  check(JSON.stringify(lastAiRequest.messages.at(-1).content).includes('The first selected answer'),
    'Retry preserves the selected Simpler target instead of choosing the latest answer')
  await ai.close()

  const oversized = await openCapture()
  const oversizedConversationId = new URL(oversized.url()).searchParams.get('conversation')
  const originalPng = await oversized.evaluate((conversationId) => new Promise((resolve, reject) => {
    const open = indexedDB.open('study-buddy-conversations', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const request = db.transaction(['conversations', 'attachments'], 'readonly').objectStore('conversations').get(conversationId)
      request.onerror = () => reject(request.error)
      request.onsuccess = async () => {
        const attachment = await new Promise((done, fail) => {
          const get = db.transaction('attachments', 'readonly').objectStore('attachments').get(request.result.activeAttachmentId)
          get.onsuccess = () => done(get.result)
          get.onerror = () => fail(get.error)
        })
        resolve(Array.from(new Uint8Array(await attachment.data.arrayBuffer())))
        db.close()
      }
    }
  }), oversizedConversationId)
  await oversized.evaluate(({ conversationId, pngBytes }) => new Promise((resolve, reject) => {
    const open = indexedDB.open('study-buddy-conversations', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['conversations', 'attachments'], 'readwrite')
      const conversations = tx.objectStore('conversations')
      const request = conversations.get(conversationId)
      let reusableId
      let reusableTaskId
      request.onsuccess = () => {
        const conversation = request.result
        const original = Uint8Array.from(pngBytes)
        const chunk = new Uint8Array(4 * 1024 * 1024 - original.length)
        const chunkDataLength = chunk.length - 12
        const view = new DataView(chunk.buffer)
        view.setUint32(0, chunkDataLength)
        chunk.set([118, 112, 65, 103], 4) // Ancillary vpAg chunk, ignored by PNG decoders.
        for (let i = 0; i < chunkDataLength; i++) chunk[8 + i] = i & 255
        const table = new Uint32Array(256)
        for (let n = 0; n < 256; n++) {
          let value = n
          for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
          table[n] = value >>> 0
        }
        let crc = 0xffffffff
        for (let i = 4; i < chunk.length - 4; i++) crc = table[(crc ^ chunk[i]) & 255] ^ (crc >>> 8)
        new DataView(chunk.buffer).setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0)
        const payload = new Blob([original.slice(0, -12), chunk, original.slice(-12)], { type: 'image/png' })
        const ids = Array.from({ length: 7 }, () => crypto.randomUUID())
        for (const [index, id] of ids.entries()) {
          const createdAt = Date.now() + index
          tx.objectStore('attachments').put({ id, data: payload, createdAt })
          conversation.turns.push({ id: crypto.randomUUID(), role: 'user', text: '', kind: 'capture', attachmentId: id, createdAt, locale: 'en', promptVersion: 'capture' })
        }
        conversation.activeAttachmentId = ids.at(-1)
        conversations.put(conversation)
      }
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  }), { conversationId: oversizedConversationId, pngBytes: originalPng })
  await oversized.reload()
  await oversized.waitForFunction(() => document.querySelectorAll('.turn-image').length === 8)
  const largeDraft = 'Keep this draft when the encoded image payload is too large'
  const beforeOversizedPayload = requestCount
  await oversized.fill('#ask-input', largeDraft)
  await oversized.click('#ask-btn')
  await oversized.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent.includes('Complete'), { timeout: 15_000 })
  const oversizedSaved = await readSaved(oversized)
  const oversizedConversation = oversizedSaved.conversations.find(item => item.id === oversizedConversationId)
  const oversizedRequestBytes = lastAiRequest ? Buffer.byteLength(JSON.stringify(lastAiRequest)) : Infinity
  const oversizedIncludedImages = lastAiRequest?.messages?.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url').length ?? 0
  check(await oversized.locator('#ask-input').inputValue() === '' &&
    oversizedConversation.turns.some(turn => turn.role === 'user' && turn.input === largeDraft) &&
    requestCount === beforeOversizedPayload + 1 && oversizedRequestBytes <= 32 * 1024 * 1024 && oversizedIncludedImages >= 2 && oversizedIncludedImages < 8,
  '32-MiB transport projection trims older images while sending the current image and draft')
  await oversized.close()

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
    const bodyElement = message.querySelector('.msg-body')
    const body = bodyElement.getBoundingClientRect()
    const content = [...bodyElement.children].filter(child => !child.classList.contains('msg-actions')).at(-1)?.getBoundingClientRect()
    const tray = message.querySelector('.msg-actions').getBoundingClientRect()
    const buttons = [...message.querySelectorAll('.msg-actions .msg-action-items button')].map(button => {
      const r = button.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, radius: getComputedStyle(button).borderRadius }
    })
    const container = message.querySelector('.msg-actions')
    return {
      contentBottom: content?.bottom,
      bodyTop: body.top,
      bodyBottom: body.bottom,
      trayTop: tray.top,
      trayBottom: tray.bottom,
      trayMidpoint: (tray.top + tray.bottom) / 2,
      trayHeight: tray.height,
      messageBottom: message.getBoundingClientRect().bottom,
      trayRadius: getComputedStyle(container).borderRadius,
      buttons,
    }
  })
  check(longActionGeometry.contentBottom !== undefined &&
    longActionGeometry.trayTop - longActionGeometry.contentBottom >= 8 &&
    Math.abs(longActionGeometry.trayMidpoint - longActionGeometry.bodyBottom) <= 2 &&
    longActionGeometry.trayBottom > longActionGeometry.bodyBottom &&
    longActionGeometry.trayHeight < 40 &&
    longActionGeometry.buttons.length >= 2 &&
    longActionGeometry.buttons.every(button => button.width < 36 && button.height < 36 &&
      button.radius === longActionGeometry.trayRadius && button.left >= 0 && button.right <= 480),
    'long answer keeps text clear of a compact tray centered on the bubble edge (' + JSON.stringify(longActionGeometry) + ')')
  const longEvidence = resolve(root, '..', 'review', 'loop')
  mkdirSync(longEvidence, { recursive: true })
  await longAnswer.screenshot({ path: join(longEvidence, 'long-answer.png'), fullPage: true })

  responseMode = 'normal'
  await resetCooldown(longAnswer)
  await longAnswer.reload()
  await longAnswer.waitForFunction(() => {
    const image = document.querySelector('.turn-image')
    return !!image?.src && image.naturalWidth > 0 &&
      [...document.querySelectorAll('.reply-status')].at(-1)?.textContent?.includes('Complete')
  })
  await longAnswer.fill('#ask-input', 'Continue with the next step.')
  await longAnswer.click('#ask-btn')
  try {
    await longAnswer.waitForFunction(() => {
      const assistants = [...document.querySelectorAll('.msg.assistant')]
      return assistants.length === 2 && assistants.at(-1)?.querySelector('.reply-status')?.textContent?.includes('Complete')
    }, { timeout: 10_000 })
  } catch (error) {
    console.log('  DIAG follow-up:', JSON.stringify(await longAnswer.evaluate(() => ({
      assistants: [...document.querySelectorAll('.msg.assistant')].map(message => ({ body: message.querySelector('.msg-body')?.textContent, status: message.querySelector('.reply-status')?.textContent })),
      operationError: document.getElementById('operation-error')?.textContent,
      composerError: document.getElementById('composer-error')?.textContent,
      input: document.getElementById('ask-input')?.value,
    }))))
    console.log('  DIAG backend route statuses:', JSON.stringify(backendLogs.slice(-8).map(({ route, status }) => ({ route, status }))))
    throw error
  }
  const traySpacing = await longAnswer.evaluate(() => {
    const thread = document.querySelector('#thread')
    const messages = [...thread.querySelectorAll('.msg')]
    const message = messages.find(node => node.classList.contains('assistant'))
    const tray = message?.querySelector('.msg-actions')?.getBoundingClientRect()
    const next = message ? messages[messages.indexOf(message) + 1]?.getBoundingClientRect() : undefined
    return { trayBottom: tray?.bottom, nextMessageTop: next?.top, gap: tray && next ? next.top - tray.bottom : null }
  })
  check(traySpacing.gap !== null && traySpacing.gap >= 8,
    'next message clears the tray that extends beyond its bubble (' + JSON.stringify(traySpacing) + ')')
  await longAnswer.close()

  // Task response language follows navigator.language independently of UI chrome.
  await sw.evaluate(
    async (s) => chrome.storage.local.set({ settings: s }),
    { uiLanguage: 'ru', answerLanguage: 'auto' },
  )
  const aiRu = await openCapture()
  await aiRu.click('.preset[data-preset="solve"]')
  await waitReply(aiRu)
  check(
    lastAiRequest?.messages?.[0]?.role === 'system' &&
      lastAiRequest.messages[0].content.includes('Respond in ') &&
      JSON.stringify(lastAiRequest.messages).includes('Solve the problem shown in the image'),
    'task prompt is present and answer language follows the browser independently of Russian UI chrome',
  )
  await aiRu.close()
  // Back to EN for the unavailable-model test below.
  await sw.evaluate(
    async (s) => chrome.storage.local.set({ settings: s }),
    { uiLanguage: 'en', answerLanguage: 'auto' },
  )

  // Exercise both installation and service-wide denials in the real chat UI.
  const budgetDatabase = new DatabaseSync(backendConfig.databasePath)
  const budgetMonth = new Date().toISOString().slice(0, 7)
  const budgetInstallationId = budgetDatabase.prepare(
    'SELECT installation_id FROM sessions WHERE installation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
  ).get()?.installation_id
  if (!budgetInstallationId) throw new Error('The UI fixture has no installation wallet')
  const globalFixtureIds = Array.from({ length: 20 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
  const walletSnapshot = (installationId) => budgetDatabase.prepare(
    'SELECT spent_nano, reserved_nano FROM monthly_budgets WHERE installation_id = ? AND month_key = ?',
  ).get(installationId, budgetMonth)
  const restoreWallet = (installationId, prior) => {
    if (prior) {
      budgetDatabase.prepare('UPDATE monthly_budgets SET spent_nano = ?, reserved_nano = ? WHERE installation_id = ? AND month_key = ?')
        .run(prior.spent_nano, prior.reserved_nano, installationId, budgetMonth)
    } else {
      budgetDatabase.prepare('DELETE FROM monthly_budgets WHERE installation_id = ? AND month_key = ?')
        .run(installationId, budgetMonth)
    }
  }
  const priorBudgetWallet = walletSnapshot(budgetInstallationId)
  const priorGlobalWallets = new Map(globalFixtureIds.map(id => [id, walletSnapshot(id)]))
  let budgetPage
  try {
    budgetDatabase.prepare(
      'INSERT INTO monthly_budgets (installation_id, month_key, spent_nano, reserved_nano) VALUES (?, ?, 4_725_000_001, 0) ' +
      'ON CONFLICT(installation_id, month_key) DO UPDATE SET spent_nano = excluded.spent_nano, reserved_nano = 0',
    ).run(budgetInstallationId, budgetMonth)
    budgetPage = await openCapture()
    const beforeBudgetDenied = requestCount
    await budgetPage.click('.preset[data-preset="solve"]')
    await budgetPage.waitForFunction(() => {
      const status = [...document.querySelectorAll('.msg.assistant .reply-status')].at(-1)?.textContent ?? ''
      return status.includes('monthly limit') && status.includes('resets')
    })
    mkdirSync(reviewEvidence, { recursive: true })
    const budgetStatus = await budgetPage.locator('.msg.assistant .reply-status').last().textContent()
    await budgetPage.screenshot({ path: join(reviewEvidence, 'budget-limit.png'), animations: 'disabled' })
    acceptanceEvidence.budgetLimit = {
      resetDateVisible: !!budgetStatus?.includes('resets'),
      error: budgetStatus,
      upstreamDelta: requestCount - beforeBudgetDenied,
      screenshot: 'review/loop/budget-limit.png',
    }
    check(acceptanceEvidence.budgetLimit.resetDateVisible && acceptanceEvidence.budgetLimit.upstreamDelta === 0,
      'monthly budget error shows its reset date in chat without an upstream generation')
    await budgetPage.close()
    budgetPage = undefined
    restoreWallet(budgetInstallationId, priorBudgetWallet)

    for (const id of globalFixtureIds) {
      budgetDatabase.prepare(
        'INSERT INTO monthly_budgets (installation_id, month_key, spent_nano, reserved_nano) VALUES (?, ?, 5_000_000_000, 0) ' +
        'ON CONFLICT(installation_id, month_key) DO UPDATE SET spent_nano = excluded.spent_nano, reserved_nano = 0',
      ).run(id, budgetMonth)
    }
    budgetPage = await openCapture()
    const beforeServiceBudgetDenied = requestCount
    await budgetPage.click('.preset[data-preset="solve"]')
    await budgetPage.waitForFunction(() => {
      const status = [...document.querySelectorAll('.msg.assistant .reply-status')].at(-1)?.textContent ?? ''
      return status.includes('service-wide monthly usage limit') && status.includes('resets')
    })
    const serviceBudgetStatus = await budgetPage.locator('.msg.assistant .reply-status').last().textContent()
    await budgetPage.screenshot({ path: join(reviewEvidence, 'service-budget-limit.png'), animations: 'disabled' })
    acceptanceEvidence.serviceBudgetLimit = {
      resetDateVisible: !!serviceBudgetStatus?.includes('resets'),
      error: serviceBudgetStatus,
      upstreamDelta: requestCount - beforeServiceBudgetDenied,
      screenshot: 'review/loop/service-budget-limit.png',
    }
    check(acceptanceEvidence.serviceBudgetLimit.resetDateVisible && acceptanceEvidence.serviceBudgetLimit.upstreamDelta === 0,
      'service-wide budget error shows its reset date in chat without an upstream generation')
    await budgetPage.close()
    budgetPage = undefined
  } finally {
    if (budgetPage) await budgetPage.close()
    restoreWallet(budgetInstallationId, priorBudgetWallet)
    for (const id of globalFixtureIds) restoreWallet(id, priorGlobalWallets.get(id))
    budgetDatabase.close()
  }

  // The unavailable primary must surface its error after exactly one attempt.
  failModel = PRIMARY
  const unavailable = await openCapture()
  const beforeUnavailable = requestCount
  await unavailable.click('.preset[data-preset="solve"]')
  await unavailable.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .reply-status')].some(node => node.textContent?.includes('may have reached the answer service')))
  check(lastAiRequest?.model === PRIMARY && requestCount === beforeUnavailable + 1,
    'unavailable Haiku surfaces the provider error after one request with no model switch')
  check(!(await unavailable.evaluate(() => !!document.querySelector('.msg.note'))),
    'no fallback notice is shown when Haiku is unavailable')
  await unavailable.close()

  failModel = null
  const evidence = resolve(root, '..', 'review', 'loop')
  mkdirSync(evidence, { recursive: true })
  const waitSaved = (p, status = 'complete') => p.waitForFunction((expected) => {
    const nodes = [...document.querySelectorAll('.reply-status')]
    return nodes.at(-1)?.textContent?.includes(expected)
  }, status, { timeout: 7000 })

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
  const requestsBeforeTools = requestCount
  const toolGeometry = await layout.locator('#presets .preset').evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect()
    return { label: button.textContent, icon: !!button.querySelector('svg'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }))
  check(toolGeometry.length === 6 && toolGeometry.every(button => button.icon && button.label && button.width >= 44 && button.height >= 44) &&
    new Set(toolGeometry.map(button => button.y)).size === 1 && await layout.locator('#more-btn').count() === 0,
    'all six labeled icon actions are visible in one compact row at 480px (' + JSON.stringify(toolGeometry) + ')')
  await layout.waitForFunction(() => !document.querySelector('[data-preset="explain"]').disabled)
  await layout.locator('[data-preset="explain"]').focus()
  await layout.waitForSelector('#task-tooltip:popover-open')
  const tooltipGeometry = await layout.locator('#task-tooltip').boundingBox()
  check((await layout.locator('#task-tooltip').textContent()).includes('concepts') &&
    await layout.locator('[data-preset="explain"]').getAttribute('aria-describedby') === 'task-tooltip' &&
    tooltipGeometry.x >= 0 && tooltipGeometry.x + tooltipGeometry.width <= 480 && requestCount === requestsBeforeTools,
    'keyboard focus reveals a bounded descriptive tooltip without making a request')
  await layout.keyboard.press('Tab')
  check(await layout.locator('[data-preset="translate"]').evaluate(button => button === document.activeElement) &&
    (await layout.locator('#task-tooltip').textContent()).includes('answer language'),
    'Tab visits the next visible action and updates its accessible description')
  await layout.keyboard.press('Escape')
  await layout.waitForSelector('#task-tooltip:popover-open', { state: 'hidden' })
  await layout.locator('[data-preset="hint"]').hover()
  await layout.waitForSelector('#task-tooltip:popover-open')
  await layout.screenshot({ path: join(evidence, 'tools.png') })
  await layout.click('#thread')
  await layout.waitForSelector('#task-tooltip:popover-open', { state: 'hidden' })
  check(requestCount === requestsBeforeTools, 'hover tooltips dismiss when leaving the action and never send a request')
  await layout.setViewportSize({ width: 320, height: 324 })
  const narrowGeometry = await layout.evaluate(() => {
    const selection = document.querySelector('#new-selection-btn')
    const composer = document.querySelector('#composer').getBoundingClientRect()
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height } }
    const actions = [...document.querySelectorAll('#presets .preset')].map(button => { const r = button.getBoundingClientRect(); return { y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } })
    return { width: document.documentElement.scrollWidth, actions, selection: { ...rect('#new-selection-btn'), label: selection.getAttribute('aria-label'), title: selection.title }, hasContextUi: !!document.querySelector('#context-summary, #context-details-btn, #context-dialog'), layout: { header: rect('#capture-top'), presets: rect('#presets'), thread: rect('#thread'), composer: { top: composer.top, bottom: composer.bottom, inputBottom: rect('#ask-input').bottom, sendBottom: rect('#ask-btn').bottom } } }
  })
  check(narrowGeometry.width <= 320 && new Set(narrowGeometry.actions.map(button => button.y)).size === 2 &&
    narrowGeometry.actions.every(button => button.right <= 320 && button.bottom <= narrowGeometry.layout.composer.top && button.width >= 44 && button.height >= 44) &&
    narrowGeometry.selection.height === 44 && !!narrowGeometry.selection.label && narrowGeometry.layout.thread.height >= 60 &&
    narrowGeometry.layout.composer.bottom <= 324 && narrowGeometry.layout.composer.inputBottom <= 324 && narrowGeometry.layout.composer.sendBottom <= 324,
    '320×324 shows all six actions in two rows and keeps the thread and composer accessible (' + JSON.stringify(narrowGeometry) + ')')
  const requestsBeforeExplain = requestCount
  await layout.getByRole('button', { name: 'Explain', exact: true }).click()
  await waitSaved(layout, 'Complete')
  const explainSaved = await readSaved(layout)
  const explainConversation = explainSaved.conversations.find(item => item.id === explainSaved.state.lastConversationId)
  const explainTurn = [...(explainConversation?.turns ?? [])].reverse().find(turn => turn.role === 'user')
  const explainHasImage = lastAiRequest?.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
  const explainHasTextInstruction = lastAiRequest?.messages?.some(message => message.role === 'system' ||
    typeof message.content === 'string' && message.content.length > 0 ||
    Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text.length > 0))
  check(requestCount === requestsBeforeExplain + 1 && explainTurn?.kind === 'explain' &&
    explainTurn.text === '' && !!explainTurn.attachmentId && explainHasImage &&
    explainHasTextInstruction,
    'Visible Explain sends the approved task instruction with its image and persists kind=explain')
  const seedExtraImages = () => layout.evaluate(() => new Promise((resolve, reject) => {
    const conversationId = new URL(location.href).searchParams.get('conversation')
    const open = indexedDB.open('study-buddy-conversations', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['conversations', 'attachments'], 'readwrite')
      const conversations = tx.objectStore('conversations')
      const request = conversations.get(conversationId)
      let reusableId
      let reusableTaskId
      request.onsuccess = () => {
        const conversation = request.result
        const oldAttachmentId = conversation.activeAttachmentId
        const sourceImageRequest = tx.objectStore('attachments').get(oldAttachmentId)
        sourceImageRequest.onsuccess = () => {
          const sourceImage = sourceImageRequest.result
          if (!sourceImage?.data) { reject(new Error('The captured PNG fixture is missing')); return }
          const ids = [crypto.randomUUID(), crypto.randomUUID()]
          reusableId = ids[0]
          const largeText = 'word  '.repeat(130000)
          reusableTaskId = crypto.randomUUID()
          conversation.turns.push({ id: reusableTaskId, role: 'user', text: 'Earlier task', display: 'Earlier task', input: 'Earlier task', kind: 'ask', attachmentId: oldAttachmentId, createdAt: Date.now(), locale: 'en', promptVersion: 'fixture' })
          for (const [index, id] of ids.entries()) {
            const createdAt = Date.now() + index * 2
            tx.objectStore('attachments').put({ id, data: sourceImage.data, createdAt })
            conversation.turns.push({ id, role: 'user', text: '', kind: 'capture', attachmentId: id, createdAt, locale: 'en', promptVersion: 'capture' })
            if (index === 0) {
              conversation.turns.push({ id: crypto.randomUUID(), role: 'user', text: largeText, display: 'Longer follow-up outside the current context', input: largeText, kind: 'ask', attachmentId: id, createdAt: createdAt + 1, locale: 'en', promptVersion: 'fixture' })
            }
          }
          conversation.activeAttachmentId = ids.at(-1)
          conversation.turns.push({ id: crypto.randomUUID(), role: 'user', text: 'Review the newest selection', display: 'Review the newest selection', input: 'Review the newest selection', kind: 'ask', attachmentId: ids.at(-1), createdAt: Date.now() + 3, locale: 'en', promptVersion: 'fixture' })
          conversations.put(conversation)
        }
      }
      tx.oncomplete = () => { db.close(); resolve({ imageId: reusableId, taskId: reusableTaskId }) }
      tx.onerror = () => reject(tx.error)
    }
  }))
  const { taskId: reusableTaskId } = await seedExtraImages()
  await layout.reload()
  await layout.waitForFunction(() => document.querySelectorAll('.turn-image').length === 3)
  await layout.waitForFunction(() => !!document.querySelector('.msg.context-excluded .context-reuse'))
  const excludedMessages = await layout.evaluate(() => {
    const excluded = [...document.querySelectorAll('.msg.context-excluded')]
    const first = excluded.find(message => message.querySelector('.context-reuse'))
    const reuse = first?.querySelector('.context-reuse')
    const body = first?.querySelector('.msg-body')
    const includedBody = document.querySelector('.msg.user:not(.context-excluded) .msg-body')
    const image = first?.querySelector('.turn-image')
    return {
      count: excluded.length,
      marked: !!first,
      mutedBody: !!body && getComputedStyle(body).backgroundColor !== getComputedStyle(includedBody).backgroundColor,
      mutedImage: !image || getComputedStyle(image).opacity === '0.68',
      includedImage: !!document.querySelector('.msg.user:not(.context-excluded) .turn-image'),
      noteCount: document.querySelectorAll('.context-boundary').length,
      boundaryText: document.querySelector('.context-boundary')?.textContent,
      boundaryRect: document.querySelector('.context-boundary')?.getBoundingClientRect().toJSON(),
      reuseLabel: reuse?.getAttribute('aria-label'),
      reuseTitle: reuse?.title,
      reuseHasOnlyIcon: !!reuse?.querySelector('svg') && !reuse.textContent.trim(),
      reuseSize: reuse ? [reuse.getBoundingClientRect().width, reuse.getBoundingClientRect().height] : [],
    }
  })
  const reuseLabel = i18nModule.exports.t('en', 'context.reuseTitle')
  check(excludedMessages.count > 0 && excludedMessages.marked && excludedMessages.mutedBody && excludedMessages.mutedImage && excludedMessages.includedImage && excludedMessages.noteCount === 1 && excludedMessages.boundaryText === i18nModule.exports.t('en', 'context.boundaryWithImage') &&
    excludedMessages.boundaryRect.width > 0 && excludedMessages.reuseLabel === reuseLabel && excludedMessages.reuseTitle === reuseLabel && excludedMessages.reuseHasOnlyIcon && excludedMessages.reuseSize[0] === 44 && excludedMessages.reuseSize[1] === 44,
  'excluded task text is muted, its separately retained capture stays visible, and reuse remains accessible (' + JSON.stringify(excludedMessages) + ')')
  const reuseRequestCount = requestCount
  await resetCooldown(layout)
  await layout.reload()
  await layout.waitForFunction(() => document.querySelectorAll('.msg.context-excluded .context-reuse').length > 0)
  const reuseButton = layout.locator(`.msg.context-excluded[data-turn="${reusableTaskId}"] .context-reuse`)
  await reuseButton.waitFor({ state: 'attached' })
  check(await reuseButton.count() === 1, 'the excluded task has one reuse action')
  await reuseButton.click()
  const reuseDeadline = Date.now() + 5000
  while (requestCount === reuseRequestCount && Date.now() < reuseDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const reusedImageCount = lastAiRequest?.messages?.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url').length ?? 0
  const reuseUiState = await layout.evaluate(() => ({ composerError: document.getElementById('composer-error')?.textContent, operationError: document.getElementById('operation-error')?.textContent, input: document.getElementById('ask-input')?.value, lastStatus: [...document.querySelectorAll('.reply-status')].at(-1)?.textContent }))
  const reusedImageSent = requestCount === reuseRequestCount + 1 && reusedImageCount > 0
  if (requestCount === reuseRequestCount + 1) await waitSaved(layout, 'Complete')
  check(reusedImageSent, `reusing an excluded image sends it in the next request (calls=${requestCount - reuseRequestCount}, images=${reusedImageCount}, state=${JSON.stringify(reuseUiState)})`)
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
  const mobileToggle = mobileActionMenu.locator('.msg-actions-toggle')
  const mobileToggleVisible = await mobileToggle.count() > 0 && await mobileToggle.isVisible().catch(() => false)
  const mobileActionState = await layout.evaluate(() => ({
    assistants: [...document.querySelectorAll('.msg.assistant')].map(message => ({ status: message.querySelector('.reply-status')?.textContent, actions: [...message.querySelectorAll('.msg-actions button')].map(button => button.className) })),
  }))
  check(mobileToggleVisible && await mobileToggle.evaluate(button => button.getBoundingClientRect().width >= 44 && button.getBoundingClientRect().height >= 44), `narrow no-hover layout keeps a persistent 44px answer-action menu trigger (${JSON.stringify(mobileActionState)})`)
  if (mobileToggleVisible) {
    await mobileToggle.click()
    check(await mobileToggle.getAttribute('aria-expanded') === 'true' &&
      await mobileActionMenu.locator('.msg-action-items').isVisible() &&
      await mobileActionMenu.locator('.msg-action-items button[aria-label="Copy"]').isVisible() &&
      await mobileActionMenu.locator('.msg-action-items button[aria-label="Explain simpler"]').isVisible(),
      'touch ellipsis opens visible Copy and Simpler actions')
    await mobileToggle.press('Escape')
    check(await mobileToggle.getAttribute('aria-expanded') === 'false', 'Escape closes the touch action menu')
  }
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings')
    await chrome.storage.local.set({ settings: { ...settings, uiLanguage: 'ru' } })
  })
  await layout.reload()
  await layout.waitForFunction(() => document.querySelectorAll('.turn-image').length === 3)
  await layout.fill('#ask-input', 'Compare the saved images')
  await layout.setViewportSize({ width: 320, height: 568 })
  await layout.evaluate(() => {
    const thread = document.querySelector('#thread')
    const boundary = document.querySelector('.context-boundary')
    if (thread && boundary) thread.scrollTop = Math.max(0, boundary.offsetTop - thread.offsetTop - 60)
  })
  await layout.screenshot({ path: '/tmp/study-buddy-haiku-20261021/context-boundary-ru-320.png' })
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
  check(lastAiRequest.max_tokens === 8_192 && !('temperature' in lastAiRequest), 'Hint UI uses the shared Haiku cap and omits temperature')
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
    'Copy reports success with a short accessible toast (' + JSON.stringify(copyFeedback) + ')')
  await hint.waitForSelector('.msg-copy-feedback', { state: 'detached', timeout: 2500 })

  const clipboardBootstrap = await ctx.newPage()
  await clipboardBootstrap.goto(`${chatOrigin}/src/chat/chat.html?kind=error&message=Fixture`)
  const clipboardConversation = await clipboardBootstrap.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({ type: 'CONVERSATION', action: 'create', title: 'Clipboard iframe verification' })
    if (!result.ok) throw new Error(result.error)
    return result.value.id
  })
  await clipboardBootstrap.close()
  const clipboardHost = await ctx.newPage()
  await clipboardHost.setViewportSize({ width: 480, height: 564 })
  await clipboardHost.goto(origin)
  const clipboardFrameNavigation = clipboardHost.waitForEvent('framenavigated', frame => frame.url().startsWith(chatOrigin))
  await clipboardHost.evaluate(src => {
    const frame = document.createElement('iframe')
    frame.title = 'Study Buddy conversation'
    frame.allow = 'clipboard-write'
    frame.src = src
    frame.style.cssText = 'width:480px;height:564px;border:0'
    document.body.appendChild(frame)
  }, `${chatOrigin}/src/chat/chat.html?kind=conversation&conversation=${clipboardConversation}`)
  await clipboardFrameNavigation
  const clipboardFrame = clipboardHost.frames().find(frame => frame.url().startsWith(chatOrigin))
  if (!clipboardFrame) throw new Error('Clipboard test extension iframe did not load')
  await clipboardFrame.waitForSelector('#ask-input')
  const clipboardFramePolicy = await clipboardHost.locator('iframe').getAttribute('allow')
  const clipboardPolicyAllowed = await clipboardFrame.evaluate(() => {
    const policy = document.permissionsPolicy ?? document.featurePolicy
    return typeof policy?.allowsFeature === 'function' ? policy.allowsFeature('clipboard-write') : null
  })
  const policyProbeNavigation = clipboardHost.waitForEvent('framenavigated', frame => frame.url().includes('message=ClipboardPolicyProbe'))
  await clipboardHost.evaluate(src => {
    const frame = document.createElement('iframe')
    frame.name = 'clipboard-policy-probe'
    frame.src = src
    document.body.appendChild(frame)
  }, `${chatOrigin}/src/chat/chat.html?kind=error&message=ClipboardPolicyProbe`)
  await policyProbeNavigation
  const policyProbe = clipboardHost.frames().find(frame => frame.url().includes('message=ClipboardPolicyProbe'))
  const policyWithoutAllow = await policyProbe.evaluate(() => {
    const policy = document.permissionsPolicy ?? document.featurePolicy
    return typeof policy?.allowsFeature === 'function' ? policy.allowsFeature('clipboard-write') : null
  })
  await policyProbe.evaluate(() => {
    const button = document.createElement('button')
    button.id = 'clipboard-policy-write-probe'
    button.textContent = 'Probe clipboard policy'
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText('must-be-blocked-by-frame-policy')
        button.dataset.result = 'resolved'
      } catch (error) {
        button.dataset.result = `rejected:${error.name}:${error.message}`
      }
    }
    document.body.append(button)
  })
  await policyProbe.locator('#clipboard-policy-write-probe').click()
  await policyProbe.waitForFunction(() => Boolean(document.querySelector('#clipboard-policy-write-probe')?.dataset.result))
  const policyWriteResult = await policyProbe.locator('#clipboard-policy-write-probe').getAttribute('data-result')
  check(policyWithoutAllow === false && clipboardPolicyAllowed === true && policyWriteResult?.startsWith('rejected:NotAllowedError:') && policyWriteResult.includes('permissions policy'),
    'cross-origin iframe policy rejects real writeText without allow and enables the production allowlist (' + JSON.stringify({ policyWithoutAllow, policyWriteResult, clipboardPolicyAllowed }) + ')')
  await clipboardHost.locator('iframe[name="clipboard-policy-probe"]').evaluate(frame => frame.remove())
  responseMode = 'clipboard'
  await clipboardFrame.locator('#ask-input').fill('Copy this exact text')
  await clipboardFrame.locator('#ask-btn').click()
  await waitSaved(clipboardFrame, 'Complete')
  responseMode = 'normal'
  await clipboardFrame.locator('.msg.assistant').last().hover()
  await clipboardFrame.locator('.msg.assistant').last().locator('.msg-action-items button[aria-label="Copy"]').click()
  await clipboardFrame.waitForFunction(() => document.querySelector('.msg-copy-feedback')?.textContent === 'Copied')
  await ctx.grantPermissions(['clipboard-read'], { origin })
  const systemClipboardText = await clipboardHost.evaluate(() => navigator.clipboard.readText())
  check(clipboardFramePolicy === 'clipboard-write' && clipboardPolicyAllowed === true && systemClipboardText === 'clipboard-real-proof',
    'real host-page iframe copies the exact assistant text to system clipboard (' + JSON.stringify({ clipboardFramePolicy, clipboardPolicyAllowed, systemClipboardText }) + ')')
  await clipboardHost.close()

  await resetCooldown(hint)
  // The fixture reset above updates IndexedDB, while this already-open page
  // still holds the prior cooldown in memory. Reload so the next send starts
  // from the reset state instead of silently remaining disabled.
  await hint.reload()
  await hint.waitForFunction(() => {
    const image = document.querySelector('.turn-image')
    return !!image?.src && image.naturalWidth > 0
  })
  const requestsBeforeAttachmentFollowup = requestCount
  const assistantsBeforeAttachmentFollowup = await hint.locator('.msg.assistant').count()
  await hint.fill('#ask-input', 'What is the next step?')
  await hint.click('#ask-btn')
  await hint.waitForFunction(({ assistantCount }) => document.querySelectorAll('.msg.assistant').length > assistantCount,
    { assistantCount: assistantsBeforeAttachmentFollowup })
  const attachmentRequestDeadline = Date.now() + 2000
  while (requestCount === requestsBeforeAttachmentFollowup && Date.now() < attachmentRequestDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await waitSaved(hint, 'Complete')
  const attachmentParts = lastAiRequest.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  const attachmentSummary = {
    imageCount: attachmentParts.filter(part => part.type === 'image_url').length,
    messages: lastAiRequest.messages.map(message => ({
      role: message.role,
      parts: Array.isArray(message.content)
        ? message.content.map(part => part.type === 'image_url' ? { type: part.type, urlPrefix: part.image_url?.url?.slice(0, 30) } : { type: part.type, text: part.text?.slice(0, 80) })
        : [{ type: 'text', text: String(message.content).slice(0, 80) }],
    })),
  }
  check(requestCount === requestsBeforeAttachmentFollowup + 1 && attachmentSummary.imageCount === 1,
    'attachment sent once across multiple turns (' + JSON.stringify({ ...attachmentSummary, requestDelta: requestCount - requestsBeforeAttachmentFollowup }) + ')')
  await resetCooldown(hint)
  const usersBeforeRetry = await hint.locator('.msg.user').count()
  await hint.locator('.msg.assistant').last().hover()
  await hint.click('[data-retry]')
  await hint.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 3)
  await waitSaved(hint, 'Complete')
  check(await hint.locator('.msg.user').count() === usersBeforeRetry && lastAiRequest.max_tokens === 8_192 && !('temperature' in lastAiRequest), 'explicit Regenerate preserves the source user turn and its original turn budget')

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
  const checkedHasImage = lastAiRequest.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
  const checkedHasInstruction = lastAiRequest.messages.some(message => message.role === 'system' ||
    typeof message.content === 'string' && message.content.length > 0 ||
    Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text.length > 0))
  check(lastAiRequest.messages.length > 0 && checkedHasImage && checkedHasInstruction &&
    JSON.stringify(lastAiRequest.messages).includes('Check the student\'s work visible in the image') && lastAiRequest.max_tokens === 8_192 && !('temperature' in lastAiRequest) && JSON.stringify(lastAiRequest.reasoning) === JSON.stringify({ effort: 'medium', exclude: true }),
    'Check sends its approved visible-work instruction with the image and keeps the Haiku request budget')
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

  for (const [mode, label, status] of [['truncated', 'Length limit', 'truncated'], ['interrupted', 'Interrupted', 'interrupted']]) {
    responseMode = mode
    const p = await openCapture()
    await p.click('[data-preset="hint"]')
    await waitSaved(p, label)
    const saved = await readSaved(p)
    check(saved.conversations.find(c => c.id === saved.state.lastConversationId).turns.at(-1).status === status, `${status} preserves partial text and its actual saved status`)
    await p.close()
  }
  responseMode = 'context-error'
  const contextRejected = await openCapture()
  const beforeContextRejected = requestCount
  await contextRejected.click('[data-preset="hint"]')
  await waitSaved(contextRejected, 'The selected context exceeds the provider limit')
  const rejectedConversation = await readSaved(contextRejected)
  const rejectedAssistant = rejectedConversation.conversations.find(c => c.id === rejectedConversation.state.lastConversationId).turns.at(-1)
  const contextRejectedStatus = await contextRejected.locator('.msg.assistant .reply-status').last().textContent()
  check(rejectedAssistant.status === 'interrupted' && rejectedAssistant.text === 'Hello' &&
    contextRejectedStatus.includes('The selected context exceeds the provider limit') &&
    requestCount === beforeContextRejected + 1 && lastAiRequest.model === PRIMARY,
  'partial OpenRouter context rejection keeps emitted text, shows localized recovery and never falls back')
  await contextRejected.close()
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
  const quotaId = (await readSaved(quota)).state.lastConversationId
  const quotaRow = quota.locator('.history-row:has(.history-open[data-conversation="' + quotaId + '"])')
  await quotaRow.waitFor({ state: 'visible' })
  const quotaDb = await readSaved(quota)
  const quotaStatus = quotaDb.conversations.find(c => c.id === quotaId).turns.at(-1).status
  check(await quotaRow.count() === 1 && quotaStatus === 'interrupted', 'failed write remains in History with its interrupted partial status and no export affordance (status=' + quotaStatus + ')')
  await quota.close()
  responseMode = 'normal'
  await hint.close()
  await checked.close()

  const formatted = await openCapture()
  responseMode = 'formatted'
  await resetCooldown(formatted)
  await formatted.fill('#ask-input', 'Render the structured answer while it streams')
  await formatted.click('#ask-btn')
  await formatted.waitForFunction(() => document.querySelector('.msg.assistant h3')?.textContent === 'Working' && document.querySelector('.msg.assistant strong')?.textContent === 'First')
  await formatted.waitForFunction(async () => {
    const request = indexedDB.open('study-buddy-conversations', 1)
    const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result) })
    const tx = db.transaction('conversations', 'readonly')
    const all = await new Promise(resolve => { const get = tx.objectStore('conversations').getAll(); get.onsuccess = () => resolve(get.result) })
    db.close()
    return all.some(c => c.turns.some(turn => turn.role === 'assistant' && turn.status === 'streaming'))
  })
  await formatted.dispatchEvent('.preset[data-preset="explain"]', 'pointerenter')
  await formatted.waitForFunction(() => document.querySelector('.msg.assistant:last-of-type')?.dataset.exclusion === 'incomplete')
  const liveBackground = await formatted.locator('.msg.assistant').last().evaluate(row => ({
    excludedClass: row.classList.contains('context-excluded'),
    background: getComputedStyle(row.querySelector('.msg-body')).backgroundColor,
  }))
  check(!liveBackground.excludedClass && liveBackground.background === 'rgba(0, 0, 0, 0)',
    'streaming assistant stays visually transparent after an incomplete context projection (' + JSON.stringify(liveBackground) + ')')
  check(!(await formatted.locator('.msg.assistant .msg-body').textContent()).includes('**'),
    'a live heading and unfinished bold text render before the answer completes, without Markdown markers')
  await formatted.waitForSelector('.math-pending')
  const pendingMath = await formatted.locator('.msg.assistant .msg-body').textContent()
  check(!pendingMath.includes('\\frac') && !pendingMath.includes('$$') && await formatted.locator('.katex-error').count() === 0,
    'incomplete streaming math is buffered instead of exposing LaTeX fragments or parser errors')
  await formatted.waitForSelector('.katex')
  check(await formatted.locator('.math-pending').count() === 0,
    'a closed formula renders with KaTeX while the rest of the answer is still streaming')
  await formatted.waitForFunction(() => document.querySelector('pre code')?.textContent?.includes('const price = "$5";'))
  check((await formatted.locator('.msg.assistant .msg-body').textContent()).includes('snake_case') &&
    (await formatted.locator('pre code').textContent()).includes('$5'),
    'stream preview preserves underscores and dollar signs in code, including an unfinished code fence')
  await formatted.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent?.includes('Complete'))
  const formattedDb = await readSaved(formatted)
  const formattedTurn = formattedDb.conversations.find(c => c.id === formattedDb.state.lastConversationId).turns.at(-1)
  const formulaRender = await formatted.evaluate(() => ({
    inline: [...document.querySelectorAll('.msg.assistant .katex')].some(node => !node.closest('.katex-display')),
    displays: document.querySelectorAll('.msg.assistant .katex-display .katex').length,
    visibleRawDelimiters: [String.raw`\[`, String.raw`\]`, String.raw`\(`, String.raw`\)`].some(delimiter => document.querySelector('.msg.assistant .msg-body')?.textContent?.includes(delimiter)),
    background: getComputedStyle([...document.querySelectorAll('.msg.assistant')].at(-1)?.querySelector('.msg-body')).backgroundColor,
  }))
  check(formattedTurn.text.includes('**First step**') && formattedTurn.text.includes('$$\\frac{1}{2}$$') &&
    formattedTurn.text.includes(String.raw`\[` + '\nx=' + String.raw`\frac{1}{2}` + '\n' + String.raw`\]`) && formattedTurn.text.includes(String.raw`\(a+b\)`) &&
    formulaRender.inline && formulaRender.displays >= 2 && !formulaRender.visibleRawDelimiters &&
    formulaRender.background === 'rgba(0, 0, 0, 0)' &&
    await formatted.evaluate(() => window.__streamXss === undefined && !document.querySelector('.msg.assistant [onerror]')),
    'inline and display delimiter formulas render while the stored transcript remains raw (' + JSON.stringify(formulaRender) + ')')
  responseMode = 'normal'
  await formatted.close()

  // Independent fixture scenarios may delete the globally selected chat.
  // Re-enter the native lifecycle with a fresh saved image conversation.
  const nativeFixture = await openCapture()
  await nativeFixture.close()
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
    const labels = text === 'Restore Study Buddy' ? [text, 'Открыть Study Buddy'] : [text]
    const attribute = (node, name) => {
      const index = node.attributes?.indexOf(name) ?? -1
      return index < 0 ? undefined : node.attributes[index + 1]
    }
    const find = (node) => {
      if (node.nodeName === 'BUTTON' && (
        node.children?.some(child => labels.includes(child.nodeValue)) ||
        labels.some(label => attribute(node, 'aria-label')?.startsWith(label) || attribute(node, 'title')?.startsWith(label))
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
  if (await page.locator('[data-study-buddy="chat"][data-state="open"]').count()) await clickHostButton('−')
  await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'minimized' &&
    !!document.querySelector('[data-study-buddy="launcher"]'))
  await clickHostButton('Restore Study Buddy')
  let embedded = await chatFrameOn(page)
  await embedded.waitForSelector('#view-capture:not([hidden])')
  const embeddedElement = await embedded.frameElement()
  const embeddedBounds = await embeddedElement.boundingBox()
  const outsidePoint = embeddedBounds.x > 24
    ? { x: Math.max(4, Math.floor(embeddedBounds.x - 8)), y: Math.max(8, Math.floor(embeddedBounds.y + 12)) }
    : { x: Math.min(1270, Math.ceil(embeddedBounds.x + embeddedBounds.width + 8)), y: Math.max(8, Math.floor(embeddedBounds.y + 12)) }
  const requestCountBeforeHostDismiss = requestCount
  const hostClicksBeforeDismiss = await page.evaluate(() => window.hostClickCount)
  await embedded.locator('[data-preset="explain"]').hover()
  await embedded.waitForFunction(() => document.querySelector('#task-tooltip')?.matches(':popover-open'))
  await page.mouse.click(outsidePoint.x, outsidePoint.y)
  await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'minimized' &&
    !!document.querySelector('[data-study-buddy="launcher"]'))
  await embedded.waitForFunction(() => !document.querySelector('#task-tooltip')?.matches(':popover-open'))
  check(requestCount === requestCountBeforeHostDismiss &&
    await page.evaluate(() => window.hostClickCount) === hostClicksBeforeDismiss + 1,
    'a host-page click dismisses the tooltip, reaches the page, and minimizes without starting an action')
  await clickHostButton('Restore Study Buddy')
  await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'open')
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
  await duplicate.waitForFunction(() => document.getElementById('ask-btn')?.getAttribute('aria-label') === 'Stop')
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
  const closedBinding = pageTabId === undefined ? undefined : await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
  check(savedClose.status === 'cancelled' && savedClose.text.startsWith('Hello') && !afterClose.state.generation &&
    await page.locator('[data-study-buddy="launcher"]').count() === 0 && closedBinding === undefined,
  'Close commits the partial reply, removes the panel and launcher and clears the shared chat')

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
  const nextConversationId = pageTabId === undefined ? undefined : await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
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
    sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
  const selectedClosedId = await tabBinding()
  check(selectedClosedId === nativeId, `History opens the closed saved conversation (${oldConversation.id})`)
  await embedded.click('#history-btn')
  const nextRowText = ['Study Buddy', 'New chat', 'Hint', 'Check', 'Solve', 'Explain', 'Translate', 'Summarize'].includes(nextConversation.title) ? 'New chat' : nextConversation.title
  const nextHistoryRow = embedded.locator('.history-row .history-open').filter({ hasText: nextRowText }).first()
  await nextHistoryRow.waitFor()
  await nextHistoryRow.click()
  await embedded.waitForSelector('#view-capture:not([hidden])')
  check(await tabBinding() === nextConversationId, 'History also reopens the newly selected conversation as the shared active chat')
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
  const activeBeforeDismiss = await sw.evaluate(async () => (await chrome.storage.session.get('dialog.active'))['dialog.active'])
  await sw.evaluate(async (tabId) => new Promise((resolve) => chrome.tabs.sendMessage(tabId,
    { type: 'SHOW_CHAT', state: { kind: 'error', message: 'Dismiss fixture' } }, () => resolve())), dismissTabId)
  await dismissPage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  await clickHostButtonOn(dismissPage, '✕')
  await dismissPage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  const dismissBinding = dismissTabId === undefined ? undefined :
    await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
  const afterDismissError = await readSaved(duplicate)
  check(dismissBinding === activeBeforeDismiss &&
    beforeDismissError.conversations.map(c => c.id).join(',') === afterDismissError.conversations.map(c => c.id).join(','),
  'Close dismisses an initial error host without creating or deleting a conversation')
  await dismissPage.close()

  const showChatOnTab = async (tabId, state) => sw.evaluate(async ({ tabId, state }) => {
    // Production restore selects in the coordinator before showing a read-only view.
    if (state.kind === 'conversation') await chrome.storage.session.set({ 'dialog.active': state.conversationId })
    await new Promise(resolve => chrome.tabs.sendMessage(tabId, { type: 'SHOW_CHAT', state }, () => resolve()))
  }, { tabId, state })
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
  await sw.evaluate(async ({ tabId, conversationId }) => chrome.storage.session.set({ [`dialog.active`]: conversationId }),
    { tabId: earlyCloseTabId, conversationId: nativeId })
  await showChatOnTab(earlyCloseTabId, { kind: 'conversation', conversationId: nativeId })
  await earlyClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  const earlyCloseFrame = await chatFrameOn(earlyClosePage)
  await earlyCloseFrame.waitForFunction(() => sessionStorage.getItem('__studyBuddyEarlyClose') === 'pending')
  await clickHostButtonOn(earlyClosePage, '✕')
  await earlyClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  await earlyClosePage.waitForTimeout(900)
  const earlyCloseBinding = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
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
  const earlyCaptureId = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
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
  await sw.evaluate(async ({ tabId, conversationId }) => chrome.storage.session.set({ [`dialog.active`]: conversationId }),
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
  }, { key: `dialog.active`, expected: nextConversationId })
  if (selectedHistoryBinding !== nextConversationId) throw new Error('History did not select the other saved conversation for its tab.')
  await showChatOnTab(boundDismissTabId, { kind: 'error', message: 'Dismiss bound fixture' })
  await boundDismissFrame.waitForSelector('#view-error:not([hidden])')
  await clickHostButtonOn(boundDismissPage, '✕')
  await boundDismissPage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  const boundDismissBinding = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
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
  await sw.evaluate(async ({ tabId, conversationId }) => chrome.storage.session.set({ [`dialog.active`]: conversationId }),
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
  const selectedBeforeClose = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
  if (!newChatBinding || selectedBeforeClose !== newChatBinding) throw new Error('New chat selection did not reach its tab binding before the delayed reply.')
  await clickHostButtonOn(newChatClosePage, '✕')
  await newChatClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  const newChatBindingAfterClose = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
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
  await sw.evaluate(async ({ tabId, conversationId }) => chrome.storage.session.set({ [`dialog.active`]: conversationId }),
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
  const bindingDuringCreateReply = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
  if (bindingDuringCreateReply !== nativeId) throw new Error('Create changed the tab binding before the delayed client reply.')
  await clickHostButtonOn(createClosePage, '✕')
  await createClosePage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  await createClosePage.waitForTimeout(800)
  const afterCreateCloseBinding = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
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
  await sw.evaluate(async ({ tabId, conversationId }) => chrome.storage.session.set({ [`dialog.active`]: conversationId }),
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
  const newerBinding = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
  if (newerBinding !== newerConversationId) throw new Error('The newer SHOW_CHAT did not select its conversation before Close.')
  await closeRacePage.waitForFunction(() => sessionStorage.getItem('__studyBuddyCloseResponsePending') === 'yes')
  await closeRacePage.evaluate(conversationId => window.postMessage({ __studyBuddyReleaseCloseResponse: true, conversationId }, '*'), nativeId)
  await closeRacePage.waitForFunction(id => sessionStorage.getItem('__studyBuddyReleasedCloseConversation') === id, nativeId)
  check(await closeRacePage.locator('[data-study-buddy="chat"]').count() === 1 &&
    await sw.evaluate(async ({ key, id }) => (await chrome.storage.session.get(key))[key] === id,
      { key: `dialog.active`, id: newerConversationId }),
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
  const closeRaceBindingAfter = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
  check(closeRaceBindingAfter === undefined, 'the newer conversation remains closable after the stale response is discarded')
  await closeRacePage.close()

  // Exercise the worker's atomic admission, not just disabled UI controls.
  await resetCooldown(duplicate)
  const raceId = (await readSaved(duplicate)).state.lastConversationId
  const racePeer = await ctx.newPage()
  await racePeer.goto(`${chatOrigin}/src/chat/chat.html?kind=conversation&conversation=${raceId}`)
  const admission = (p, text = 'Race fixture', kind = 'ask') => p.evaluate(({ id, text, kind }) => new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'study-buddy-generation' })
    const user = { id: crypto.randomUUID(), role: 'user', text, kind, createdAt: Date.now(), locale: 'en', promptVersion: 'fixture' }
    const assistant = { ...user, id: crypto.randomUUID(), role: 'assistant', text: '', status: 'streaming', replyTo: user.id }
    port.onMessage.addListener((response) => {
      if (response.seq === 1) {
        if (response.ok) port.postMessage({ seq: 2, action: 'update', text: '', status: 'cancelled' })
        else { port.disconnect(); resolve(response) }
      } else { port.disconnect(); resolve({ ok: true }) }
    })
    port.postMessage({ seq: 1, action: 'start', conversationId: id, user, assistant })
  }), { id: raceId, text, kind })
  const requestCountBeforeBlankAsk = requestCount
  const blankAsk = await admission(duplicate, '  ', 'ask')
  check(!blankAsk.ok && blankAsk.error === 'dialog.invalid' && requestCount === requestCountBeforeBlankAsk,
    'generation coordinator rejects blank Ask without a provider request')
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
  check(manifest.host_permissions.includes('<all_urls>') && manifest.host_permissions.includes(`${gatewayUrl}/*`) && manifest.content_scripts.some(script => script.matches.includes('https://*/*') && script.matches.includes('http://*/*')), 'build declares automatic web-page injection and persistent host access without a runtime permission prompt')
  check(manifest.permissions.includes('clipboardWrite'), 'manifest grants extension-scoped clipboard write for the user-triggered Copy action')
  await racePeer.close()

  await duplicate.evaluate(conversationId => chrome.runtime.sendMessage({ type: 'CONVERSATION', action: 'select', conversationId }), nextConversationId)
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
  const pageBinding = pageTabId === undefined ? undefined : await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
  check(pageBinding === nextConversationId && recaptureDialog.activeAttachmentId !== nextAttachmentId && recaptureDialog.turns.some(turn => turn.kind === 'capture' && turn.attachmentId === nextAttachmentId) && recaptureDialog.turns.some(turn => turn.kind === 'capture' && turn.attachmentId === recaptureDialog.activeAttachmentId), 'new capture continues the shared active dialog while keeping old turn attachment links')
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
  const quickBinding = quickTabId === undefined ? undefined : await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `dialog.active`)
  check(requestCount === beforeRapidClose && !rapidCloseState.state.generation &&
    !rapidCloseState.conversations.some(c => c.turns.some(turn => turn.text === 'This start must be cancelled by Close')) && quickBinding === undefined,
  'Close during settings load prevents a queued Solve from starting and clears the shared active chat')
  await quickPage.close()

  // Only minimizing exposes the shared launcher on other web pages.
  await duplicate.evaluate(conversationId => chrome.runtime.sendMessage({ type: 'CONVERSATION', action: 'select', conversationId }), nextConversationId)
  await page.bringToFront()
  await showChatOnTab(pageTabId, { kind: 'conversation', conversationId: nextConversationId })
  let sharedFrame = await chatFrameOn(page)
  await clickHostButton('−')
  const otherPage = await ctx.newPage()
  const otherUrl = `${origin.replace('127.0.0.1', 'localhost')}/other`
  await otherPage.goto(otherUrl)
  await otherPage.waitForSelector('[data-study-buddy="launcher"]', { state: 'attached' })
  check(otherPage.frames().length === 1 && await otherPage.locator('[data-study-buddy="launcher"]').count() === 1,
    'after minimizing, a different origin gets one launcher without creating an iframe or a chat')
  await clickHostButtonOn(otherPage, 'Restore Study Buddy')
  let otherFrame = await chatFrameOn(otherPage)
  await otherFrame.waitForSelector('#view-capture:not([hidden])')
  check(new URL(otherFrame.url()).searchParams.get('conversation') === nextConversationId,
    'clicking the launcher on a different origin restores the same shared chat')
  responseMode = 'slow'
  await resetCooldown(sharedFrame)
  const beforeSharedStart = requestCount
  await page.bringToFront()
  await showChatOnTab(pageTabId, { kind: 'conversation', conversationId: nextConversationId })
  await sharedFrame.click('[data-preset="hint"]')
  await otherFrame.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .msg-body')].at(-1)?.textContent?.includes('Hello'))
  await otherFrame.waitForFunction(() => document.getElementById('ask-btn')?.getAttribute('aria-label') === 'Stop')
  const mirroredBefore = (await otherFrame.locator('.msg.assistant .msg-body').last().textContent()).length
  await clickHostButton('−')
  await otherPage.bringToFront()
  await otherFrame.waitForFunction(length => [...document.querySelectorAll('.msg.assistant .msg-body')].at(-1)?.textContent?.length > length, mirroredBefore)
  check(page.frames().includes(sharedFrame) && requestCount === beforeSharedStart + 1,
    'switching tabs and minimizing preserves one writer while the other tab renders its streaming reply')
  await otherFrame.click('#ask-btn')
  await otherFrame.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent?.includes('Stopped'))
  const sharedStopped = await readSaved(otherFrame)
  check(!sharedStopped.state.generation && sharedStopped.conversations.find(c => c.id === nextConversationId).turns.at(-1).status === 'cancelled',
    'Stop in a mirrored tab aborts the original writer and saves its final partial reply')
  await otherPage.reload()
  await otherPage.waitForSelector('[data-study-buddy="launcher"]', { state: 'attached' })
  await clickHostButtonOn(otherPage, 'Restore Study Buddy')
  otherFrame = await chatFrameOn(otherPage)
  await otherFrame.waitForSelector('#view-capture:not([hidden])')
  check(new URL(otherFrame.url()).searchParams.get('conversation') === nextConversationId && requestCount === beforeSharedStart + 1,
    'reload recreates the launcher and reopens the shared transcript without a model request')
  await otherFrame.click('#new-chat-btn')
  await otherFrame.waitForFunction(() => document.querySelectorAll('.msg').length === 0)
  const sharedNewId = await sw.evaluate(async () => (await chrome.storage.session.get('dialog.active'))['dialog.active'])
  await sharedFrame.waitForFunction(() => document.querySelectorAll('.msg').length === 0, undefined, { polling: 100 })
  check(sharedNewId !== nextConversationId,
    'New chat changes the shared selection and all existing panels observe the empty conversation')
  await otherFrame.click('#history-btn')
  await otherFrame.locator(`.history-open[data-conversation="${nextConversationId}"]`).click()
  await otherFrame.waitForSelector('#view-capture:not([hidden])')
  await sharedFrame.waitForFunction(() => document.querySelectorAll('.turn-image').length > 0, undefined, { polling: 100 })
  await resetCooldown(otherFrame)
  await otherFrame.click('[data-preset="hint"]')
  await sharedFrame.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent?.includes('Answering'), undefined, { polling: 100 })
  await page.bringToFront()
  await showChatOnTab(pageTabId, { kind: 'conversation', conversationId: nextConversationId })
  await clickHostButton('✕')
  await page.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  await otherPage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  const afterSharedClose = await readSaved(freshPeer)
  const activeAfterClose = await sw.evaluate(async () => (await chrome.storage.session.get('dialog.active'))['dialog.active'])
  check(!activeAfterClose && !afterSharedClose.state.generation &&
    afterSharedClose.conversations.find(c => c.id === nextConversationId).turns.at(-1).status === 'cancelled' &&
    await page.locator('[data-study-buddy="launcher"]').count() === 0 && await otherPage.locator('[data-study-buddy="launcher"]').count() === 0,
    'Close from a mirrored tab cancels the writer and removes all panels and launchers')
  await triggerAction(page)
  await page.waitForSelector('[data-study-buddy="overlay"]')
  await page.keyboard.press('Escape')
  check(await page.locator('[data-study-buddy="launcher"]').count() === 0,
    'after Close, cancelling a fresh selection does not create an idle launcher')
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

  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`)
  writeFileSync(join(evidence, 'runtime.json'), JSON.stringify({
    requestCount, failures, pageErrors, namedAssertions: acceptanceEvidence,
    fixture: 'localhost mock only', physicalShortcut: 'not dispatched by headless Chromium',
  }, null, 2))
} finally {
  await ctx.close()
  if (backend) await backend.close()
  if (vite) await vite.close()
  await new Promise((resolve) => server.close(() => resolve()))
  rmSync(profile, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
