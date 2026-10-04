// Study Buddy chat window (an extension page).
//
// It is embedded as an iframe by the overlay's host (src/content/overlay.ts)
// or opened as a detached popup window by the service worker's fallback. The
// initial state arrives via URL params (?kind=capture&id=…); later states are
// relayed in by the host via postMessage (no reload, the conversation survives).
//
// Phase 0 skeleton: renders the captured crop and the rare non-capture states.
// AI answering (Solve / Explain / Translate / free questions) lands on top of
// this in the next build.

import type { ChatState, Rect, StoredCapture } from '../shared/messages'
import { CAPTURE_PREFIX } from '../shared/messages'

type Kind = 'capture' | 'permission' | 'restricted' | 'error'

const view = (kind: Kind): HTMLElement => document.getElementById(`view-${kind}`)!
const img = document.getElementById('crop') as HTMLImageElement

function apply(state: ChatState): void {
  for (const k of ['capture', 'permission', 'restricted', 'error'] as const) {
    view(k).hidden = k !== state.kind
  }
  switch (state.kind) {
    case 'capture':
      void showCapture(state.imageId)
      break
    case 'permission':
      showPermission(state.origin)
      break
    case 'restricted':
      showText('restricted-text', `This page (${state.reason}) can never be captured by any extension.`)
      break
    case 'error':
      showText('error-text', state.message)
      break
  }
}

async function showCapture(imageId: string): Promise<void> {
  const got = await chrome.storage.session.get(CAPTURE_PREFIX + imageId)
  const stored = got[CAPTURE_PREFIX + imageId] as StoredCapture | undefined
  if (!stored) {
    apply({ kind: 'error', message: 'This capture has expired (browser restart?). Select the region again.' })
    return
  }
  img.src = stored.dataUrl
}

function showPermission(origin: string): void {
  showText('perm-text', `Study Buddy needs your permission to capture ${origin || 'this site'}.`)
  const btn = document.getElementById('perm-btn') as HTMLButtonElement
  btn.onclick = async () => {
    // The permission request must be triggered by this user gesture (an
    // extension page may call chrome.permissions.request). If the SW was
    // recycled and the origin wasn't carried along, resolve it live.
    const target = origin || (await resolveActiveOrigin())
    if (!target) {
      apply({ kind: 'error', message: 'Could not determine the site to allow. Please retry from the page.' })
      return
    }
    const granted = await chrome.permissions.request({ origins: [`${target}/*`] }).catch(() => false)
    if (!granted) return // user declined; stay on the prompt
    showText('perm-text', 'Granted! Starting selection…')
    void chrome.runtime.sendMessage({ type: 'PERMISSION_GRANTED' }).catch(() => {})
  }
}

async function resolveActiveOrigin(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.url) return ''
  try {
    return new URL(tab.url).origin
  } catch {
    return ''
  }
}

function showText(id: string, text: string): void {
  document.getElementById(id)!.textContent = text
}

// The host relays later states without reloading the iframe. Accept only our
// own origin (the host posts with an explicit chrome-extension:// target).
window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { source?: string; state?: ChatState } | null
  if (data?.source === 'study-buddy-host' && data.state) apply(data.state)
})

// Initial state from URL params — set by the overlay's iframe src or by the
// service worker's detached fallback window.
function stateFromLocation(): ChatState | null {
  const p = new URLSearchParams(location.search)
  switch (p.get('kind')) {
    case 'capture': {
      const id = p.get('id')
      return id ? { kind: 'capture', imageId: id, rect: { x: 0, y: 0, width: 0, height: 0 } satisfies Rect } : null
    }
    case 'permission':
      return { kind: 'permission', origin: p.get('origin') ?? '' }
    case 'restricted':
      return { kind: 'restricted', reason: p.get('reason') ?? 'this page' }
    case 'error':
      return { kind: 'error', message: p.get('message') ?? 'Unknown error.' }
    default:
      return null
  }
}

const initial = stateFromLocation()
if (initial) apply(initial)
else apply({ kind: 'error', message: 'Opened without a state. Select a region on a page to begin.' })
