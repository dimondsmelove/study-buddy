// Content script for Study Buddy, injected on demand (activeTab / granted host).
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

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === 'SHOW_OVERLAY') {
    showOverlay()
  } else if (msg.type === 'HIDE_OVERLAY') {
    cancelOverlay?.()
  } else if (msg.type === 'SHOW_CHAT') {
    showChat(msg.state)
  } else if (msg.type === 'HIDE_CHAT') {
    removeChat()
  }
  return false
})

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

const BAR_H = 36

let chatRoot: HTMLElement | undefined
let chatPanel: HTMLDivElement | undefined
let chatFrame: HTMLIFrameElement | undefined

function panelWidth(): number {
  return Math.min(400, document.documentElement.clientWidth - 16)
}

function panelHeight(): number {
  return Math.min(460, document.documentElement.clientHeight - 16)
}

function chatUrl(state: ChatState): string {
  const params = new URLSearchParams(chatUrlParams(state))
  return `${CHAT_URL}?${params}`
}

function chatUrlParams(state: ChatState): Record<string, string> {
  switch (state.kind) {
    case 'capture':
      return { kind: 'capture', id: state.imageId }
    case 'permission':
      return { kind: 'permission', origin: state.origin }
    case 'restricted':
      return { kind: 'restricted', reason: state.reason }
    case 'error':
      return { kind: 'error', message: state.message }
  }
}

/** Embed or update the chat window. The window persists across captures (the
 *  conversation keeps its context); a new state is relayed in via postMessage
 *  instead of reloading the iframe. */
function showChat(state: ChatState): void {
  if (chatFrame) {
    postStateToChat(state)
    if (state.kind === 'capture') positionPanel(state.rect)
    return
  }

  const w = window as unknown as Record<string, unknown>
  if (w[CHAT_FLAG]) return // host exists but our handle is gone (shouldn't happen)

  const root = document.createElement('div')
  // data-study-buddy: test/debug marker on the SHARED DOM (see the overlay).
  root.setAttribute('data-study-buddy', 'chat')
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
    'background:#111827',
    'color:#fff',
    'cursor:move',
    'user-select:none',
  ].join(';')
  const title = document.createElement('span')
  title.textContent = 'Study Buddy'
  title.style.cssText = 'flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
  const close = document.createElement('button')
  close.textContent = '✕'
  close.title = 'Close'
  close.style.cssText = [
    'border:0',
    'background:transparent',
    'color:#d1d5db',
    'font:14px system-ui,sans-serif',
    'cursor:pointer',
    'padding:4px 6px',
    'border-radius:6px',
  ].join(';')
  close.addEventListener('click', () => removeChat())
  close.addEventListener('pointerdown', (e) => e.stopPropagation()) // no drag from ✕
  bar.appendChild(title)
  bar.appendChild(close)

  const frame = document.createElement('iframe')
  frame.style.cssText = 'flex:1;width:100%;border:0;display:block;background:#fff'
  frame.src = chatUrl(state)

  panel.appendChild(bar)
  panel.appendChild(frame)
  shadow.appendChild(panel)
  document.documentElement.appendChild(root)
  makeDraggable(panel, bar)

  chatRoot = root
  chatPanel = panel
  chatFrame = frame
  w[CHAT_FLAG] = true
  positionPanel(state.kind === 'capture' ? state.rect : undefined)
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
  chatRoot?.remove()
  chatRoot = undefined
  chatPanel = undefined
  chatFrame = undefined
  const w = window as unknown as Record<string, unknown>
  w[CHAT_FLAG] = false
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
