// Service worker = COORDINATOR ONLY (no DOM, no model, no inference).
// Responsibilities:
//   1. Toolbar icon / keyboard shortcut → start region selection on the tab.
//   2. Receive the selected rect → captureVisibleTab → crop on an OffscreenCanvas.
//   3. Keep the crop in chrome.storage.session and tell the tab's overlay to
//      embed the chat window with it (fallback: a detached popup window).

import type { CaptureRequest, ChatState, Message, Rect, StoredCapture } from '../shared/messages'
import { CAPTURE_PREFIX, MAX_KEPT_CAPTURES } from '../shared/messages'
import { restrictedReason } from '../shared/restricted'
import { createWelcomeInstallUrl, getPinnedState } from '../shared/welcome-pin'
import { captureTab } from './capture'
import { captureDialog, closeDialog, installConversationCoordinator, launcherState, restoreDialog } from './conversations'

installConversationCoordinator()

const CHAT_URL = 'src/chat/chat.html'
const FALLBACK_WINDOW_KEY = 'fallbackWindowId'
const HISTORY_MENU_ID = 'study-buddy-show-history'

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') void openWelcomePage()
  void bootstrapTabs()
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) return
    chrome.contextMenus.create({ id: HISTORY_MENU_ID, title: 'Show history', contexts: ['action'] })
  })
})

async function bootstrapTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
  await Promise.allSettled(tabs.filter(tab => tab.id !== undefined && !restrictedReason(tab.url)).map(tab => injectOverlay(tab.id!)))
}

chrome.runtime.onStartup.addListener(() => { void bootstrapTabs() })

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== HISTORY_MENU_ID || tab?.id === undefined) return
  const tabId = tab.id
  entrypoint(() => showHistoryOnTab(tabId), true)
})

chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  let expected: URL
  try { expected = new URL(__SB_WELCOME_URL__) } catch { return false }
  let actual: URL
  try { actual = new URL(sender.url ?? '') } catch { return false }
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || message?.type !== 'GET_PIN_STATE') return false
  void getPinnedState(chrome.action).then(pinned => respond({ pinned }))
  return true
})

async function openWelcomePage(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1000))
  try {
    const pinned = await getPinnedState(chrome.action)
    const url = createWelcomeInstallUrl(__SB_WELCOME_URL__, chrome.runtime.id, pinned)
    await chrome.tabs.create({ url })
  } catch (error) {
    console.warn('Study Buddy welcome page could not be opened:', error)
  }
}

let captureBusy = false

/** Covers selection setup / capture through chat handoff. Never holds a lock
 *  while a user selects. */
function entrypoint(task: () => Promise<void>, exclusive = false): void {
  if (exclusive && captureBusy) return
  if (exclusive) captureBusy = true
  void task()
    .catch((err) => {
      void showError(err instanceof Error ? err.message : String(err))
    })
    .finally(() => {
      if (exclusive) captureBusy = false
    })
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return
  const tabId = tab.id
  entrypoint(() => startSelection(tabId), true)
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'start-capture' || tab?.id === undefined) return
  const tabId = tab.id
  entrypoint(() => startSelection(tabId), true)
})

/** The selection to retry after the user grants per-site permission. Captures
 *  carry their own request; a granted host always leads somewhere: a fresh
 *  selection on the active tab. */
let pendingSelect: { tabId: number } | null = null
let selectionTabId: number | undefined

function selectionUnavailable(tabId: number): void {
  if (selectionTabId !== tabId) return
  selectionTabId = undefined
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' || info.url !== undefined) selectionUnavailable(tabId)
})
chrome.tabs.onRemoved.addListener(selectionUnavailable)

chrome.runtime.onMessage.addListener((msg: Message, sender, respond) => {
  // Extension pages can also live in tabs; only a content script's tab
  // identifies the capture source.
  const contentTab =
    sender.id === chrome.runtime.id && sender.url && !sender.url.startsWith('chrome-extension://')
      ? sender.tab
      : undefined
  if (msg.type === 'LAUNCHER_STATE') {
    if (sender.id !== chrome.runtime.id) return false
    void launcherState(msg.minimized).then(minimized => respond({ minimized }), () => respond({ minimized: false }))
    return true
  } else if (msg.type === 'START_SELECTION') {
    entrypoint(() => startActiveTabSelection(), true)
  } else if (msg.type === 'DIALOG_CLOSED') {
    if (!contentTab?.id || typeof msg.conversationId !== 'string') { respond({ ok: false }); return false }
    void closeDialog(msg.conversationId, contentTab.id).then(() => respond({ ok: true }), () => respond({ ok: false }))
    return true
  } else if (msg.type === 'RESTORE_CHAT') {
    entrypoint(async () => {
      const tab = contentTab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
      if (tab?.id !== undefined) await restoreOnTab(tab.id)
    }, true)
  } else if (msg.type === 'SELECTION_CANCELLED') {
    if (contentTab?.id === selectionTabId) selectionTabId = undefined
  } else if (msg.type === 'CAPTURE_REQUEST') {
    if (contentTab) selectionTabId = undefined
    entrypoint(() => handleCapture(msg, contentTab?.id, contentTab ? sender.documentId : undefined), true)
  } else if (msg.type === 'PERMISSION_GRANTED') {
    // The MV3 service worker can be recycled while the permission prompt is
    // open, dropping in-memory `pendingSelect` — so "Allow" once led nowhere.
    // A granted host always leads somewhere: retry, or select fresh.
    entrypoint(async () => {
      const retry = pendingSelect
      pendingSelect = null
      if (retry) await startSelection(retry.tabId)
      else await startActiveTabSelection()
    }, true)
  }
  return false
})

