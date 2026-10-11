// Isolated local acceptance browser + mock provider. Never reads credentials.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const stateDir = join(root, 'review', 'preview')
const stateFile = join(stateDir, 'state.json')
const dist = join(root, 'dist')
const command = process.argv[2] ?? 'start'
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
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
if (manifest.host_permissions?.length || manifest.permissions?.includes('<all_urls>')) {
  throw new Error('Preview requires the original narrow manifest without persistent host permissions.')
}
const token = randomUUID()
let ctx
let stopping = false
let requests = 0
let origin
let captureReady = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await ctx?.close()
  server.close()
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
    res.end(JSON.stringify({ ok: !stopping && !!ctx && captureReady, browser: 'agent-owned Chromium', captured: captureReady, requests, mockOnly: true, pid: process.pid }))
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
    req.on('data', chunk => { body += chunk; if (body.length > 16 * 1024 * 1024) req.destroy() })
    req.on('end', () => {
      let request
      try { request = JSON.parse(body) } catch { res.writeHead(400); res.end(); return }
      requests++
      const ru = request.messages?.[0]?.content?.includes('# Опора на изображение')
      const hint = request.max_tokens === 512
      const check = request.max_tokens === 1024
      const text = ru
        ? hint ? 'Начни с вычитания 6 из обеих частей равенства. Какое равенство получится?' : check ? 'Первый неверный переход — раскрытие скобок: множитель 2 относится к обоим слагаемым. Проверь произведение 2 · 3.' : 'Демонстрационный ответ локального mock. Реальная модель не вызывается.'
        : hint ? 'Start by subtracting 6 from both sides. What equation do you get?' : check ? 'The first incorrect step is distributing the brackets: 2 multiplies both terms. Check 2 × 3.' : 'Local mock demonstration. No real model is called.'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunks = text.match(/.{1,12}/gu) ?? []
      const timer = setInterval(() => {
        const chunk = chunks.shift()
        if (chunk !== undefined) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
        else { clearInterval(timer); res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') }
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
  res.end(req.url === '/demo' ? demo : `<!doctype html><meta charset="utf-8"><title>Study Buddy · приёмка</title><style>body{font:16px system-ui;margin:30px;background:#eef1f5}a{color:#1457ad}main{display:flex;gap:20px;flex-wrap:wrap}figure{margin:0}img{width:300px;max-height:470px;object-fit:contain;object-position:top;background:white}figcaption{padding:10px}</style><h1>Study Buddy · локальный loop</h1><p>Runtime-скриншоты реального расширения с локальным mock. <a href="/demo">Демо-страница</a> · <a href="/healthz">Health</a></p><p>Живой тест — в отдельном Chromium. Исходный main не изменён. Серверного анти-abuse и проверки настоящего AI здесь нет.</p><main>${screenshots.map(name => `<figure><a href="/${name}.png"><img src="/${name}.png" alt="${name}"></a><figcaption>${name}</figcaption></figure>`).join('')}</main>`)
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
    return ['http:', 'https:'].includes(url.protocol) && url.origin !== origin ? route.abort() : route.continue()
  })
  let [sw] = ctx.serviceWorkers()
  if (!sw) sw = await ctx.waitForEvent('serviceworker')
  await sw.evaluate(settings => chrome.storage.local.set({ settings }), { provider: 'custom', baseUrl: `${origin}/v1`, apiKey: 'mock-preview-only', uiLanguage: 'ru', answerLanguage: 'auto' })
  const page = await ctx.newPage()
  await page.goto(`${origin}/demo`)
  await page.bringToFront()
  const extensionId = new URL(sw.url()).hostname
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
  writeFileSync(stateFile, JSON.stringify({ origin, token, pid: process.pid, runDir, mode: 'localhost mock only' }, null, 2))
  console.log(`READY ${origin} · demo ${origin}/demo · captured crop ${cropSize.width}×${cropSize.height}px · isolated profile ${runDir}/profile`)
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
  ctx.once('close', () => { stopping = true; server.close() })
  await new Promise(resolve => server.once('close', resolve))
} catch (err) {
  await stop()
  throw err
}
