// Isolated local acceptance browser + mock provider. Never reads credentials.
import { chromium } from 'playwright'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const stateDir = join(root, 'review', 'preview')
const stateFile = join(stateDir, 'state.json')
const command = process.argv[2] ?? 'start'
const smoke = process.argv.includes('--smoke')
const extensionFlag = process.argv.indexOf('--extension-dir')
if (extensionFlag >= 0 && (!process.argv[extensionFlag + 1] || process.argv[extensionFlag + 1].startsWith('--'))) {
  throw new Error('--extension-dir requires the path to an existing extension build')
}
const suppliedDist = extensionFlag < 0 ? undefined : resolve(process.argv[extensionFlag + 1])

function inventory(directory) {
  const entries = []
  const visit = (folder, prefix = '') => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = prefix + entry.name
      if (entry.isDirectory()) visit(join(folder, entry.name), name + '/')
      else if (entry.isFile()) entries.push([name, createHash('sha256').update(readFileSync(join(folder, entry.name))).digest('hex')])
    }
  }
  visit(directory)
  return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}
if (command === 'stop' || command === 'health') {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  const response = await fetch(`${state.origin}/${command === 'stop' ? 'stop' : 'healthz'}`, {
    method: command === 'stop' ? 'POST' : 'GET',
    headers: { 'X-Preview-Token': state.token },
  })
  if (!response.ok) throw new Error(`Preview ${command}: HTTP ${response.status}`)
  console.log(await response.text())
  process.exit(0)
}
if (command !== 'start') throw new Error('Use start, health or stop')
mkdirSync(stateDir, { recursive: true })
const runDir = mkdtempSync(join(stateDir, 'run-'))
const dist = suppliedDist ?? join(runDir, 'dist')
const portProbe = createNetServer()
await new Promise((resolve, reject) => portProbe.listen(0, '127.0.0.1', resolve).once('error', reject))
const gatewayPort = portProbe.address().port
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()))
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`
const buildEnv = { ...process.env, STUDY_BUDDY_GATEWAY_URL: gatewayUrl }
delete buildEnv.OPENROUTER_API_KEY
delete buildEnv.OPENAI_API_KEY
if (!suppliedDist) execFileSync('npm', ['run', 'build', '--', '--outDir', dist], { cwd: root, env: buildEnv, stdio: 'inherit' })
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
const gatewayMatches = manifest.host_permissions?.filter(value => value !== '<all_urls>') ?? []
if (manifest.host_permissions?.length !== 2 || gatewayMatches.length !== 1 || !manifest.host_permissions.includes('<all_urls>')) {
  throw new Error('Preview requires one gateway host and the production all-sites launcher permission.')
}
const compiledGatewayUrl = new URL(gatewayMatches[0]).origin
if (!suppliedDist && compiledGatewayUrl !== gatewayUrl) throw new Error('Preview build has an unexpected gateway.')
const extensionFiles = inventory(dist)
const extensionSha256 = createHash('sha256').update(JSON.stringify(extensionFiles)).digest('hex')
const token = randomUUID()
let ctx
let stopping = false
let requests = 0
let previewPrompts
let origin
let captureReady = false
let backend
let vite
let gatewayProxy
const pageErrors = []
const stop = async () => {
  if (stopping) return
  stopping = true
  await ctx?.close()
  await backend?.close()
  await vite?.close()
  if (gatewayProxy?.listening) await new Promise(resolve => gatewayProxy.close(resolve))
  if (server.listening) server.close()
}
const demo = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Calculus II · Parameter integrals</title>
<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.65 system-ui;background:#f3f5f8;color:#1e293b}
header{height:72px;padding:20px 32px;background:white;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:16px}
header strong{font-size:18px}header span{color:#64748b;font-size:13px}main{padding:30px 32px;width:612px}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:#64748b;margin:0 0 8px}
h1{font-size:28px;line-height:1.25;letter-spacing:-.025em;margin:0 0 24px}article{background:white;border:1px solid #dce3ec;border-radius:14px;padding:24px;box-shadow:0 3px 12px #1e293b04}
.number{font-size:11px;font-weight:700;letter-spacing:.1em;color:#2563eb;text-transform:uppercase}h2{font-size:19px;line-height:1.4;margin:8px 0 16px}p{margin:12px 0}
math{font-size:25px;margin:24px 0}ol{padding-left:20px;color:#475569;font-size:14px}.note{font-size:12px;color:#64748b;margin-top:22px}
</style>
<header><strong>Calculus II</strong><span>Practice set 04 / Improper integrals</span></header>
<main><p class="eyebrow">University mathematics</p><h1>Differentiation under<br>the integral sign</h1>
<article data-demo-problem><span class="number">Exercise 07</span><h2>A parameter-dependent integral</h2><p>For <i>a</i> &gt; 0, evaluate</p>
<math display="block"><mrow><mi>I</mi><mo>(</mo><mi>a</mi><mo>)</mo><mo>=</mo><msubsup><mo>∫</mo><mn>0</mn><mi>∞</mi></msubsup><mfrac><mrow><mi>ln</mi><mo>(</mo><mn>1</mn><mo>+</mo><msup><mi>a</mi><mn>2</mn></msup><msup><mi>x</mi><mn>2</mn></msup><mo>)</mo></mrow><mrow><mn>1</mn><mo>+</mo><msup><mi>x</mi><mn>2</mn></msup></mrow></mfrac><mspace width=".2em"/><mi>d</mi><mi>x</mi><mo>.</mo></mrow></math>
<ol><li>Establish convergence of the improper integral.</li><li>Justify differentiation with respect to the parameter.</li><li>Find a closed form for <i>I(a)</i>.</li></ol></article>
<p class="note">Select the exercise to explore a hint with Study Buddy.<br>Synthetic exercise · Simulated response · No live model request.</p></main></html>`
const hintAnswer = String.raw`### Differentiate under the integral sign

Differentiating removes the logarithm:

$$I'(a)=2a\int_0^\infty\frac{x^2}{(1+x^2)(1+a^2x^2)}\,dx.$$

Use **partial fractions** and $$\int_0^\infty\frac{dx}{1+b^2x^2}=\frac{\pi}{2b}$$ to show that $I'(a)=\frac{\pi}{1+a}$. Then integrate, using $I(0)=0$.`
const screenshots = ['dialog', 'check', 'history', 'minimized', 'narrow']
const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: !stopping && !!ctx && captureReady, browser: 'agent-owned Chromium', captured: captureReady, gatewayUrl, requests, mockOnly: true, pid: process.pid }))
    return
  }
  if (req.url === '/stop' && req.method === 'POST') {
    if (req.headers['x-preview-token'] !== token) { res.writeHead(403); res.end('Forbidden'); return }
    res.end('Preview stopped; original browser and project are untouched.')
    void stop()
    return
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += chunk; if (body.length > 32 * 1024 * 1024) req.destroy() })
    req.on('end', () => {
      let request
      try { request = JSON.parse(body) } catch { res.writeHead(400); res.end(); return }
      requests++
      const kind = previewPrompts.classifyPreviewTask(request.messages, previewPrompts)
      const text = kind === 'hint' ? hintAnswer
        : kind === 'check' ? 'Before differentiating, justify convergence near zero and infinity. Then bound the parameter derivative on a compact interval of positive values of a.'
        : 'Local mock demonstration. No real model is called.'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunks = text.match(/[\s\S]{1,24}/gu) ?? []
      const timer = setInterval(() => {
        const chunk = chunks.shift()
        if (chunk !== undefined) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
        else { clearInterval(timer); res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":2,"cost":0.0001}}\n\ndata: [DONE]\n\n') }
      }, 70)
      res.on('close', () => clearInterval(timer))
    })
    return
  }
  const screenshot = screenshots.find(name => req.url === `/${name}.png`)
  if (screenshot && existsSync(join(root, 'review', 'loop', `${screenshot}.png`))) {
    res.setHeader('content-type', 'image/png')
    res.end(readFileSync(join(root, 'review', 'loop', `${screenshot}.png`)))
    return
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(req.url === '/demo' ? demo : `<!doctype html><meta charset="utf-8"><title>Study Buddy · Local preview</title><style>body{font:16px system-ui;margin:30px;background:#eef1f5}a{color:#1457ad}main{display:flex;gap:20px;flex-wrap:wrap}figure{margin:0}img{width:300px;max-height:470px;object-fit:contain;object-position:top;background:white}figcaption{padding:10px}</style><h1>Study Buddy · Local preview</h1><p>Screenshots of the real extension with a local mock provider. <a href="/demo">Demo page</a> · <a href="/healthz">Health</a></p><p>The demo runs in isolated Chromium with the real backend and a local mock provider. No live model requests are made.</p><main>${screenshots.map(name => `<figure><a href="/${name}.png"><img src="/${name}.png" alt="${name}"></a><figcaption>${name}</figcaption></figure>`).join('')}</main>`)
})
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.STUDY_BUDDY_PREVIEW_PORT ?? 4187), '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  let redirectedGatewayUrl = gatewayUrl
  if (suppliedDist && compiledGatewayUrl.startsWith('https:')) {
    // Keep the supplied artifact byte-for-byte intact. A loopback TLS relay
    // preserves streaming while the browser redirects its compiled HTTPS gateway.
    const keyPath = join(runDir, 'fixture.key')
    const certPath = join(runDir, 'fixture.crt')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' })
    gatewayProxy = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
      const upstream = httpRequest(gatewayUrl + request.url, { method: request.method, headers: request.headers }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers)
        incoming.pipe(response)
      })
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      response.once('close', () => upstream.destroy())
      request.pipe(upstream)
    })
    await new Promise((resolve, reject) => {
      gatewayProxy.once('error', reject)
      gatewayProxy.listen(0, '127.0.0.1', resolve)
    })
    redirectedGatewayUrl = `https://127.0.0.1:${gatewayProxy.address().port}`
  }
  ctx = await chromium.launchPersistentContext(join(runDir, 'profile'), {
    channel: 'chromium', headless: process.argv.includes('--headless'), viewport: { width: 1200, height: 800 },
    ignoreHTTPSErrors: !!gatewayProxy,
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  })
  ctx.on('page', page => page.on('pageerror', error => pageErrors.push(String(error))))
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url())
    if (suppliedDist && url.origin === compiledGatewayUrl) {
      return route.continue({ url: redirectedGatewayUrl + url.pathname + url.search })
    }
    return ['http:', 'https:'].includes(url.protocol) && ![origin, gatewayUrl].includes(url.origin) ? route.abort() : route.continue()
  })
  let [sw] = ctx.serviceWorkers()
  if (!sw) sw = await ctx.waitForEvent('serviceworker')
  const extensionId = new URL(sw.url()).hostname
  const viteModule = await import('vite')
  vite = await viteModule.createServer({ configFile: false, root, appType: 'custom', server: { middlewareMode: true } })
  const [{ createBackend }, { loadBackendConfig }, prompts, previewTask] = await Promise.all([
    vite.ssrLoadModule('/src/backend/app.ts'),
    vite.ssrLoadModule('/src/backend/config.ts'),
    vite.ssrLoadModule('/src/shared/prompts/index.ts'),
    import('./preview-task.mjs'),
  ])
  previewPrompts = { ...prompts, classifyPreviewTask: previewTask.classifyPreviewTask }
  const backendConfig = loadBackendConfig({
    OPENROUTER_API_KEY: 'FAKE_PREVIEW_PROVIDER_KEY',
    SESSION_HMAC_SECRET: 'local-preview-session-secret-for-tests-012345',
    HOST: '127.0.0.1',
    PORT: String(gatewayPort),
    DATABASE_PATH: join(runDir, 'gateway.sqlite'),
    ALLOWED_ORIGINS: `chrome-extension://${extensionId}`,
  })
  backend = createBackend(backendConfig, { providerBaseUrl: `${origin}/v1` })
  await new Promise((resolve, reject) => {
    backend.server.once('error', reject)
    backend.server.listen(gatewayPort, '127.0.0.1', () => {
      backend.server.off('error', reject)
      resolve()
    })
  })
  await sw.evaluate(settings => chrome.storage.local.set({ settings }), { uiLanguage: 'en', answerLanguage: 'en' })
  // Fresh installation opens its welcome tab after a one-second delay.
  // Let that tab settle before capture so it cannot steal the active tab.
  await sw.evaluate(async () => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if ((await chrome.tabs.query({})).some(tab => (tab.pendingUrl || tab.url || '').includes('/welcome/'))) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('The fresh-install welcome tab did not appear before capture.')
  })
  const page = await ctx.newPage()
  await page.goto(`${origin}/demo`)
  await page.bringToFront()
  const extensionPrefix = `chrome-extension://${extensionId}/`
  const extensionFrameNavigation = page.waitForEvent('framenavigated', frame => frame.url().startsWith(extensionPrefix), { timeout: 15_000 }).catch(() => undefined)
  const browserCdp = await ctx.browser().newBrowserCDPSession()
  const { targetInfos } = await browserCdp.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }, { exclude: true }],
  })
  const target = targetInfos.find(info => info.type === 'tab' && info.url === page.url())
  if (!target) throw new Error(`Preview could not find the browser tab for ${page.url()}`)
  await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId })
  await page.waitForSelector('[data-study-buddy="overlay"]')
  const problem = await page.locator('[data-demo-problem]').boundingBox()
  if (!problem) throw new Error('The demonstration exercise is not visible.')
  await page.mouse.move(problem.x + 2, problem.y + 2)
  await page.mouse.down()
  await page.mouse.move(problem.x + problem.width - 2, problem.y + problem.height - 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  let chatFrame = page.frames().find(frame => frame.url().startsWith(extensionPrefix))
  if (!chatFrame) {
    await extensionFrameNavigation
    chatFrame = page.frames().find(frame => frame.url().startsWith(extensionPrefix))
  }
  if (!chatFrame) throw new Error('Preview did not create the embedded Study Buddy chat frame.')
  const cropDeadline = Date.now() + 15_000
  let cropReady = false
  while (Date.now() < cropDeadline && !cropReady) {
    // The overlay can replace its extension iframe while capture handoff is
    // still settling. Reacquire the live frame if that navigation detached it.
    chatFrame = page.frames().find(frame => frame.url().startsWith(extensionPrefix))
    if (!chatFrame) {
      await new Promise(resolve => setTimeout(resolve, 50))
      continue
    }
    try {
      await chatFrame.waitForFunction(() => {
        const crop = document.querySelector('.turn-image')
        return !!crop?.naturalWidth && !!crop.naturalHeight
      }, null, { timeout: Math.min(1000, cropDeadline - Date.now()) })
      cropReady = true
    } catch (error) {
      if (!chatFrame.isDetached()) throw error
    }
  }
  if (!cropReady) throw new Error('Preview did not finish loading the captured image.')
  const cropSize = await chatFrame.locator('.turn-image').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }))
  if (cropSize.width < 4 || cropSize.height < 4) throw new Error('Preview capture produced an empty crop.')
  captureReady = true
  writeFileSync(stateFile, JSON.stringify({ origin, gatewayUrl, token, pid: process.pid, runDir, mode: 'localhost backend and fake upstream only' }, null, 2))
  console.log(`READY ${origin} · demo ${origin}/demo · captured crop ${cropSize.width}×${cropSize.height}px · isolated profile ${runDir}/profile`)
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
  ctx.once('close', () => { if (stopping) return; stopping = true; void backend?.close(); void vite?.close(); gatewayProxy?.close(); if (server.listening) server.close() })
  if (smoke) {
    await chatFrame.click('[data-preset="hint"]')
    await chatFrame.waitForFunction(() =>
      document.querySelector('.msg.assistant')?.textContent.includes('Differentiate') &&
      ![...document.querySelectorAll('.reply-status')].some(node => node.textContent.includes('Complete')),
    )
    const waitForAnswer = () => chatFrame.waitForFunction(() =>
      [...document.querySelectorAll('.reply-status')].some(node => node.textContent.includes('Complete')) &&
      document.querySelector('.msg.assistant')?.textContent.includes('partial fractions'),
    )
    await waitForAnswer()
    if (requests !== 1) throw new Error(`Preview expected one upstream request; received ${requests}.`)
    // A fresh document must restore the completed answer from local storage.
    await chatFrame.goto(chatFrame.url())
    await waitForAnswer()
    if (requests !== 1) throw new Error('Reload unexpectedly started another upstream request.')
    await chatFrame.click('#lang-btn')
    await chatFrame.click('[data-lang="de"]')
    await chatFrame.waitForFunction(() => document.querySelector('#lang-btn .tb-code')?.textContent === 'DE')
    await chatFrame.click('#lang-btn')
    await chatFrame.click('[data-lang="en"]')
    await chatFrame.waitForFunction(() => document.querySelector('#lang-btn .tb-code')?.textContent === 'EN')
    await chatFrame.click('#history-btn')
    await chatFrame.waitForSelector('.history-open')
    if (await chatFrame.locator('.history-open').count() !== 1) throw new Error('Preview history must contain exactly one conversation.')
    await chatFrame.click('.history-open')
    await waitForAnswer()

    // Reuse the existing regression harness technique for closed-shadow controls.
    const cdp = await ctx.newCDPSession(page)
    const clickHostButton = async label => {
      const { root: documentNode } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
      const find = node => {
        const attrs = node.attributes ?? []
        if (node.nodeName === 'BUTTON' && ['aria-label', 'title'].some(name => {
          const index = attrs.indexOf(name)
          return index >= 0 && attrs[index + 1].startsWith(label)
        })) return node
        for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
          const found = find(child)
          if (found) return found
        }
      }
      const node = find(documentNode)
      if (!node) throw new Error(`Missing rendered host control: ${label}`)
      const { model } = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId })
      await page.mouse.click((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2)
    }
    await clickHostButton('Minimize')
    await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'minimized')
    await clickHostButton('Restore Study Buddy')
    await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'open')
    const screenshotText = await page.locator('body').innerText() + await chatFrame.locator('body').innerText()
    if (/[\u0400-\u04ff]/u.test(screenshotText)) throw new Error('The portfolio screenshot contains Cyrillic text.')
    if (await chatFrame.locator('.katex').count() < 2) throw new Error('The demonstration answer must render its mathematical formulas.')
    await page.screenshot({ path: join(runDir, 'demo.png') })

    const narrow = await ctx.newPage()
    await narrow.setViewportSize({ width: 320, height: 568 })
    await narrow.goto(chatFrame.url())
    await narrow.waitForSelector('.msg.assistant')
    const layout = await narrow.evaluate(() => {
      const composer = document.querySelector('#composer').getBoundingClientRect()
      return { overflow: document.documentElement.scrollWidth > innerWidth,
        composerVisible: composer.width > 0 && composer.bottom <= innerHeight,
        taskCount: document.querySelectorAll('.preset').length }
    })
    if (layout.overflow || !layout.composerVisible || layout.taskCount !== 6) throw new Error(`Narrow layout failed: ${JSON.stringify(layout)}`)
    await narrow.screenshot({ path: join(runDir, 'narrow.png') })
    await narrow.close()
    await clickHostButton('Close and save')
    await page.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
    const saved = await ctx.newPage()
    await saved.goto(`${extensionPrefix}src/chat/chat.html?kind=history`)
    await saved.waitForSelector('.history-open')
    await saved.click('.history-open')
    await saved.waitForFunction(() => document.querySelector('.msg.assistant')?.textContent.includes('partial fractions'))
    await saved.close()
    await cdp.detach()
    if (requests !== 1) throw new Error('UI-only actions unexpectedly started another provider request.')
    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join('; ')}`)
    if (JSON.stringify(inventory(dist)) !== JSON.stringify(extensionFiles)) throw new Error('The supplied extension artifact changed during verification.')
    writeFileSync(join(runDir, 'smoke.json'), JSON.stringify({
      browser: 'isolated Chromium', chromiumVersion: ctx.browser().version(), viewport: page.viewportSize(), mockOnly: true,
      suppliedBuild: !!suppliedDist, extensionDirectory: dist, extensionSha256, extensionFiles, compiledGatewayUrl,
      captured: cropSize, upstreamRequests: requests, observedPartialAnswer: true, restoredAfterReload: true,
      languagePicker: true, history: true, minimizeRestore: true, closePreservesHistory: true, narrowLayout: layout, pageErrors,
    }, null, 2))
    console.log(`SMOKE OK: capture → backend → streamed Hint → reload; evidence ${runDir}`)
    await stop()
  } else {
    await new Promise(resolve => server.once('close', resolve))
  }
} catch (err) {
  const fixturePage = ctx?.pages().find(page => page.url() === `${origin}/demo`)
  await fixturePage?.screenshot({ path: join(runDir, 'failure.png') }).catch(() => {})
  await stop()
  throw err
}
