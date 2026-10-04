// Study Buddy chat window (an extension page).
//
// It is embedded as an iframe by the overlay's host (src/content/overlay.ts)
// or opened as a detached popup window by the service worker's fallback. The
// initial state arrives via URL params (?kind=capture&id=…); later states are
// relayed in by the host via postMessage (no reload, the conversation survives).
//
// Phase 0 skeleton: renders the captured crop and the rare non-capture states,
// plus the connection-settings view (provider / endpoint / key / model).
// AI answering (Solve / Explain / Translate / free questions) lands on top of
// this in the next build.

import type { ChatState, Rect, StoredCapture } from '../shared/messages'
import { CAPTURE_PREFIX } from '../shared/messages'
import type { Settings } from '../shared/settings'
import { DEFAULT_SETTINGS, getSettings, setSettings } from '../shared/settings'

type Kind = 'capture' | 'permission' | 'restricted' | 'error'

const view = (kind: Kind): HTMLElement => document.getElementById(`view-${kind}`)!
const img = document.getElementById('crop') as HTMLImageElement

// The last non-settings state we rendered. Settings is a modal detour: both
// Back and a successful Save return to it, so an embedded capture conversation
// survives the round trip.
let current: ChatState = { kind: 'error', message: 'Opened without a state. Select a region on a page to begin.' }

function apply(state: ChatState): void {
  current = state
  for (const k of ['capture', 'permission', 'restricted', 'error'] as const) {
    view(k).hidden = k !== state.kind
  }
  // Settings is a detour, not a state: every apply() — the host relaying a new
  // state, or the user leaving settings — dismisses it, so the two can never
  // end up stacked on screen.
  document.getElementById('view-settings')!.hidden = true
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

// ── Settings view ────────────────────────────────────────────────────────────
// A modal detour from whatever ChatState is applied (see `current`): opened by
// the ⚙ buttons, closed by Back / Save without touching the state machine.

const el = (id: string): HTMLElement => document.getElementById(id)!
const setMsg = (text: string): void => {
  el('set-msg').textContent = text
}

function fillSettingsForm(s: Settings): void {
  ;(el('set-provider') as HTMLSelectElement).value = s.provider
  ;(el('set-base-url') as HTMLInputElement).value = s.baseUrl
  ;(el('set-api-key') as HTMLInputElement).value = s.apiKey
  ;(el('set-model') as HTMLInputElement).value = s.model
  setMsg('') // a stale validation message must not survive a fresh open
}

function openSettings(): void {
  void getSettings().then((s) => {
    fillSettingsForm(s)
    for (const k of ['capture', 'permission', 'restricted', 'error'] as const) view(k).hidden = true
    el('view-settings').hidden = false
  })
}

function restoreView(): void {
  // current never holds 'settings' — apply() only records the four real kinds —
  // so this always lands on the state that was up before the detour.
  apply(current)
}

// Provider switching, kept deliberately simple: picking the preset repairs the
// URL if it still shows the custom default (or was left empty — 'openrouter'
// was just picked from a blank form); a user-typed URL is left alone. Custom
// selects the text so it can be typed over in one go.
(el('set-provider') as HTMLSelectElement).onchange = (e) => {
  const urlInput = el('set-base-url') as HTMLInputElement
  if ((e.target as HTMLSelectElement).value === 'openrouter') {
    if (urlInput.value === '' || urlInput.value === DEFAULT_SETTINGS.baseUrl) {
      urlInput.value = 'https://openrouter.ai/api/v1'
    }
  } else {
    urlInput.focus()
    urlInput.select()
  }
}

// Show/hide the key without clearing the field; the glyph marks the next
// action (👁 shown while masked = click to peek), not the current one.
(el('set-key-toggle') as HTMLButtonElement).onclick = (e) => {
  const key = el('set-api-key') as HTMLInputElement
  const btn = e.currentTarget as HTMLButtonElement
  const show = key.type === 'password'
  key.type = show ? 'text' : 'password'
  btn.textContent = show ? '🚫' : '👁'
}

el('set-save').onclick = () => {
  const apiKey = (el('set-api-key') as HTMLInputElement).value.trim()
  if (!apiKey) {
    setMsg('Enter an API key.')
    return
  }
  // The URL constructor accepts e.g. "https://x" and any scheme — an
  // http(s) check is the actual gate, not mere parseability.
  try {
    const u = new URL((el('set-base-url') as HTMLInputElement).value.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)')
  } catch {
    setMsg('Base URL must be a valid http(s) URL.')
    return
  }
  const settings: Settings = {
    provider: (el('set-provider') as HTMLSelectElement).value as Settings['provider'],
    baseUrl: (el('set-base-url') as HTMLInputElement).value.trim(),
    apiKey,
    model: (el('set-model') as HTMLInputElement).value.trim(),
  }
  void setSettings(settings).then(() => {
    restoreView()
  })
}

el('set-back').onclick = () => restoreView()

// Every settings access point: the ⚙ in the capture view plus the same button
// on the rare views, so a user is never stuck without settings access.
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-goto-settings]')) {
  btn.onclick = () => openSettings()
}
el('settings-btn').onclick = () => openSettings()

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
