// Study Buddy panel and capture open on user action; only a minimized panel has a launcher.
// Two jobs, both dormant until the service worker calls:
//   1. SHOW_OVERLAY — full-page dimmer + drag rectangle; on mouseup the selected
//      rect (CSS px + devicePixelRatio) goes to the SW, which captures & crops.
//   2. SHOW_CHAT — embed the chat window: an extension-page iframe inside a
//      closed shadow root (page styles can't leak in, ours can't leak out),
//      anchored near the selection, draggable via its header bar.
//
// IMPORTANT: this file is built to a fixed name (content/overlay.js) and
// injected with chrome.scripting.executeScript, which runs CLASSIC scripts —
// no module imports at runtime. The import below is type-only and erased.

import type { ChatState, CaptureRequest, Message, Rect } from '../shared/messages'

const OVERLAY_FLAG = '__studyBuddyOverlay'
const CHAT_FLAG = '__studyBuddyChat'
const CHAT_URL = chrome.runtime.getURL('src/chat/chat.html')

// Where the selection ended, to anchor the chat window when no rect is known.
let lastPointer = { x: 0, y: 0 }

const contentWindow = window as unknown as Record<string, unknown>
const ownsHost = !contentWindow.__studyBuddyContent
if (ownsHost) {
  contentWindow.__studyBuddyContent = true
  chrome.runtime.onMessage.addListener((msg: Message) => {
    if (msg.type === 'SHOW_OVERLAY') {
      showOverlay()
    } else if (msg.type === 'PREPARE_SELECTION') {
      prepareForSelection()
      showOverlay()
    } else if (msg.type === 'HIDE_OVERLAY') {
      cancelOverlay?.()
    } else if (msg.type === 'SHOW_CHAT') {
      showChat(msg.state)
    } else if (msg.type === 'CAPTURE_FAILED') {
      captureFailed(msg.message)
    } else if (msg.type === 'HIDE_CHAT') {
      removeChat()
    } else if (msg.type === 'LAUNCHER_STATE' && typeof msg.minimized === 'boolean') {
      launcherRevision++
      launcherMinimized = msg.minimized
      refreshLauncher()
    } else if (msg.type === 'DIALOG_CHANGED') {
      if (!msg.conversationId) removeChat()
      else if (chatFrame && activeConversationId !== msg.conversationId) {
        trackConversation(msg.conversationId, true)
        chatKind = 'conversation'
        const url = new URL(CHAT_URL)
        chatFrame.contentWindow?.postMessage({ source: 'study-buddy-host', action: 'conversation-changed', conversationId: msg.conversationId }, `${url.protocol}//${url.hostname}`)
      }
    }
    return false
  })
  queueMicrotask(() => {
    const revision = launcherRevision
    void chrome.runtime.sendMessage({ type: 'LAUNCHER_STATE' }).then(state => {
      if (revision !== launcherRevision) return
      launcherMinimized = state?.minimized === true
      refreshLauncher()
    }).catch(() => {})
  })
}

// --- selection overlay --------------------------------------------------------

let cancelOverlay: (() => void) | undefined

