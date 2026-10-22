import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createViteServer } from 'vite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(import.meta.url), '..', '..')
const profile = mkdtempSync(join(tmpdir(), 'study-buddy-overlay-click-'))
const dist = join(profile, 'extension')
const portProbe = createNetServer()
await new Promise((resolve, reject) => portProbe.listen(0, '127.0.0.1', resolve).once('error', reject))
const gatewayPort = portProbe.address().port
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()))
const pageHtml = `<!doctype html><meta charset="utf-8"><title>overlay click fixture</title>
<style>
body{margin:0;font:22px system-ui}#capture-proof{position:fixed;left:220px;top:230px;width:140px;height:90px;background:#138740}
#underlay-target{position:fixed;left:20px;bottom:20px;width:180px;height:52px}
</style>
<body><p style="padding:40px">homework text 12345</p><div id="capture-proof"></div>
<button id="underlay-target">Click the page beneath the panel</button>
<script>window.hostClickCount=0;document.addEventListener('click',()=>window.hostClickCount++)</script></body>`
let requestCount = 0
let responseMode = 'stream'
const upstream = createServer((req, res) => {
  if (req.url?.includes('/chat/completions')) {
    requestCount++
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try { JSON.parse(body) } catch { res.writeHead(400).end(); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunks = [
        '[[STUDY_BUDDY_TITLE]]Outside click\n',
        'The first streamed section ',
        'continues while the panel is hidden. ',
        'The final section is saved.',
      ]
      if (responseMode === 'stream') {
        const send = () => {
          const content = chunks.shift()
          if (content !== undefined) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
          else {
            clearInterval(timer)
            res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":12,"cost":0.0001}}\n\ndata: [DONE]\n\n')
          }
        }
        const timer = setInterval(send, 350)
        send()
        res.on('close', () => clearInterval(timer))
      }
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(pageHtml)
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${upstream.address().port}`
let ctx
let browser
let browserProcess
let backend
let vite
try {
  if (process.env.SB_HEADED !== '1') throw new Error('Tab visibility acceptance requires SB_HEADED=1 and an isolated headed display')
  execFileSync('npm', ['run', 'build', '--', '--outDir', dist], {
    cwd: repo,
    env: { ...process.env, STUDY_BUDDY_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}` },
    stdio: 'inherit',
  })
  const executablePath = process.env.SB_BROWSER_EXECUTABLE || chromium.executablePath()
  browserProcess = spawn(executablePath, [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-component-extensions-with-background-pages',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging',
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
  ], { stdio: 'ignore' })
  const activePortFile = join(profile, 'DevToolsActivePort')
  const debugDeadline = Date.now() + 10_000
  while (!existsSync(activePortFile) && Date.now() < debugDeadline && browserProcess.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!existsSync(activePortFile)) throw new Error('Isolated headed Chromium did not expose its DevTools endpoint')
  const [debugPort] = readFileSync(activePortFile, 'utf8').split('\n')
  // Playwright's defaults force background documents visible; connect without them to test native tab visibility.
  browser = await chromium.connectOverCDP({ endpointURL: `http://127.0.0.1:${debugPort}`, noDefaults: true })
  ctx = browser.contexts()[0]
  if (!ctx) throw new Error('Isolated Chromium did not create its default browser context')
  await ctx.route('https://**/*', route => route.abort())
  let sw = ctx.serviceWorkers().find(worker => worker.url().endsWith('/service-worker-loader.js'))
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10_000, predicate: worker => worker.url().endsWith('/service-worker-loader.js') })
  const extensionRuntime = await sw.evaluate(async () => {
    const deadline = Date.now() + 5_000
    while ((!globalThis.chrome?.runtime?.id || !globalThis.chrome?.storage?.local) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return { href: self.location.href, runtimeId: globalThis.chrome?.runtime?.id, hasStorage: Boolean(globalThis.chrome?.storage?.local) }
  })
  if (!extensionRuntime.runtimeId || !extensionRuntime.hasStorage) throw new Error('Extension APIs did not initialize in its service worker')
  const extensionId = new URL(sw.url()).hostname
  vite = await createViteServer({ configFile: false, root: repo, appType: 'custom', server: { middlewareMode: true } })
  const [{ createBackend }, { loadBackendConfig }] = await Promise.all([
    vite.ssrLoadModule('/src/backend/app.ts'),
    vite.ssrLoadModule('/src/backend/config.ts'),
  ])
  backend = createBackend(loadBackendConfig({
    OPENROUTER_API_KEY: 'FAKE_PROVIDER_KEY',
    SESSION_HMAC_SECRET: 'overlay-click-fixture-session-secret-0123456789',
    HOST: '127.0.0.1',
    PORT: String(gatewayPort),
    DATABASE_PATH: join(profile, 'gateway.sqlite'),
    ALLOWED_ORIGINS: `chrome-extension://${extensionId}`,
  }), { providerBaseUrl: origin, log: () => {} })
  await new Promise((resolve, reject) => backend.server.listen(gatewayPort, '127.0.0.1', error => error ? reject(error) : resolve()))

  const [page] = await Promise.all([ctx.newPage()])
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(origin + '/tab-a')
  const otherPage = await ctx.newPage()
  await otherPage.setViewportSize({ width: 1280, height: 800 })
  await otherPage.goto(origin.replace('127.0.0.1', 'localhost') + '/tab-b')
  await sw.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'en', answerLanguage: 'auto' } }))
  const hostPages = [page, otherPage]
  const activate = async targetPage => {
    const tabId = await sw.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, targetPage.url())
    if (tabId === undefined) throw new Error('Could not find native tab for ' + targetPage.url())
    await sw.evaluate(id => chrome.tabs.update(id, { active: true }), tabId)
    await targetPage.waitForFunction(() => document.visibilityState === 'visible')
    await Promise.all(hostPages.filter(item => item !== targetPage).map(item => item.waitForFunction(() => document.visibilityState === 'hidden')))
  }
  await activate(page)
  await otherPage.waitForFunction(() => document.visibilityState === 'hidden')
  if (await page.locator('[data-study-buddy="launcher"]').count() || await otherPage.locator('[data-study-buddy="launcher"]').count()) throw new Error('A launcher appeared before the chat was opened')
  const browserCdp = await ctx.browser().newBrowserCDPSession()
  const triggerAction = async () => {
    await activate(page)
    const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] })
    const target = targetInfos.find(item => item.type === 'tab' && item.url === page.url())
    if (!target) throw new Error('Target host tab was not found')
    await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId })
  }
  const getChatFrameOn = targetPage => targetPage.frames().find(frame => frame.url().includes('/src/chat/chat.html'))
  const waitForChatFrameOn = async targetPage => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const frame = getChatFrameOn(targetPage)
      if (frame) return frame
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return undefined
  }
  const getChatFrame = () => getChatFrameOn(page)
  const cdp = await ctx.newCDPSession(page)
  const findHostNode = async (targetCdp, styleToken) => {
    const { root } = await targetCdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const find = node => {
      const styleIndex = node.attributes?.indexOf('style') ?? -1
      const style = styleIndex < 0 ? '' : node.attributes[styleIndex + 1]
      if (node.nodeName === 'DIV' && style.includes(styleToken)) return node
      for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
        const found = find(child)
        if (found) return found
      }
    }
    return find(root)
  }
  const hostRect = async (targetCdp, styleToken) => {
    const node = await findHostNode(targetCdp, styleToken)
    if (!node) {
      throw new Error('Host panel node missing for ' + styleToken)
    }
    const { model } = await targetCdp.send('DOM.getBoxModel', { nodeId: node.nodeId })
    return {
      x: Math.round(model.border[0]),
      y: Math.round(model.border[1]),
      w: Math.round(model.border[4] - model.border[0]),
      h: Math.round(model.border[5] - model.border[1]),
    }
  }
  const waitForHostRect = async (targetCdp, styleToken, expected) => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const actual = await hostRect(targetCdp, styleToken)
      if (actual.x === expected.x && actual.y === expected.y && actual.w === expected.w && actual.h === expected.h) return actual
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Host panel geometry did not settle at ' + JSON.stringify(expected) + ': ' + JSON.stringify(await hostRect(targetCdp, styleToken)))
  }
  const dragHostNode = async (targetPage, targetCdp, styleToken, dx, dy) => {
    const node = await findHostNode(targetCdp, styleToken)
    if (!node) throw new Error('Host drag node missing for ' + styleToken)
    const { model } = await targetCdp.send('DOM.getBoxModel', { nodeId: node.nodeId })
    const x = (model.border[0] + model.border[4]) / 2
    const y = (model.border[1] + model.border[5]) / 2
    await targetPage.mouse.move(x, y)
    await targetPage.mouse.down()
    await targetPage.mouse.move(x + dx, y + dy, { steps: 5 })
    await targetPage.mouse.up()
  }
  const readSavedGeometry = () => sw.evaluate(async () => (await chrome.storage.local.get('panel.size'))['panel.size'])
  const waitForSavedGeometry = async expected => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const actual = await readSavedGeometry()
      if (actual && Object.entries(expected).every(([key, value]) => actual[key] === value)) return actual
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Stored panel geometry did not match ' + JSON.stringify(expected) + ': ' + JSON.stringify(await readSavedGeometry()))
  }
  const clickLauncherOn = async (targetPage = page) => {
    const targetCdp = targetPage === page ? cdp : await ctx.newCDPSession(targetPage)
    const { root } = await targetCdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const label = node => {
      const i = node.attributes?.indexOf('aria-label') ?? -1
      return i < 0 ? '' : node.attributes[i + 1]
    }
    const find = node => {
      if (node.nodeName === 'BUTTON' && label(node).startsWith('Restore Study Buddy')) return node
      for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
        const found = find(child)
        if (found) return found
      }
    }
    const button = find(root)
    if (!button) throw new Error('Restore launcher button is missing')
    const { model } = await targetCdp.send('DOM.getBoxModel', { nodeId: button.nodeId })
    await targetPage.mouse.click((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2)
    if (targetPage !== page) await targetCdp.detach()
  }
  const clickLauncher = () => clickLauncherOn(page)
  const clickInsideFrame = async frame => frame.locator('#ask-input').click()
  const assertStateOn = (targetPage, state) => targetPage.waitForFunction(expected =>
    document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === expected, state)
  const assertState = state => assertStateOn(page, state)
  await triggerAction()
  await page.waitForSelector('[data-study-buddy="overlay"]')
  await page.mouse.move(60, 50)
  await page.mouse.down()
  await page.mouse.move(180, 130, { steps: 4 })
  await page.mouse.up()
  await page.waitForSelector('[data-study-buddy="chat"]', { state: 'attached' })
  await assertState('open')
  const frame = getChatFrame()
  if (!frame) throw new Error('Capture did not create the embedded chat frame')
  await frame.waitForSelector('#ask-input')
  await frame.waitForFunction(() => document.querySelector('.turn-image')?.naturalWidth > 0)

  const initialGeometry = await hostRect(cdp, 'flex-direction: column')
  await waitForSavedGeometry(initialGeometry)
  await dragHostNode(page, cdp, 'cursor: move', 340, 90)
  await dragHostNode(page, cdp, 'cursor: nwse-resize', 28, 18)
  const geometryA = await hostRect(cdp, 'flex-direction: column')
  if (geometryA.x !== initialGeometry.x + 340 || geometryA.y !== initialGeometry.y + 90 ||
      geometryA.w <= initialGeometry.w || geometryA.h <= initialGeometry.h) {
    throw new Error('Native source drag/resize did not produce expected geometry: ' + JSON.stringify({ initialGeometry, geometryA }))
  }
  await waitForSavedGeometry(geometryA)

  const clicksBeforeInside = await page.evaluate(() => window.hostClickCount)
  await clickInsideFrame(frame)
  if (await page.locator('[data-study-buddy="chat"]').getAttribute('data-state') !== 'open') throw new Error('Click inside iframe minimized the panel')
  if (await page.evaluate(() => window.hostClickCount) !== clicksBeforeInside) throw new Error('Iframe click leaked to the host page')

  const draft = 'Draft survives outside click'
  await frame.locator('#ask-input').fill(draft)
  const requestsBefore = requestCount
  await page.locator('#underlay-target').click()
  await assertState('minimized')
  await frame.waitForFunction(value => document.querySelector('#ask-input')?.value === value, draft)
  if (await page.evaluate(() => window.hostClickCount) !== clicksBeforeInside + 1) throw new Error('The underlying page click was intercepted')
  if (getChatFrame() !== frame || requestCount !== requestsBefore) throw new Error('Outside click replaced the iframe or started a request')
  await clickLauncher()
  await assertState('open')
  if (getChatFrame() !== frame || await frame.locator('#ask-input').inputValue() !== draft) throw new Error('Restore did not preserve the iframe draft')
  console.log('PASS native drag/resize persisted source panel geometry; inside/outside clicks and draft restoration remain correct')

  responseMode = 'stream'
  await frame.locator('#ask-input').fill('Continue while switching tabs')
  const requestsBeforeStream = requestCount
  await frame.locator('#ask-btn').click()
  const providerDeadline = Date.now() + 5000
  while (requestCount === requestsBeforeStream && Date.now() < providerDeadline) await new Promise(resolve => setTimeout(resolve, 20))
  if (requestCount !== requestsBeforeStream + 1) throw new Error('Expected one mock stream request; before=' + requestsBeforeStream + ', after=' + requestCount)
  await frame.waitForFunction(() => document.querySelector('.msg.assistant .msg-body')?.textContent?.length > 5)
  const streamingRequestCount = requestCount

  await activate(otherPage)
  await page.waitForFunction(() => document.visibilityState === 'hidden')
  await assertState('minimized')
  await otherPage.waitForSelector('[data-study-buddy="launcher"]', { state: 'attached' })

  const latePage = await ctx.newPage()
  hostPages.push(latePage)
  await latePage.setViewportSize({ width: 1280, height: 800 })
  await latePage.goto(origin + '/tab-c')
  await latePage.waitForSelector('[data-study-buddy="launcher"]', { state: 'attached' })
  await activate(otherPage)
  await clickLauncherOn(otherPage)
  await assertStateOn(otherPage, 'open')
  const otherFrame = await waitForChatFrameOn(otherPage)
  if (!otherFrame) throw new Error('The destination launcher did not restore the shared chat')
  await otherFrame.waitForSelector('#ask-input')
  const otherCdp = await ctx.newCDPSession(otherPage)
  const geometryOnB = await hostRect(otherCdp, 'flex-direction: column')
  if (JSON.stringify(geometryOnB) !== JSON.stringify(geometryA)) {
    throw new Error('Restoring on tab B did not reuse preferred geometry: ' + JSON.stringify({ geometryA, geometryOnB }))
  }
  await otherFrame.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent.includes('Complete'), undefined, { timeout: 10_000 })
  const otherConversationId = new URL(otherFrame.url()).searchParams.get('conversation')
  const sourceConversationId = new URL(frame.url()).searchParams.get('conversation')
  if (!otherConversationId || otherConversationId !== sourceConversationId) throw new Error('Destination restored a different conversation')
  if (requestCount !== streamingRequestCount) throw new Error('Restoring the destination started another provider request')

  await dragHostNode(otherPage, otherCdp, 'cursor: move', -100, 20)
  await dragHostNode(otherPage, otherCdp, 'cursor: nwse-resize', -20, 10)
  const geometryB = await hostRect(otherCdp, 'flex-direction: column')
  if (geometryB.x !== geometryOnB.x - 100 || geometryB.y !== geometryOnB.y + 20 ||
      geometryB.w >= geometryOnB.w || geometryB.h <= geometryOnB.h) {
    throw new Error('Native destination drag/resize did not update geometry: ' + JSON.stringify({ geometryOnB, geometryB }))
  }
  await waitForSavedGeometry(geometryB)

  await latePage.setViewportSize({ width: 320, height: 324 })
  await activate(latePage)
  await otherPage.waitForFunction(() => document.visibilityState === 'hidden')
  await clickLauncherOn(latePage)
  await assertStateOn(latePage, 'open')
  const lateCdp = await ctx.newCDPSession(latePage)
  const compactGeometry = await hostRect(lateCdp, 'flex-direction: column')
  if (compactGeometry.w > 304 || compactGeometry.h > 308 || compactGeometry.x < 8 || compactGeometry.y < 8 ||
      compactGeometry.x + compactGeometry.w > 312 || compactGeometry.y + compactGeometry.h > 316) {
    throw new Error('Preferred geometry was not clamped into the compact viewport: ' + JSON.stringify(compactGeometry))
  }
  const preferredAfterClamp = await readSavedGeometry()
  if (preferredAfterClamp.x !== geometryB.x || preferredAfterClamp.y !== geometryB.y ||
      preferredAfterClamp.w !== geometryB.w || preferredAfterClamp.h !== geometryB.h) {
    throw new Error('Viewport clamp overwrote preferred geometry: ' + JSON.stringify({ preferredAfterClamp, geometryB }))
  }
  await latePage.setViewportSize({ width: 1280, height: 800 })
  await latePage.waitForFunction(() => innerWidth === 1280 && innerHeight === 800)
  const geometryAfterExpand = await waitForHostRect(lateCdp, 'flex-direction: column', geometryB)
  await lateCdp.detach()

  await activate(page)
  await otherPage.waitForFunction(() => document.visibilityState === 'hidden')
  await assertState('minimized')
  await page.waitForFunction(() => !document.querySelector('[data-study-buddy="launcher"]')?.hidden)
  await clickLauncher()
  await assertState('open')
  if (getChatFrame() !== frame || requestCount !== streamingRequestCount) throw new Error('Returning to the source did not restore its original iframe without another request')
  await frame.waitForFunction(() => [...document.querySelectorAll('.reply-status')].at(-1)?.textContent.includes('Complete'))
  const geometryAfterReturn = await hostRect(cdp, 'flex-direction: column')
  if (JSON.stringify(geometryAfterReturn) !== JSON.stringify(geometryB)) {
    throw new Error('Already-mounted source did not apply destination geometry update: ' + JSON.stringify({ geometryB, geometryAfterReturn }))
  }
  console.log('PASS native geometry follows A→B→A, smaller view clamps without overwriting preference, and one mock stream continues')

  const beforeSelectionRequests = requestCount
  await triggerAction()
  await page.waitForSelector('[data-study-buddy="overlay"]')
  await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'selecting')
  await activate(otherPage)
  await page.waitForFunction(() => document.visibilityState === 'hidden')
  await assertState('selecting')
  await activate(page)
  await page.waitForFunction(() => document.visibilityState === 'visible')
  await page.keyboard.press('Escape')
  await assertState('open')
  if (getChatFrame() !== frame) throw new Error('Escape from selection replaced the chat iframe')

  await triggerAction()
  await page.waitForSelector('[data-study-buddy="overlay"]')
  await page.mouse.move(220, 230)
  await page.mouse.down()
  await page.mouse.move(340, 300, { steps: 4 })
  await page.mouse.up()
  await assertState('open')
  await frame.waitForFunction(() => document.querySelectorAll('.turn-image').length >= 2)
  if (getChatFrame() !== frame || requestCount !== beforeSelectionRequests) throw new Error('Selection drag did not preserve the iframe or started a model request')
  const geometryAfterCapture = await hostRect(cdp, 'flex-direction: column')
  if (JSON.stringify(geometryAfterCapture) !== JSON.stringify(geometryB)) throw new Error('A later capture changed the stored panel position or size')
  console.log('PASS selection Escape and drag preserve the open panel without model requests')

  const { root: hostRoot } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  const labelOf = node => {
    const i = node.attributes?.indexOf('aria-label') ?? -1
    return i < 0 ? '' : node.attributes[i + 1]
  }
  const findClose = node => {
    if (node.nodeName === 'BUTTON' && labelOf(node) === 'Close and save') return node
    for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
      const found = findClose(child)
      if (found) return found
    }
  }
  const closeButton = findClose(hostRoot)
  if (!closeButton) throw new Error('Close button is missing from the open source panel')
  const closeBox = await cdp.send('DOM.getBoxModel', { nodeId: closeButton.nodeId })
  await page.mouse.click((closeBox.model.border[0] + closeBox.model.border[4]) / 2, (closeBox.model.border[1] + closeBox.model.border[5]) / 2)
  await page.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  await otherPage.waitForSelector('[data-study-buddy="chat"]', { state: 'detached' })
  if (await page.locator('[data-study-buddy="launcher"]').count()) throw new Error('Close left a source launcher')

  const lateCleanupCdp = await ctx.newCDPSession(latePage)
  const { root: lateRoot } = await lateCleanupCdp.send('DOM.getDocument', { depth: -1, pierce: true })
  const findLauncher = node => {
    if (node.nodeName === 'BUTTON' && labelOf(node).startsWith('Restore Study Buddy')) return node
    for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) {
      const found = findLauncher(child)
      if (found) return found
    }
  }
  const lateLauncher = findLauncher(lateRoot)
  if (lateLauncher && !lateLauncher.attributes?.includes('hidden')) {
    const lateBox = await lateCleanupCdp.send('DOM.getBoxModel', { nodeId: lateLauncher.nodeId })
    const width = Math.abs(lateBox.model.border[2] - lateBox.model.border[0])
    const height = Math.abs(lateBox.model.border[5] - lateBox.model.border[1])
    if (width || height) throw new Error('Close left a visible launcher on the new tab')
  }
  await lateCleanupCdp.detach()
  console.log('PASS Close removes the shared chat and all visible launchers; fresh tabs had no launcher before a chat')
} finally {
  if (browser) await browser.close()
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    const waitForExit = () => Promise.race([new Promise(resolve => browserProcess.once('exit', () => resolve(true))), new Promise(resolve => setTimeout(() => resolve(false), 2000))])
    browserProcess.kill('SIGTERM')
    let exited = await waitForExit()
    if (!exited) {
      browserProcess.kill('SIGKILL')
      await waitForExit()
    }
  }
  if (backend) await backend.close()
  if (vite) await vite.close()
  await new Promise(resolve => upstream.close(() => resolve()))
  rmSync(profile, { recursive: true, force: true })
}
