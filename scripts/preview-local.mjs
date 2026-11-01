// Isolated local acceptance browser + mock provider. Never reads credentials.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const stateDir = join(root, 'review', 'preview')
const stateFile = join(stateDir, 'state.json')
const command = process.argv[2] ?? 'start'
const smoke = process.argv.includes('--smoke')
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
const dist = join(runDir, 'dist')
const portProbe = createNetServer()
await new Promise((resolve, reject) => portProbe.listen(0, '127.0.0.1', resolve).once('error', reject))
const gatewayPort = portProbe.address().port
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()))
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`
const buildEnv = { ...process.env, STUDY_BUDDY_GATEWAY_URL: gatewayUrl }
delete buildEnv.OPENROUTER_API_KEY
delete buildEnv.OPENAI_API_KEY
execFileSync('npm', ['run', 'build', '--', '--outDir', dist], { cwd: root, env: buildEnv, stdio: 'inherit' })
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
if (manifest.host_permissions?.length !== 2 || !manifest.host_permissions.includes(`${gatewayUrl}/*`) || !manifest.host_permissions.includes('<all_urls>')) {
  throw new Error('Preview build must use the configured gateway and the production all-sites launcher permissions.')
}
const token = randomUUID()
let ctx
let stopping = false
let requests = 0
let previewPrompts
let origin
let captureReady = false
let backend
let vite
const stop = async () => {
  if (stopping) return
  stopping = true
  await ctx?.close()
  await backend?.close()
  await vite?.close()
  if (server.listening) server.close()
}
const demo = `<!doctype html><meta charset="utf-8"><title>Study Buddy · локальная приёмка</title>
<style>body{font:18px/1.6 system-ui;background:#eef1f5;color:#18181b;margin:0}header{padding:18px;background:#111827;color:white}main{padding:28px}article{background:white;border:1px solid #ddd;border-radius:10px;padding:20px;width:340px}small{font-size:13px}</style>
<header>Study Buddy · изолированный mock, без реального AI и оплаты</header>
<main><article><b>Задача</b><p>2x + 6 = 10</p><b>Попытка ученика</b><p>2(x + 3) = 10<br>2x + 3 = 10</p></article>
<p>Ctrl+Shift+Y или значок расширения: выделить область. Диалог открывается после успешного захвата.</p>
<small>Hint/Check отвечают фиксированной демонстрацией. Это проверка интерфейса, не качества модели. Свернуть: ответ продолжается. Закрыть: ответ сохраняется и останавливается.</small></main>`
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
      const ru = request.messages?.[0]?.content?.includes('Respond in Russian')
      const kind = previewPrompts.classifyPreviewTask(request.messages, previewPrompts)
      const text = ru
        ? kind === 'hint' ? 'Начни с вычитания 6 из обеих частей равенства. Какое равенство получится?' : kind === 'check' ? 'Первый неверный переход — раскрытие скобок: множитель 2 относится к обоим слагаемым. Проверь произведение 2 · 3.' : 'Демонстрационный ответ локального mock. Реальная модель не вызывается.'
        : kind === 'hint' ? 'Start by subtracting 6 from both sides. What equation do you get?' : kind === 'check' ? 'The first incorrect step is distributing the brackets: 2 multiplies both terms. Check 2 × 3.' : 'Local mock demonstration. No real model is called.'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunks = text.match(/.{1,12}/gu) ?? []
      const timer = setInterval(() => {
        const chunk = chunks.shift()
        if (chunk !== undefined) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
        else { clearInterval(timer); res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":2,"cost":0.0001}}\n\ndata: [DONE]\n\n') }
      }, 200)
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
  res.end(req.url === '/demo' ? demo : `<!doctype html><meta charset="utf-8"><title>Study Buddy · приёмка</title><style>body{font:16px system-ui;margin:30px;background:#eef1f5}a{color:#1457ad}main{display:flex;gap:20px;flex-wrap:wrap}figure{margin:0}img{width:300px;max-height:470px;object-fit:contain;object-position:top;background:white}figcaption{padding:10px}</style><h1>Study Buddy · локальный loop</h1><p>Runtime-скриншоты реального расширения с локальным mock. <a href="/demo">Демо-страница</a> · <a href="/healthz">Health</a></p><p>Живой тест — в отдельном Chromium. Локальный backend применяет cooldown и лимиты допуска; ответы идут от HTTP mock, запросов к настоящей модели нет.</p><main>${screenshots.map(name => `<figure><a href="/${name}.png"><img src="/${name}.png" alt="${name}"></a><figcaption>${name}</figcaption></figure>`).join('')}</main>`)
})
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.STUDY_BUDDY_PREVIEW_PORT ?? 4187), '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  ctx = await chromium.launchPersistentContext(join(runDir, 'profile'), {
    channel: 'chromium', headless: process.argv.includes('--headless'), viewport: { width: 1200, height: 800 },
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  })
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url())
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
  await sw.evaluate(settings => chrome.storage.local.set({ settings }), { uiLanguage: smoke ? 'en' : 'ru', answerLanguage: smoke ? 'en' : 'auto' })
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
  await page.mouse.move(50, 130)
  await page.mouse.down()
  await page.mouse.move(360, 200, { steps: 8 })
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
  ctx.once('close', () => { if (stopping) return; stopping = true; void backend?.close(); void vite?.close(); if (server.listening) server.close() })
  if (smoke) {
    await chatFrame.click('[data-preset="hint"]')
    await chatFrame.waitForFunction(() =>
      document.querySelector('.msg.assistant')?.textContent.includes('Start') &&
      ![...document.querySelectorAll('.reply-status')].some(node => node.textContent.includes('Complete')),
    )
    const waitForAnswer = () => chatFrame.waitForFunction(() =>
      [...document.querySelectorAll('.reply-status')].some(node => node.textContent.includes('Complete')) &&
      document.querySelector('.msg.assistant')?.textContent.includes('Start by subtracting 6 from both sides.'),
    )
    await waitForAnswer()
    if (requests !== 1) throw new Error(`Preview expected one upstream request; received ${requests}.`)
    // A fresh document must restore the completed answer from local storage.
    await chatFrame.goto(chatFrame.url())
    await waitForAnswer()
    if (requests !== 1) throw new Error('Reload unexpectedly started another upstream request.')
    await page.screenshot({ path: join(runDir, 'demo.png') })
    writeFileSync(join(runDir, 'smoke.json'), JSON.stringify({
      browser: 'isolated Chromium', viewport: page.viewportSize(), mockOnly: true,
      captured: cropSize, upstreamRequests: requests, observedPartialAnswer: true, restoredAfterReload: true,
    }, null, 2))
    console.log(`SMOKE OK: capture → backend → streamed Hint → reload; evidence ${runDir}`)
    await stop()
  } else {
    await new Promise(resolve => server.once('close', resolve))
  }
} catch (err) {
  await stop()
  throw err
}