async function restoreOnTab(tabId: number): Promise<void> {
  const conversation = await restoreDialog()
  if (!conversation) { await startSelection(tabId); return }
  const state: ChatState = { kind: 'conversation', conversationId: conversation.id }
  try { await chrome.tabs.sendMessage(tabId, { type: 'SHOW_CHAT', state }); return } catch { /* inject below */ }
  const tab = await chrome.tabs.get(tabId)
  if (!restrictedReason(tab.url)) {
    try { await injectOverlay(tabId) } catch { /* detached fallback */ }
  }
  await showChatWindow(tabId, state)
}

async function showHistoryOnTab(tabId: number): Promise<void> {
  // The toolbar context-menu gesture grants activeTab. Cancel selection before
  // reusing the same overlay host for history.
  if (selectionTabId === tabId) {
    selectionTabId = undefined
    try { await chrome.tabs.sendMessage(tabId, { type: 'HIDE_OVERLAY' }) } catch { /* host may have navigated */ }
  }
  const state: ChatState = { kind: 'history' }
  try { await chrome.tabs.sendMessage(tabId, { type: 'SHOW_CHAT', state }); return } catch { /* inject below */ }
  const tab = await chrome.tabs.get(tabId)
  if (!restrictedReason(tab.url)) {
    try { await injectOverlay(tabId) } catch { /* detached fallback */ }
    try { await chrome.tabs.sendMessage(tabId, { type: 'SHOW_CHAT', state }); return } catch { /* detached fallback */ }
  }
  await showChatWindow(undefined, state)
}

async function startActiveTabSelection(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) throw new Error('No active tab to select on.')
  await startSelection(tab.id)
}

/** Show the overlay on a tab, injecting it first if the content script is
 *  absent. If we lack host access, tell the user via the chat window. */
async function startSelection(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (!tab || !tab.active) throw new Error('The selection tab is no longer active. Return to it and try again.')
  if (await blockedIfRestricted(tab)) return
  if (await showOverlay(tabId)) return
  try {
    await injectOverlay(tabId) // needs host access (activeTab / granted host)
    if (await showOverlay(tabId)) return
  } catch (err) {
    await showCaptureFailure(tabId, err instanceof Error ? err.message : String(err))
    return
  }
  await showCaptureFailure(tabId, 'Study Buddy could not start region selection on this page.')
}

/** If a page is one Chrome forbids ALL extensions from touching (the Web Store,
 *  chrome:// …), tell the user honestly — no permission can unblock it. */
async function blockedIfRestricted(tab: chrome.tabs.Tab): Promise<boolean> {
  const reason = restrictedReason(tab.url)
  if (!reason || tab.id === undefined) return false
  pendingSelect = null
  await showChatWindow(tab.id, { kind: 'restricted', reason })
  return true
}

/** Tell the overlay (if present) to show; true on success. */
async function showOverlay(tabId: number): Promise<boolean> {
  selectionTabId = tabId
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PREPARE_SELECTION' })
    return true
  } catch {
    // A cancellation/navigation during delivery must not trigger reinjection.
    if (selectionTabId !== tabId) return true
    selectionTabId = undefined
    return false
  }
}

async function injectOverlay(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/overlay.js'] })
}

async function originOf(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId)
    return tab.url ? new URL(tab.url).origin : ''
  } catch {
    return ''
  }
}

async function handleCapture(req: CaptureRequest, tabId?: number, documentId?: string): Promise<void> {
  try {
    const tab =
      tabId === undefined
        ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
        : await chrome.tabs.get(tabId)
    if (!tab || tab.id === undefined || tab.windowId === undefined) {
      throw new Error('The tab to capture is no longer available.')
    }
    if (await blockedIfRestricted(tab)) return
    if (req.origin && tab.url && new URL(tab.url).origin !== req.origin) {
      throw new Error('The capture page changed. Return to the intended page and try again.')
    }
    // captureVisibleTab returns CLEAN composited pixels — taint-free even over
    // cross-origin <video> (inherited from OCR Buddy).
    const fullDataUrl = await captureTab(tab.id, tab.windowId, documentId)
    const cropDataUrl = await cropRegion(fullDataUrl, req)

    const imageId = await storeCapture(cropDataUrl, req.rect)
    const conversation = await captureDialog(imageId)
    await showChatWindow(tab.id, { kind: 'capture', imageId, rect: req.rect, conversationId: conversation.id })
  } catch (err) {
    await showCaptureFailure(tabId, err instanceof Error ? err.message : String(err))
  }
}