function showOverlay() {
  const w = window as unknown as Record<string, unknown>
  if (w[OVERLAY_FLAG]) return // already open
  w[OVERLAY_FLAG] = true

  const root = document.createElement('div')
  // data-study-buddy: test/debug marker on the SHARED DOM (window flags live in
  // the content script's isolated world and are invisible to the page).
  root.setAttribute('data-study-buddy', 'overlay')
  root.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'cursor:crosshair',
    'background:rgba(0,0,0,0.25)',
  ].join(';')

  const box = document.createElement('div')
  box.style.cssText = [
    'position:fixed',
    'border:2px solid #4f9cff',
    'background:rgba(79,156,255,0.12)',
    'pointer-events:none',
    'display:none',
  ].join(';')
  root.appendChild(box)

  const hint = document.createElement('div')
  hint.textContent = 'Drag to select · Esc or click to cancel'
  hint.style.cssText = [
    'position:fixed',
    'top:12px',
    'left:50%',
    'transform:translateX(-50%)',
    'padding:6px 12px',
    'background:#111',
    'color:#fff',
    'font:13px system-ui,sans-serif',
    'border-radius:6px',
    'pointer-events:none',
  ].join(';')
  root.appendChild(hint)

  document.documentElement.appendChild(root)
  root.tabIndex = -1
  root.focus() // so Esc reaches us on pages that don't steal keyboard focus

  let startX = 0
  let startY = 0
  let dragging = false

  function teardown() {
    cancelOverlay = undefined
    dragging = false
    root.remove()
    w[OVERLAY_FLAG] = false
    window.removeEventListener('keydown', onKey, true)
    document.removeEventListener('keydown', onKey, true)
  }

  function notifyCancelled() {
    restoreAfterSelection()
    void chrome.runtime.sendMessage({ type: 'SELECTION_CANCELLED' }).catch(() => {})
  }

  cancelOverlay = () => {
    teardown()
    notifyCancelled()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelOverlay?.()
    }
  }
  // Capture phase on both targets to grab Esc before the page.
  window.addEventListener('keydown', onKey, true)
  document.addEventListener('keydown', onKey, true)

  root.addEventListener('mousedown', (e) => {
    dragging = true
    startX = e.clientX
    startY = e.clientY
    box.style.display = 'block'
    box.style.left = `${startX}px`
    box.style.top = `${startY}px`
    box.style.width = '0px'
    box.style.height = '0px'
  })

  root.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const x = Math.min(e.clientX, startX)
    const y = Math.min(e.clientY, startY)
    box.style.left = `${x}px`
    box.style.top = `${y}px`
    box.style.width = `${Math.abs(e.clientX - startX)}px`
    box.style.height = `${Math.abs(e.clientY - startY)}px`
  })

  root.addEventListener('mouseup', (e) => {
    if (!dragging) return
    dragging = false
    const x = Math.min(e.clientX, startX)
    const y = Math.min(e.clientY, startY)
    const width = Math.abs(e.clientX - startX)
    const height = Math.abs(e.clientY - startY)

    lastPointer = { x: e.clientX, y: e.clientY }

    // Hide the overlay BEFORE capture so the dimmer isn't in the screenshot.
    teardown()

    if (width < 4 || height < 4) {
      notifyCancelled()
      return // accidental click, not a selection
    }

    const capture: CaptureRequest = {
      type: 'CAPTURE_REQUEST',
      rect: { x, y, width, height },
      devicePixelRatio: window.devicePixelRatio || 1,
      origin: window.location.origin,
    }
    // Small delay lets the overlay removal paint before captureVisibleTab.
    setTimeout(() => chrome.runtime.sendMessage(capture), 50)
  })
}

// --- chat window host ---------------------------------------------------------

const BAR_H = 44
const PANEL_MIN_W = 320
const PANEL_MIN_H = 360
const PANEL_SIZE_KEY = 'panel.size'

let chatRoot: HTMLElement | undefined
let chatPanel: HTMLDivElement | undefined
let chatFrame: HTMLIFrameElement | undefined
let launcher: HTMLButtonElement | undefined
let launcherRoot: HTMLElement | undefined
let launcherMinimized = false
let launcherRevision = 0
let errorNotice: HTMLDivElement | undefined
let activeConversationId: string | undefined
let chatKind: ChatState['kind'] | undefined
let closeRequest: { id: string; conversationId: string } | undefined
let chatLang: 'en' | 'ru' = 'en'
let selectionRestoreState: 'open' | 'minimized' | undefined
let selectionRestoreNotice: { hidden: boolean; display: string } | undefined
let hostMessages: ((event: MessageEvent) => void) | undefined
let hostPointerDown: ((event: PointerEvent) => void) | undefined

function trackConversation(nextConversationId: string | undefined, cancelClose: boolean): void {
  if (activeConversationId && nextConversationId && activeConversationId !== nextConversationId) {
    if (cancelClose && closeRequest) {
      const url = new URL(CHAT_URL)
      chatFrame?.contentWindow?.postMessage({ source: 'study-buddy-host', action: 'close-cancelled', closeId: closeRequest.id }, `${url.protocol}//${url.hostname}`)
      closeRequest = undefined
    }
  }
  if (nextConversationId) activeConversationId = nextConversationId
}

