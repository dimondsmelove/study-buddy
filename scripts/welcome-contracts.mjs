import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import vm from 'node:vm'
import ts from 'typescript'
import { createWelcomeInstallUrl, getPinnedState } from '../src/shared/welcome-pin.ts'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const welcome = join(root, 'welcome')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'study-buddy-welcome-contracts-'))
const extensionDirectory = join(temporaryDirectory, 'extension')
const activeProfiles = new Set()
let mockBrowser
let server

function mimeType(file) {
  return ({
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  })[extname(file)] ?? 'text/html'
}

async function startWelcomeServer() {
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path === '/welcome/other') {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><title>Wrong path fixture</title>')
      return
    }
    const file = join(welcome, path === '/welcome/' ? 'index.html' : path.slice('/welcome/'.length))
    try {
      response.setHeader('content-type', mimeType(file))
      response.end(readFileSync(file))
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + server.address().port
}

async function openMockPage(origin, query = '', hash = '') {
  const page = await mockBrowser.newPage()
  await page.addInitScript(() => {
    window.mockState = { requests: 0, callbacks: [], activeIntervals: 0, intervalStarts: 0 }
    const nativeSetInterval = window.setInterval.bind(window)
    const nativeClearInterval = window.clearInterval.bind(window)
    window.setInterval = (...args) => {
      window.mockState.activeIntervals++
      window.mockState.intervalStarts++
      const id = nativeSetInterval(...args)
      return id
    }
    window.clearInterval = id => {
      window.mockState.activeIntervals = Math.max(0, window.mockState.activeIntervals - 1)
      return nativeClearInterval(id)
    }
    window.chrome = { runtime: {
      lastError: null,
      sendMessage(_id, _message, callback) {
        window.mockState.requests++
        window.mockState.callbacks.push(callback)
      },
    } }
  })
  await page.goto(origin + '/welcome/' + query + hash)
  return page
}

function createInstallHarness(actionApi) {
  const worker = readFileSync(join(root, 'src/background/service-worker.ts'), 'utf8')
  const installListener = worker.match(/chrome\.runtime\.onInstalled\.addListener\(\(\{ reason \}\) => \{[\s\S]*?\n\}\)/)?.[0]
  const openWelcome = worker.match(/async function openWelcomePage\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0]
  assert.ok(installListener && openWelcome, 'install handler and welcome opener should be present')
  const executable = ts.transpileModule(openWelcome + '\n' + installListener, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const timers = []
  const openedTabs = []
  let onInstalled
  const context = {
    __SB_WELCOME_URL__: 'https://studybuddyai.one/welcome/',
    HISTORY_MENU_ID: 'study-buddy-show-history',
    chrome: {
      action: actionApi,
      runtime: {
        id: 'a'.repeat(32),
        onInstalled: { addListener(listener) { onInstalled = listener } },
      },
      tabs: { create: async ({ url }) => { openedTabs.push(url) } },
      contextMenus: {
        removeAll(callback) { callback() },
        create() {},
      },
    },
    bootstrapTabs: async () => {},
    createWelcomeInstallUrl,
    getPinnedState,
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length },
    console: { warn() {} },
    URL,
    Promise,
  }
  vm.runInNewContext(executable, context)
  return { onInstalled, timers, openedTabs }
}

async function checkInstallWorkerBehavior() {
  for (const reason of ['update', 'chrome_update']) {
    const harness = createInstallHarness({ getUserSettings: async () => ({ isOnToolbar: true }) })
    harness.onInstalled({ reason })
    assert.equal(harness.timers.length, 0, reason + ' must not schedule welcome')
    assert.deepEqual(harness.openedTabs, [])
  }

  for (const [settings, pinnedHint] of [
    [{ isOnToolbar: true }, '1'],
    [{ isOnToolbar: false }, '0'],
    [{ isOnToolbar: 'yes' }, null],
  ]) {
    const harness = createInstallHarness({ getUserSettings: async () => settings })
    harness.onInstalled({ reason: 'install' })
    assert.equal(harness.timers.length, 1)
    assert.equal(harness.timers[0].delay, 1000)
    assert.deepEqual(harness.openedTabs, [])
    harness.timers[0].callback()
    await new Promise(resolve => setImmediate(resolve))
    const url = new URL(harness.openedTabs[0])
    assert.equal(url.searchParams.get('id'), 'a'.repeat(32))
    assert.equal(url.searchParams.get('pinned'), pinnedHint)
  }
}