async function showError(message: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  await showCaptureFailure(tab?.id, message)
}

async function showCaptureFailure(tabId: number | undefined, message: string): Promise<void> {
  if (tabId === undefined) {
    await showChatWindow(undefined, { kind: 'error', message })
    return
  }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  const restricted = restrictedReason(tab?.url) ?? (isRestrictedFailure(message) || (tab && !tab.url && !isMissingAccessFailure(message)) ? 'browser and extension pages' : null)
  if (restricted) {
    pendingSelect = null
    await showChatWindow(tabId, { kind: 'restricted', reason: restricted })
    return
  }
  if (isMissingAccessFailure(message)) {
    pendingSelect = { tabId }
    await showChatWindow(tabId, { kind: 'permission', origin: await originOf(tabId) })
    return
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_FAILED', message })
  } catch {
    await showChatWindow(tabId, { kind: 'error', message })
  }
}

function isRestrictedFailure(message: string): boolean {
  return /cannot access a chrome|chrome-extension|cannot be scripted|extensions gallery/i.test(message)
}

function isMissingAccessFailure(message: string): boolean {
  return /(?:activeTab|host|site).{0,60}permission.{0,40}(?:required|missing)|permission.{0,40}(?:required|missing)|does not have permission to access|cannot access contents/i.test(message)
}

/** Keep the crop in session storage (RAM-backed, never touches disk) and prune
 *  all but the most recent few. Returns the id the chat window will load. */
async function storeCapture(dataUrl: string, rect: Rect): Promise<string> {
  const imageId = crypto.randomUUID()
  await chrome.storage.session.set({ [CAPTURE_PREFIX + imageId]: { dataUrl, rect, ts: Date.now() } satisfies StoredCapture })
  const all = await chrome.storage.session.get()
  const kept = Object.entries(all)
    .filter(([key]) => key.startsWith(CAPTURE_PREFIX))
    .sort(([, a], [, b]) => (a as StoredCapture).ts - (b as StoredCapture).ts)
    .slice(0, -MAX_KEPT_CAPTURES)
  if (kept.length) await chrome.storage.session.remove(kept.map(([key]) => key))
  return imageId
}

/** Show a chat state in the tab's overlay; if the overlay isn't there (exactly
 *  the no-host-access / restricted-page case), open a detached popup window so
 *  the user always gets UI. */
async function showChatWindow(tabId: number | undefined, state: ChatState): Promise<void> {
  if (tabId !== undefined) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'SHOW_CHAT', state })
      return
    } catch {
      // overlay absent — fall through to the detached window
    }
  }
  const compact = state.kind === 'restricted' || state.kind === 'error'
  const params = new URLSearchParams({ ...stateUrlParams(state), fallback: '1' })
  const url = `${chrome.runtime.getURL(CHAT_URL)}?${params}`
  const size = compact ? { width: 360, height: 220 } : { width: 480, height: 640 }
  // Keep exactly one detached window: reuse it if it still exists.
  const { [FALLBACK_WINDOW_KEY]: existingId } = await chrome.storage.session.get(FALLBACK_WINDOW_KEY)
  if (typeof existingId === 'number') {
    try {
      const win = await chrome.windows.get(existingId, { populate: true })
      const tabId = win.tabs?.[0]?.id
      if (tabId !== undefined) {
        await chrome.tabs.update(tabId, { url })
        await chrome.windows.update(existingId, { ...size, focused: true })
        return
      }
    } catch { /* window is gone — create a new one */ }
  }
  const win = await chrome.windows.create({ url, type: 'popup', ...size })
  if (win?.id !== undefined) await chrome.storage.session.set({ [FALLBACK_WINDOW_KEY]: win.id })
}

chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.get(FALLBACK_WINDOW_KEY).then(({ [FALLBACK_WINDOW_KEY]: id }) => {
    if (id === windowId) return chrome.storage.session.remove(FALLBACK_WINDOW_KEY)
  })
})

function stateUrlParams(state: ChatState): Record<string, string> {
  switch (state.kind) {
    case 'capture':
      return { kind: 'capture', id: state.imageId, ...(state.conversationId ? { conversation: state.conversationId } : {}) }
    case 'conversation':
      return { kind: 'conversation', conversation: state.conversationId }
    case 'history':
      return { kind: 'history' }
    case 'permission':
      return { kind: 'permission', origin: state.origin }
    case 'restricted':
      return { kind: 'restricted', reason: state.reason }
    case 'error':
      return { kind: 'error', message: state.message }
  }
}

/** Crop the selected rect out of the full viewport PNG, scaling by DPR. */
async function cropRegion(fullDataUrl: string, { rect, devicePixelRatio: dpr }: CaptureRequest): Promise<string> {
  const resp = await fetch(fullDataUrl)
  const bitmap = await createImageBitmap(await resp.blob())

  const sx = rect.x * dpr
  const sy = rect.y * dpr
  const sw = rect.width * dpr
  const sh = rect.height * dpr

  const canvas = new OffscreenCanvas(Math.max(1, sw), Math.max(1, sh))
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  bitmap.close()

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return blobToDataUrl(blob)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}
