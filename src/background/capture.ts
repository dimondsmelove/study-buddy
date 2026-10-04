// Viewport screenshot guard, extracted from OCR Buddy's fullpage.ts (MIT).
// Chrome captures a WINDOW's active tab, never a tab ID. Latch switches and
// navigation, including switch-away-and-back during the asynchronous screenshot.

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function injectOk(target: chrome.scripting.InjectionTarget): Promise<void> {
  const [res] = await chrome.scripting.executeScript({ target, func: () => true })
  if (!res) throw new Error('Page script injection returned no result (tab closed or navigated).')
}

async function withCaptureTab<T>(
  tabId: number,
  windowId: number,
  run: (capture: () => Promise<string>, check: () => Promise<void>) => Promise<T>,
): Promise<T> {
  let changed = false
  const activated = (info: chrome.tabs.TabActiveInfo) => {
    if (info.windowId === windowId && info.tabId !== tabId) changed = true
  }
  const updated = (id: number, info: chrome.tabs.TabChangeInfo) => {
    if (id === tabId && (info.status === 'loading' || info.url !== undefined)) changed = true
  }
  const removed = (id: number) => {
    if (id === tabId) changed = true
  }
  chrome.tabs.onActivated.addListener(activated)
  chrome.tabs.onUpdated.addListener(updated)
  chrome.tabs.onRemoved.addListener(removed)
  const check = async () => {
    const [active] = await chrome.tabs.query({ active: true, windowId })
    if (changed || active?.id !== tabId) {
      throw new Error('The capture tab changed or navigated. Return to the intended page and try again.')
    }
  }
  const capture = async () => {
    for (let attempt = 0; ; attempt++) {
      await check()
      try {
        const pixels = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
        await check() // Discard pixels if Chrome captured during a tab switch.
        return pixels
      } catch (err) {
        if (attempt !== 0 || !/MAX_CAPTURE|too many|quota/i.test(String(err))) throw err
        await wait(1000) // The next iteration checks identity again before retrying.
      }
    }
  }
  try {
    await check()
    return await run(capture, check)
  } finally {
    chrome.tabs.onActivated.removeListener(activated)
    chrome.tabs.onUpdated.removeListener(updated)
    chrome.tabs.onRemoved.removeListener(removed)
  }
}

/** Shared region/viewport screenshot guard. An overlay supplies its document ID
 *  so a late selection or permission retry cannot capture a replacement page. */
export async function captureTab(tabId: number, windowId: number, documentId?: string): Promise<string> {
  return withCaptureTab(tabId, windowId, async (capture) => {
    if (documentId) await injectOk({ tabId, documentIds: [documentId] })
    return capture()
  })
}
