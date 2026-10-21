import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { createServer as createViteServer } from 'vite'
import { mkdtempSync, rmSync } from 'node:fs'
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
let backend
let vite
try {
  execFileSync('npm', ['run', 'build', '--', '--outDir', dist], {
    cwd: repo,
    env: { ...process.env, STUDY_BUDDY_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}` },
    stdio: 'inherit',
  })
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  })
  await ctx.route('https://**/*', route => route.abort())
  const [sw] = ctx.serviceWorkers().length ? ctx.serviceWorkers() : [await ctx.waitForEvent('serviceworker')]
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
  await page.goto(origin)
  await sw.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'en', answerLanguage: 'auto' } }))
  const browserCdp = await ctx.browser().newBrowserCDPSession()
  const triggerAction = async () => {
    await page.bringToFront()
    const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] })
    const target = targetInfos.find(item => item.type === 'tab' && item.url === page.url())
    if (!target) throw new Error('Target host tab was not found')
    await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId })
  }
  const getChatFrame = () => page.frames().find(frame => frame.url().startsWith(`chrome-extension://${extensionId}/src/chat/chat.html`))
  const cdp = await ctx.newCDPSession(page)
  const clickLauncher = async () => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
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
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: button.nodeId })
    await page.mouse.click((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2)
  }
  const clickInsideFrame = async frame => frame.locator('#ask-input').click()
  const assertState = state => page.waitForFunction(expected =>
    document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === expected, state)
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
  console.log('PASS inside click stays open; outside click reaches host, minimizes, and restores same iframe and draft')

  responseMode = 'stream'
  await frame.locator('#ask-input').fill('Continue while hidden')
  const requestsBeforeStream = requestCount
  await frame.locator('#ask-btn').click()
  const providerDeadline = Date.now() + 5000
  while (requestCount === requestsBeforeStream && Date.now() < providerDeadline) await new Promise(resolve => setTimeout(resolve, 20))
  if (requestCount !== requestsBeforeStream + 1) throw new Error('Expected one mock stream request; before=' + requestsBeforeStream + ', after=' + requestCount)
  await frame.waitForFunction(() => document.querySelector('.msg.assistant .msg-body')?.textContent?.length > 5)
  const streamingRequestCount = requestCount
  await page.locator('#underlay-target').click()
  await assertState('minimized')
  const streamDeadline = Date.now() + 10_000
  let streamState
  do {
    streamState = await frame.evaluate(() => ({
      status: [...document.querySelectorAll('.reply-status')].at(-1)?.textContent,
      answer: [...document.querySelectorAll('.msg.assistant .msg-body')].at(-1)?.textContent,
      input: document.querySelector('#ask-input')?.value,
    }))
    if (streamState.status?.includes('Complete')) break
    await new Promise(resolve => setTimeout(resolve, 50))
  } while (Date.now() < streamDeadline)
  if (!streamState.status?.includes('Complete')) throw new Error('Stream did not complete while minimized: ' + JSON.stringify(streamState))
  if (requestCount !== streamingRequestCount || getChatFrame() !== frame) throw new Error('Stream completion created a second request or replaced the iframe')
  await clickLauncher()
  await assertState('open')
  console.log('PASS stream continues while minimized with one provider call and the same iframe')

  const beforeSelectionRequests = requestCount
  await triggerAction()
  await page.waitForSelector('[data-study-buddy="overlay"]')
  await page.waitForFunction(() => document.querySelector('[data-study-buddy="chat"]')?.getAttribute('data-state') === 'selecting')
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
  console.log('PASS selection Escape and drag preserve the open panel without model requests')
} finally {
  if (ctx) await ctx.close()
  if (backend) await backend.close()
  if (vite) await vite.close()
  await new Promise(resolve => upstream.close(() => resolve()))
  rmSync(profile, { recursive: true, force: true })
}