async function checkWorkerStateHelper() {
  assert.equal(await getPinnedState({ getUserSettings: async () => ({ isOnToolbar: true }) }), true)
  assert.equal(await getPinnedState({ getUserSettings: async () => ({ isOnToolbar: false }) }), false)
  assert.equal(await getPinnedState({ getUserSettings: async () => ({ isOnToolbar: 'true' }) }), null)
  assert.equal(await getPinnedState({ getUserSettings: async () => ({}) }), null)
  assert.equal(await getPinnedState({}), null)
  assert.equal(await getPinnedState(undefined), null)
  assert.equal(await getPinnedState({ getUserSettings: async () => { throw new Error('API failure') } }), null)
  assert.equal(await getPinnedState({ getUserSettings: () => Promise.reject(new Error('API rejection')) }), null)

  for (const [pinned, expected] of [[true, '1'], [false, '0'], [null, null]]) {
    const url = new URL(createWelcomeInstallUrl('https://studybuddyai.one/welcome/', 'a'.repeat(32), pinned))
    assert.equal(url.searchParams.get('id'), 'a'.repeat(32))
    assert.equal(url.searchParams.get('pinned'), expected)
  }
}

async function checkWelcomePageMocks(origin) {
  mockBrowser = await chromium.launch({ headless: true })

  const hashPage = await openMockPage(origin, '?id=' + 'a'.repeat(32) + '&pinned=0', '#usage')
  assert.equal(await hashPage.locator('body').getAttribute('data-mode'), 'usage')
  assert.equal(await hashPage.locator('#page-title').textContent(), 'Study Buddy is ready')
  assert.equal(await hashPage.locator('#pin').evaluate(element => getComputedStyle(element).display), 'none')
  assert.equal(await hashPage.locator('.usage-mode-link').isVisible(), true)
  assert.equal(await hashPage.locator('.pin-mode-link').isVisible(), false)
  assert.equal(await hashPage.evaluate(() => mockState.requests), 0)
  assert.equal(await hashPage.evaluate(() => mockState.intervalStarts), 0)

  const manualPage = await openMockPage(origin, '?id=' + 'a'.repeat(32) + '&pinned=1')
  await manualPage.locator('[data-switch="pin"]').click()
  await manualPage.evaluate(() => mockState.callbacks.shift()({ pinned: true }))
  await manualPage.waitForTimeout(1650)
  assert.equal(await manualPage.locator('body').getAttribute('data-mode'), 'pin', 'late live reply must not override manual choice')
  assert.equal(await manualPage.evaluate(() => mockState.requests), 1)
  assert.equal(await manualPage.evaluate(() => mockState.activeIntervals), 0)
  assert.equal(new URL(manualPage.url()).hash, '#pin')

  const pollingPage = await openMockPage(origin, '?id=' + 'f'.repeat(32) + '&pinned=0')
  await pollingPage.evaluate(() => mockState.callbacks.shift()({ pinned: false }))
  await pollingPage.locator('[data-switch="usage"]').click()
  await pollingPage.waitForTimeout(1650)
  assert.equal(await pollingPage.evaluate(() => mockState.requests), 1, 'manual choice must stop future requests')

  for (const [hint, live, expected] of [[false, true, 'usage'], [true, false, 'pin']]) {
    const page = await openMockPage(origin, '?id=' + 'b'.repeat(32) + '&pinned=' + (hint ? '1' : '0'))
    await page.evaluate(value => mockState.callbacks.shift()({ pinned: value }), live)
    assert.equal(await page.locator('body').getAttribute('data-mode'), expected, 'live boolean must override opposite URL hint')
    await page.waitForTimeout(1550)
    await page.evaluate(() => mockState.callbacks.shift()({ pinned: null }))
    assert.equal(await page.locator('body').getAttribute('data-mode'), expected, 'null must preserve the previous live state')
  }

  const malformedPage = await openMockPage(origin, '?id=' + 'c'.repeat(32) + '&pinned=1')
  await malformedPage.evaluate(() => mockState.callbacks.shift()({ pinned: 'yes' }))
  assert.equal(await malformedPage.locator('body').getAttribute('data-mode'), 'usage', 'malformed response must preserve the URL hint')

  for (const [query, expectedMode] of [['', 'pin'], ['?id=invalid&pinned=1', 'usage']]) {
    const page = await openMockPage(origin, query)
    assert.equal(await page.evaluate(() => mockState.requests), 0, 'missing or invalid ID must not message another extension')
    assert.equal(await page.evaluate(() => mockState.intervalStarts), 0, 'unreachable startup must not leave an interval')
    assert.equal(await page.locator('body').getAttribute('data-mode'), expectedMode, 'invalid IDs must retain a valid URL hint')
  }

  const noRuntime = await mockBrowser.newPage()
  await noRuntime.addInitScript(() => { window.chrome = undefined })
  await noRuntime.goto(origin + '/welcome/?id=' + 'a'.repeat(32) + '&pinned=1')
  assert.equal(await noRuntime.evaluate(() => document.body.dataset.mode), 'usage')

  const errorPage = await openMockPage(origin, '?id=' + 'd'.repeat(32) + '&pinned=1')
  await errorPage.evaluate(() => {
    window.chrome.runtime.lastError = { message: 'transport failed' }
    mockState.callbacks.shift()({ pinned: false })
  })
  await errorPage.waitForTimeout(1600)
  assert.equal(await errorPage.evaluate(() => mockState.requests), 1, 'lastError must stop polling')
  assert.equal(await errorPage.locator('body').getAttribute('data-mode'), 'usage')

  const overlapPage = await openMockPage(origin, '?id=' + 'f'.repeat(32))
  await overlapPage.waitForTimeout(1650)
  assert.equal(await overlapPage.evaluate(() => mockState.requests), 1, 'polling requests must not overlap')

  const lifecyclePage = await openMockPage(origin, '?id=' + 'e'.repeat(32))
  await lifecyclePage.evaluate(() => mockState.callbacks.shift()({ pinned: null }))
  await lifecyclePage.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await lifecyclePage.waitForTimeout(1600)
  assert.equal(await lifecyclePage.evaluate(() => mockState.requests), 1, 'hidden pages must pause polling')
  await lifecyclePage.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  assert.equal(await lifecyclePage.evaluate(() => mockState.requests), 2, 'returning to visible must recheck immediately')
  await lifecyclePage.evaluate(() => mockState.callbacks.shift()({ pinned: null }))
  await lifecyclePage.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await lifecyclePage.waitForTimeout(1600)
  assert.equal(await lifecyclePage.evaluate(() => mockState.requests), 2, 'pagehide must stop polling')
  await lifecyclePage.evaluate(() => window.dispatchEvent(new Event('pageshow')))
  assert.equal(await lifecyclePage.evaluate(() => mockState.requests), 3, 'pageshow must recheck immediately')
  assert.equal(await lifecyclePage.evaluate(() => mockState.activeIntervals), 1, 'lifecycle must keep one interval')

  const noScriptPage = await mockBrowser.newPage({ javaScriptEnabled: false })
  await noScriptPage.goto(origin + '/welcome/')
  assert.equal(await noScriptPage.locator('#pin').evaluate(element => getComputedStyle(element).display), 'block')
  assert.equal(await noScriptPage.locator('#usage').isVisible(), false, 'new usage guide must stay hidden in pin mode')
  assert.equal(await noScriptPage.locator('#pin-launch').isVisible(), true, 'pin mode includes the original toolbar step 3')
  assert.equal(await noScriptPage.locator('.pin-mode-link a').getAttribute('href'), '#usage')
  assert.equal(await noScriptPage.locator('.usage-mode-link a').getAttribute('href'), '#pin')
  assert.equal(await noScriptPage.locator('.usage-mode-link').evaluate(element => getComputedStyle(element).display), 'none')
  await noScriptPage.locator('.pin-mode-link a').click()
  assert.equal(new URL(noScriptPage.url()).hash, '#usage', 'no-JS anchor remains usable')
  assert.equal(await noScriptPage.locator('#pin').evaluate(element => getComputedStyle(element).display), 'block', 'no-JS hash keeps pin fallback visible')
  assert.equal(await noScriptPage.locator('#usage').isVisible(), false, 'no-JS hash does not show the separate usage guide')
  console.log('Behavioral mocks passed: pin API values and errors, URL hints, manual/hash priority, transport failure, invalid IDs, lifecycle, and no-JS fallback.')
}