/** User-resized panel size, persisted across pages/sessions. Loaded async;
 *  until it arrives (or if never resized) the defaults below apply. */
let savedSize: { w: number; h: number } | null = null
void chrome.storage.local.get(PANEL_SIZE_KEY).then((r) => {
  const s = r[PANEL_SIZE_KEY]
  if (s && typeof s.w === 'number' && typeof s.h === 'number') savedSize = s
})

function panelWidth(): number {
  const def = savedSize ? savedSize.w : 480
  return Math.min(def, document.documentElement.clientWidth - 16)
}

function panelHeight(): number {
  const def = savedSize ? savedSize.h : 600
  return Math.min(def, document.documentElement.clientHeight - 16)
}

function chatUrl(state: ChatState): string {
  const params = new URLSearchParams(chatUrlParams(state))
  return `${CHAT_URL}?${params}`
}

function chatUrlParams(state: ChatState): Record<string, string> {
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

function refreshLauncher(): void {
  const visible = launcherMinimized && !cancelOverlay && !selectionRestoreState && (!chatPanel || chatPanel.style.display === 'none')
  if (visible) showLauncher().hidden = false
  else if (launcher) launcher.hidden = true
}

function setLauncherState(minimized: boolean): void {
  launcherRevision++
  launcherMinimized = minimized
  refreshLauncher()
  void chrome.runtime.sendMessage({ type: 'LAUNCHER_STATE', minimized }).catch(() => {})
}

/** Restore affordance, visible only after the panel was minimized. */
function showLauncher(): HTMLButtonElement {
  if (launcher?.isConnected) return launcher
  const root = document.createElement('div')
  root.setAttribute('data-study-buddy', 'launcher')
  root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647'
  const shadow = root.attachShadow({ mode: 'closed' })
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', 'Restore Study Buddy')
  button.title = 'Restore Study Buddy'
  button.style.cssText = 'position:fixed;right:24px;bottom:24px;width:40px;height:40px;box-sizing:border-box;border:1px solid #4f9cff;border-radius:50%;background:#111827;color:white;padding:0;line-height:0;cursor:pointer;box-shadow:0 4px 18px #0004'
  const icon = document.createElement('img')
  icon.src = chrome.runtime.getURL('icons/icon32.png')
  icon.alt = ''
  icon.width = 24
  icon.height = 24
  icon.style.cssText = 'position:absolute;left:7px;top:7px;display:block'
  icon.draggable = false
  icon.setAttribute('aria-hidden', 'true')
  button.appendChild(icon)
  button.onclick = () => {
    void chrome.runtime.sendMessage({ type: 'RESTORE_CHAT' }).catch(() => {})
  }
  // Drag a button; a short pointer movement remains a normal keyboard/click activation.
  button.onpointerdown = (event) => {
    if (event.button !== 0) return
    const rect = button.getBoundingClientRect()
    const x = event.clientX, y = event.clientY
    let moved = false
    button.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => {
      if (Math.hypot(next.clientX - x, next.clientY - y) < 5 && !moved) return
      moved = true
      button.style.right = 'auto'
      button.style.bottom = 'auto'
      button.style.left = `${Math.max(8, Math.min(rect.left + next.clientX - x, innerWidth - rect.width - 8))}px`
      button.style.top = `${Math.max(8, Math.min(rect.top + next.clientY - y, innerHeight - rect.height - 8))}px`
    }
    const up = () => {
      button.removeEventListener('pointermove', move)
      button.removeEventListener('pointerup', up)
      button.removeEventListener('pointercancel', up)
      if (moved) button.addEventListener('click', (click) => { click.preventDefault(); click.stopImmediatePropagation() }, { once: true, capture: true })
    }
    button.addEventListener('pointermove', move)
    button.addEventListener('pointerup', up)
    button.addEventListener('pointercancel', up)
  }
  shadow.appendChild(button)
  document.documentElement.appendChild(root)
  launcher = button
  launcherRoot = root
  return button
}

function minimizeChat(): void {
  if (chatPanel) chatPanel.style.display = 'none'
  chatRoot?.setAttribute('data-state', 'minimized')
  setLauncherState(true)
}

/** Embed or update the chat window. The window persists across captures (the
 *  conversation keeps its context); a new state is relayed in via postMessage
 *  instead of reloading the iframe. */
function showChat(state: ChatState): void {
  setLauncherState(false)
  const nextConversationId = state.kind === 'capture' || state.kind === 'conversation' ? state.conversationId : undefined
  if (chatFrame) {
    const sameConversation = state.kind === 'conversation' && nextConversationId === activeConversationId && (chatKind === 'conversation' || chatKind === 'capture')
    chatKind = state.kind
    trackConversation(nextConversationId, true)
    selectionRestoreState = undefined
    selectionRestoreNotice = undefined
    if (chatPanel) chatPanel.style.display = 'flex'
    if (chatPanel) chatPanel.style.visibility = 'visible'
    if (launcher) launcher.hidden = true
    chatRoot?.setAttribute('data-state', 'open')
    if (errorNotice) {
      errorNotice.hidden = true
      errorNotice.style.display = 'none'
    }
    if (!sameConversation) postStateToChat(state)
    else chatFrame.focus()
    if (state.kind === 'capture') positionPanel(state.rect)
    return
  }

  const w = window as unknown as Record<string, unknown>
  if (w[CHAT_FLAG] && !chatRoot) return // another injection owns the existing host
  activeConversationId = nextConversationId
  chatKind = state.kind
  if (hostMessages) window.removeEventListener('message', hostMessages)
  if (hostPointerDown) document.removeEventListener('pointerdown', hostPointerDown, true)
  chatRoot?.remove()
  w[CHAT_FLAG] = false

  const root = document.createElement('div')
  // data-study-buddy: test/debug marker on the SHARED DOM (see the overlay).
  root.setAttribute('data-study-buddy', 'chat')
  root.setAttribute('data-state', 'open')
  root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647'
  const shadow = root.attachShadow({ mode: 'closed' })

  const panel = document.createElement('div')
  panel.style.cssText = [
    'position:fixed',
    `width:${panelWidth()}px`,
    `height:${panelHeight()}px`,
    'display:flex',
    'flex-direction:column',
    'background:#fff',
    'border:1px solid #d4d4d8',
    'border-radius:10px',
    'box-shadow:0 8px 30px rgba(0,0,0,0.28)',
    'overflow:hidden',
    'font:13px system-ui,sans-serif',
  ].join(';')

  const bar = document.createElement('div')
  bar.style.cssText = [
    `height:${BAR_H}px`,
    'flex:0 0 auto',
    'display:flex',
    'align-items:center',
    'gap:8px',
    'padding:0 10px',
    'background:#fbfcfe',
    'color:#1f2937',
    'border-bottom:1px solid #d9e2ed',
    'cursor:move',
    'user-select:none',
  ].join(';')
  const title = document.createElement('span')
  title.textContent = 'Study Buddy'
  title.style.cssText = 'flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
  const frame = document.createElement('iframe')
  frame.title = 'Study Buddy conversation'
  frame.allow = 'clipboard-write'
  frame.style.cssText = 'flex:1;width:100%;border:0;display:block;background:#fff'
  frame.src = chatUrl(state)
  const close = document.createElement('button')
  close.textContent = '✕'
  close.title = 'Close'
  close.setAttribute('aria-label', 'Close and save')
  close.style.cssText = [
    'border:0',
    'background:transparent',
    'color:#526174',
    'width:44px',
    'height:44px',
    'flex:0 0 44px',
    'font:14px system-ui,sans-serif',
    'cursor:pointer',
    'padding:0',
    'border-radius:6px',
  ].join(';')
  let frameReady = false
  let closeRequested = false
  const sendClose = () => {
    if (!frameReady || !closeRequested || chatFrame !== frame) return
    closeRequested = false
    const request = closeRequest
    if (!request) return
    const target = new URL(CHAT_URL)
    frame.contentWindow?.postMessage({ source: 'study-buddy-host', action: 'close', closeId: request.id }, `${target.protocol}//${target.hostname}`)
  }
  frame.addEventListener('load', () => {
    frameReady = true
    sendClose()
  }, { once: true })
  close.addEventListener('click', () => {
    if (!chatFrame) { removeChat(); return }
    if (!activeConversationId) { removeChat(); return }
    closeRequest = { id: crypto.randomUUID(), conversationId: activeConversationId }
    closeRequested = true
    sendClose()
  })
  close.addEventListener('pointerdown', (e) => e.stopPropagation()) // no drag from ✕
  bar.appendChild(title)
  const minimize = document.createElement('button')
  minimize.textContent = '−'
  minimize.title = 'Minimize'
  minimize.setAttribute('aria-label', 'Minimize; keep answering')
  minimize.style.cssText = close.style.cssText
  minimize.onpointerdown = (event) => event.stopPropagation()
  minimize.onclick = () => {
    minimizeChat()
    launcher?.focus()
  }
  bar.appendChild(minimize)
  bar.appendChild(close)

  // Bottom-right resize grip (subtle; matches the panel border color).
  const grip = document.createElement('div')
  grip.title = 'Resize'
  grip.style.cssText = [
    'position:absolute',
    'right:0',
    'bottom:0',
    'width:14px',
    'height:14px',
    'cursor:nwse-resize',
    'background:linear-gradient(135deg,transparent 0 6px,#a1a1aa 6px 7px,transparent 7px 9px,#a1a1aa 9px 10px,transparent 10px)',
  ].join(';')
  grip.addEventListener('pointerdown', (e) => e.stopPropagation()) // no drag from grip

  panel.appendChild(bar)
  panel.appendChild(frame)
  panel.appendChild(grip)
  shadow.appendChild(panel)
  const button = showLauncher()
  button.hidden = true

  const notice = document.createElement('div')
  notice.setAttribute('role', 'alert')
  notice.style.cssText = 'position:fixed;right:24px;top:24px;display:none;align-items:flex-start;gap:12px;max-width:min(360px,calc(100vw - 48px));padding:12px 14px;border:1px solid #fca5a5;border-radius:8px;background:#fff;color:#7f1d1d;box-shadow:0 4px 18px #0003;font:13px/1.45 system-ui,sans-serif;z-index:2147483647'
  const noticeText = document.createElement('span')
  noticeText.style.cssText = 'flex:1;overflow-wrap:anywhere'
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = '×'
  dismiss.title = 'Dismiss error'
  dismiss.setAttribute('aria-label', 'Dismiss error')
  dismiss.style.cssText = 'border:0;background:transparent;color:inherit;font:20px/1 system-ui,sans-serif;cursor:pointer;padding:0 2px'
  dismiss.onclick = () => { notice.hidden = true; notice.style.display = 'none' }
  notice.append(noticeText, dismiss)
  notice.hidden = true
  shadow.appendChild(notice)
  document.documentElement.appendChild(root)
  makeDraggable(panel, bar)
  makeResizable(panel, grip)

  chatRoot = root
  chatPanel = panel
  chatFrame = frame
  launcher = button
  errorNotice = notice
  hostMessages = (event) => {
    const data = event.data
    const url = new URL(CHAT_URL)
    if (event.source !== frame.contentWindow || event.origin !== `${url.protocol}//${url.hostname}` || data?.source !== 'study-buddy-chat') return
    if (data.action === 'conversation-selected' && typeof data.conversationId === 'string') {
      trackConversation(data.conversationId, false)
    }
    if (data.action === 'dismiss-history' && chatRoot === root && chatFrame === frame) removeChat()
    if (data.action === 'close-cancelled' && typeof data.closeId === 'string' && closeRequest?.id === data.closeId) {
      closeRequest = undefined
    }
    if (data.action === 'closed') {
      const closeId = typeof data.closeId === 'string' ? data.closeId : undefined
      const request = closeRequest
      if (!closeId || !request || request.id !== closeId) return
      const closingConversationId = typeof data.conversationId === 'string' ? data.conversationId : request.conversationId
      if (!closingConversationId) {
        if (chatRoot === root && chatFrame === frame) removeChat()
        return
      }
      const failClose = () => {
        if (chatRoot !== root || chatFrame !== frame || closeRequest?.id !== closeId) return
        if (activeConversationId !== request.conversationId && activeConversationId !== closingConversationId) {
          closeRequest = undefined
          return
        }
        closeRequest = undefined
        frame.contentWindow?.postMessage({ source: 'study-buddy-host', action: 'close-failed', closeId }, `${url.protocol}//${url.hostname}`)
      }
      void chrome.runtime.sendMessage({ type: 'DIALOG_CLOSED', conversationId: closingConversationId }).then((response) => {
        if (chatRoot !== root || chatFrame !== frame || closeRequest?.id !== closeId) return
        if (activeConversationId !== request.conversationId && activeConversationId !== closingConversationId) {
          closeRequest = undefined
          return
        }
        if (response?.ok) { closeRequest = undefined; removeChat() }
        else failClose()
      }, failClose)
    }
    if (data.action === 'status' && typeof data.text === 'string') {
      chatLang = data.lang === 'ru' ? 'ru' : 'en'
      const label = chatLang === 'ru' ? 'Открыть Study Buddy' : 'Restore Study Buddy'
      button.setAttribute('aria-label', data.text ? `${label} · ${data.text}` : label)
      button.title = data.text ? `Study Buddy · ${data.text}` : label
      close.title = chatLang === 'ru' ? 'Закрыть и сохранить' : 'Close and save'
      minimize.title = chatLang === 'ru' ? 'Свернуть; продолжить ответ' : 'Minimize; keep answering'
      close.setAttribute('aria-label', close.title)
      minimize.setAttribute('aria-label', minimize.title)
    }
  }
  window.addEventListener('message', hostMessages)
  // Pointer events on the host page do not propagate into the chat iframe.
  hostPointerDown = event => {
    if (event.composedPath().includes(root)) return
    const url = new URL(CHAT_URL)
    frame.contentWindow?.postMessage({ source: 'study-buddy-host', action: 'dismiss-tooltip' }, `${url.protocol}//${url.hostname}`)
    if (event.button === 0 &&
        chatPanel?.style.display !== 'none' &&
        chatRoot?.getAttribute('data-state') === 'open' &&
        !cancelOverlay &&
        !selectionRestoreState) {
      minimizeChat()
    }
  }
  document.addEventListener('pointerdown', hostPointerDown, true)
  w[CHAT_FLAG] = true
  positionPanel(state.kind === 'capture' ? state.rect : undefined)
}

function prepareForSelection(): void {
  if (chatFrame && chatRoot && chatPanel && launcher && !selectionRestoreState) {
    selectionRestoreState = chatPanel.style.display === 'none' ? 'minimized' : 'open'
  }
  if (errorNotice && !selectionRestoreNotice) {
    selectionRestoreNotice = { hidden: errorNotice.hidden, display: errorNotice.style.display }
  }
  if (chatPanel) chatPanel.style.visibility = 'hidden'
  if (launcher) launcher.hidden = true
  if (errorNotice) {
    errorNotice.hidden = true
    errorNotice.style.display = 'none'
  }
  if (chatRoot) chatRoot.setAttribute('data-state', 'selecting')
}

function restoreAfterSelection(): void {
  if (!selectionRestoreState || !chatPanel || !chatRoot || !launcher) {
    refreshLauncher()
    return
  }
  const state = selectionRestoreState
  selectionRestoreState = undefined
  chatPanel.style.visibility = 'visible'
  chatPanel.style.display = state === 'open' ? 'flex' : 'none'
  chatRoot.setAttribute('data-state', state)
  refreshLauncher()
  if (errorNotice && selectionRestoreNotice) {
    errorNotice.hidden = selectionRestoreNotice.hidden
    errorNotice.style.display = selectionRestoreNotice.display
    selectionRestoreNotice = undefined
  }
  if (state === 'minimized') launcher.focus()
}

function captureFailed(message: string): void {
  if (!chatFrame || !errorNotice) {
    restoreAfterSelection()
    showChat({ kind: 'error', message })
    return
  }
  restoreAfterSelection()
  const text = errorNotice.querySelector('span')
  if (text) text.textContent = `${chatLang === 'ru' ? 'Не удалось захватить область' : 'Could not capture the selected region'}: ${message}`
  const dismiss = errorNotice.querySelector('button')
  if (dismiss) dismiss.setAttribute('aria-label', chatLang === 'ru' ? 'Скрыть сообщение об ошибке' : 'Dismiss error')
  errorNotice.hidden = false
  errorNotice.style.display = 'flex'
}

/** Relay a new state into the live chat page without reloading it. Target
 *  origin is our own chrome-extension:// origin (built by hand — URL.origin is
 *  the literal "null" for opaque origins) — nothing else can receive it. */
function postStateToChat(state: ChatState): void {
  const u = new URL(CHAT_URL, location.href)
  const target = `${u.protocol}//${u.hostname}`
  chatFrame?.contentWindow?.postMessage({ source: 'study-buddy-host', state }, target)
}

function removeChat(): void {
  if (hostMessages) window.removeEventListener('message', hostMessages)
  hostMessages = undefined
  if (hostPointerDown) document.removeEventListener('pointerdown', hostPointerDown, true)
  hostPointerDown = undefined
  chatRoot?.remove()
  chatRoot = undefined
  chatPanel = undefined
  chatFrame = undefined
  errorNotice = undefined
  activeConversationId = undefined
  chatKind = undefined
  closeRequest = undefined
  selectionRestoreState = undefined
  selectionRestoreNotice = undefined
  const w = window as unknown as Record<string, unknown>
  w[CHAT_FLAG] = false
  launcherRoot?.remove()
  launcherRoot = undefined
  launcher = undefined
  setLauncherState(false)
}

/** Anchor near the selection: prefer the right of it, else to its left, else
 *  clamped to the viewport. Falls back to the last pointer position. */
function positionPanel(rect: Rect | undefined): void {
  if (!chatPanel) return
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const w = chatPanel.offsetWidth || panelWidth()
  const h = chatPanel.offsetHeight || panelHeight()
  const pad = 12

  let x: number
  let y: number
  if (rect && rect.width > 0) {
    x = rect.x + rect.width + pad
    if (x + w > vw - 8) x = rect.x - w - pad
    if (x < 8) x = Math.max(8, Math.min(vw - w - 8, rect.x + rect.width - w))
    y = rect.y
    if (y + h > vh - 8) y = Math.max(8, rect.y + rect.height - h)
  } else {
    x = lastPointer.x + 16
    y = lastPointer.y + 16
  }
  chatPanel.style.left = `${Math.round(Math.max(8, Math.min(x, vw - w - 8)))}px`
  chatPanel.style.top = `${Math.round(Math.max(8, Math.min(y, vh - h - 8)))}px`
}

function makeDraggable(panel: HTMLDivElement, handle: HTMLDivElement): void {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const rect = panel.getBoundingClientRect()
    const startLeft = rect.left
    const startTop = rect.top
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      panel.style.left = `${Math.max(0, Math.min(startLeft + ev.clientX - startX, vw - rect.width))}px`
      panel.style.top = `${Math.max(0, Math.min(startTop + ev.clientY - startY, vh - rect.height))}px`
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  })
}

/** Bottom-right grip resize. Clamped to a minimum readable size and to the
 *  viewport; the resulting size is persisted so the panel reopens as sized. */
function makeResizable(panel: HTMLDivElement, grip: HTMLDivElement): void {
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startW = panel.offsetWidth
    const startH = panel.offsetHeight
    grip.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      const maxW = vw - (panel.getBoundingClientRect().left || 0) - 8
      const maxH = vh - (panel.getBoundingClientRect().top || 0) - 8
      const w = Math.round(Math.max(PANEL_MIN_W, Math.min(startW + ev.clientX - startX, maxW)))
      const h = Math.round(Math.max(PANEL_MIN_H, Math.min(startH + ev.clientY - startY, maxH)))
      panel.style.width = `${w}px`
      panel.style.height = `${h}px`
    }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      savedSize = { w: panel.offsetWidth, h: panel.offsetHeight }
      void chrome.storage.local.set({ [PANEL_SIZE_KEY]: savedSize })
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  })
}