async function checkRealExtensionExchange(origin) {
  execFileSync('npm', ['run', 'build', '--', '--outDir', extensionDirectory], {
    cwd: root,
    env: { ...process.env, STUDY_BUDDY_WELCOME_URL: origin + '/welcome/' },
    stdio: 'ignore',
  })
  const profile = join(temporaryDirectory, 'chromium-profile')
  activeProfiles.add(profile)
  const startedAt = Date.now()
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      '--enable-unsafe-extension-debugging',
      '--disable-extensions-except=' + extensionDirectory,
      '--load-extension=' + extensionDirectory,
    ],
  })
  try {
    let worker = context.serviceWorkers()[0]
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 })
    const id = new URL(worker.url()).hostname
    const deadline = Date.now() + 10000
    let welcomePage
    while (Date.now() < deadline) {
      welcomePage = context.pages().find(page => page.url().startsWith(origin + '/welcome/'))
      if (welcomePage) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(welcomePage, 'install should open the configured welcome page')
    await welcomePage.waitForLoadState('domcontentloaded')
    await welcomePage.waitForFunction(() => document.body.dataset.mode === 'pin')
    assert.ok(Date.now() - startedAt >= 900, 'install welcome must wait about one second')
    assert.equal(new URL(welcomePage.url()).searchParams.get('id'), id)
    assert.equal(new URL(welcomePage.url()).searchParams.get('pinned'), '0')
    const live = await welcomePage.evaluate(extensionId => new Promise(resolve => {
      chrome.runtime.sendMessage(extensionId, { type: 'GET_PIN_STATE' }, response => resolve({
        response: response ?? null,
        error: chrome.runtime.lastError?.message ?? null,
      }))
    }), id)
    assert.deepEqual(live, { response: { pinned: false }, error: null })

    const wrongPath = await context.newPage()
    await wrongPath.goto(origin + '/welcome/other')
    assert.equal(new URL(wrongPath.url()).pathname, '/welcome/other')
    assert.equal(await wrongPath.evaluate(() => typeof chrome?.runtime?.sendMessage), 'function')
    const rejected = await wrongPath.evaluate(extensionId => new Promise(resolve => {
      chrome.runtime.sendMessage(extensionId, { type: 'GET_PIN_STATE' }, response => resolve({
        response: response ?? null,
        error: chrome.runtime.lastError?.message ?? null,
      }))
    }), id)
    assert.equal(rejected.response, null, 'external messages from another path must not be answered')
    assert.match(rejected.error ?? '', /message port closed/i)
    console.log('Actual isolated Chromium exchange passed: install delay and URL hint, live GET_PIN_STATE, and wrong-path sender rejection.')
  } finally {
    await context.close()
    activeProfiles.delete(profile)
  }
}

try {
  await checkInstallWorkerBehavior()
  await checkWorkerStateHelper()
  const origin = await startWelcomeServer()
  await checkWelcomePageMocks(origin)
  await checkRealExtensionExchange(origin)
} finally {
  await mockBrowser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  for (const profile of activeProfiles) rmSync(profile, { recursive: true, force: true })
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
