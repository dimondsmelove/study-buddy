// Study Buddy chat window (an extension page).
//
// It is embedded as an iframe by the overlay's host (src/content/overlay.ts)
// or opened as a detached popup window by the service worker's fallback. The
// initial state arrives via URL params (?kind=capture&id=…); later states are
// relayed in by the host via postMessage (no reload, the conversation survives).
//
// Renders the captured crop and the rare non-capture states, plus the
// connection-settings view (provider / endpoint / key / model). The crop is
// sent to a vision model and the answer streams into the thread: Solve /
// Explain / Translate presets and free-form questions.

import type { ApiContent, ApiMessage } from '../shared/api'
import { askWithFallback, modelLabel } from '../shared/ai'
import type { ChatState, Rect, StoredCapture } from '../shared/messages'
import { CAPTURE_PREFIX } from '../shared/messages'
import type { Settings } from '../shared/settings'
import { DEFAULT_SETTINGS, getSettings, setSettings } from '../shared/settings'

type Kind = 'capture' | 'permission' | 'restricted' | 'error'

const view = (kind: Kind): HTMLElement => document.getElementById(`view-${kind}`)!
const el = (id: string): HTMLElement => document.getElementById(id)!
const img = document.getElementById('crop') as HTMLImageElement
const thread = document.getElementById('thread') as HTMLElement

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
  activeImage = stored.dataUrl
  img.src = stored.dataUrl
  ensureHint()
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

// ── AI answering ─────────────────────────────────────────────────────────────
// The thread is a plain-text transcript held in memory, not persisted: the
// host reuses this iframe across captures, so `history` is what keeps the
// conversation's context. Each new capture swaps `activeImage` and the next
// question carries the new crop; earlier images stay in `history` as part of
// the model's context.

// Answer-language rules, told to the model in the system prompt:
//  - a typed question is answered in the language it is written in;
//  - a preset button carries no prose of its own, so it uses the browser UI
//    language (a Russian UI keeps Solve/Explain answers Russian).
// The instruction is spelled out rather than left implicit because the presets
// themselves are English text, which otherwise pulls the answer into English.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', ru: 'Russian', uk: 'Ukrainian', be: 'Belarusian', kk: 'Kazakh',
  de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  nl: 'Dutch', pl: 'Polish', cs: 'Czech', sv: 'Swedish', tr: 'Turkish',
  zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic', hi: 'Hindi', he: 'Hebrew',
}

function uiLanguage(): string {
  const tag = (chrome.i18n?.getUILanguage?.() || navigator.language || 'en').toLowerCase()
  const base = tag.split('-')[0]
  return LANGUAGE_NAMES[base] ?? tag
}

// One voice for the model's role: concise tutor, grounded in the screenshot,
// never inventing content that isn't there. A typed question overrides the UI
// language, and an explicit "answer in / translate into X" wins over both.
function systemPrompt(): string {
  return (
    'You are Study Buddy, a concise and friendly tutor. The user shares a screenshot ' +
    'of part of their screen and asks about what is visible. Solve or explain ' +
    'exercises and translate text. Ground every answer in the image; if something ' +
    'is unreadable or not present, say so instead of guessing.\n\n' +
    `Language: answer in the language the user writes in. When the request is one of ` +
    `the app's fixed actions with no prose of its own, answer in ${uiLanguage()}. ` +
    'If the user explicitly asks to answer in, or translate into, a particular ' +
    'language, follow that request instead.'
  )
}

// Preset instruction, with the target language spelled out: the preset text is
// English, so without this the model tends to answer in English.
function presetPrompts(): Record<string, string> {
  const lang = uiLanguage()
  return {
    solve: `Solve the exercise shown in the image. Give the final answer first, then a short step-by-step solution. Answer in ${lang}.`,
    explain: `Explain what is shown in the image, step by step, as a patient tutor. Answer in ${lang}.`,
    translate: `Translate all the text in the image into ${lang}. If it is already ${lang}, translate it into English instead. Keep the layout where it matters.`,
  }
}

// The crop currently on screen, as a data URL, attached to the next question.
let activeImage: string | null = null
// Conversation so far (user/assistant turns), sent on every request so the
// model sees the full context. Images are kept in their turns.
const history: ApiMessage[] = []
// Non-null while a completion is streaming; its abort cancels the request.
let inflight: AbortController | null = null

function ensureHint(): void {
  if (thread.children.length || thread.querySelector('.hint')) return
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = 'Pick an action above, or ask a question about the selected region.'
  thread.appendChild(hint)
}

function scrollThread(): void {
  thread.scrollTop = thread.scrollHeight
}

/** Append one message bubble; returns its body so streaming can grow it. */
function appendMessage(role: 'user' | 'assistant' | 'error' | 'note', text: string): HTMLDivElement {
  thread.querySelector('.hint')?.remove()
  const wrap = document.createElement('div')
  wrap.className = `msg ${role}`
  const body = document.createElement('div')
  body.className = 'msg-body'
  body.textContent = text
  wrap.appendChild(body)
  thread.appendChild(wrap)
  scrollThread()
  return body
}

function setBusy(busy: boolean): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.preset')) b.disabled = busy
  ;(el('ask-input') as HTMLInputElement).disabled = busy
  ;(el('ask-btn') as HTMLButtonElement).textContent = busy ? 'Stop' : 'Ask'
}

/** Settings must be usable before a request can go out; otherwise detour the
 *  user to the settings form with a why. Returns null if a detour happened. */
async function requireSettings(): Promise<Settings | null> {
  const settings = await getSettings()
  if (settings.apiKey) return settings
  openSettings('Add an API key, then Save.')
  return null
}

/** One question: append the user turn (with the current crop), stream the
 *  answer into a live bubble, and record it in `history` on success. */
async function send(prompt: string): Promise<void> {
  const text = prompt.trim()
  if (!text || inflight) return
  const settings = await requireSettings()
  if (!settings) return

  const content: ApiContent = [{ type: 'text', text }]
  if (activeImage) content.push({ type: 'image_url', image_url: { url: activeImage } })
  history.push({ role: 'user', content })
  appendMessage('user', text)

  const reply = appendMessage('assistant', '…')
  const controller = new AbortController()
  inflight = controller
  setBusy(true)
  let acc = ''
  try {
    await askWithFallback({
      settings,
      messages: [{ role: 'system', content: systemPrompt() }, ...history],
      signal: controller.signal,
      onDelta: (delta) => {
        acc += delta
        reply.textContent = acc
        scrollThread()
      },
      // A fallback only fires before any text streamed, so the empty reply
      // bubble is safe to keep; the note goes ABOVE it, where it reads as an
      // event that happened before the answer.
      onFallback: (from, to, err) => {
        const note = appendMessage('note', `${modelLabel(from)} is unavailable (${err.message}) — switched to ${modelLabel(to)}.`)
        thread.insertBefore(note.parentElement!, reply.parentElement!)
        scrollThread()
      },
    })
    if (acc) history.push({ role: 'assistant', content: acc })
    else reply.textContent = '(the model returned an empty reply)'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'Cancelled.') {
      // The user pressed Stop — not a failure. Keep whatever streamed as a
      // normal turn; a stop before the first delta leaves the question open.
      if (acc) history.push({ role: 'assistant', content: acc })
      else {
        history.pop()
        reply.textContent = '(stopped)'
      }
    } else {
      // A failed turn is dropped from history so the next attempt re-sends
      // cleanly; the error bubble stays as the visible record. A partial
      // stream is kept above the message — it may still be useful.
      history.pop()
      reply.parentElement?.classList.add('error')
      reply.textContent = acc ? `${acc}\n\n[${message}]` : message
    }
  } finally {
    inflight = null
    setBusy(false)
    scrollThread()
  }
}

// Resolved once: the UI language doesn't change mid-session.
const PRESETS = presetPrompts()
for (const btn of document.querySelectorAll<HTMLButtonElement>('.preset')) {
  btn.addEventListener('click', () => {
    const prompt = PRESETS[btn.dataset.preset ?? '']
    if (prompt) void send(prompt)
  })
}

;(el('ask-form') as HTMLFormElement).addEventListener('submit', (e) => {
  e.preventDefault()
  // While a request is in flight the same button doubles as Stop.
  if (inflight) {
    inflight.abort()
    return
  }
  const input = el('ask-input') as HTMLInputElement
  const question = input.value
  input.value = ''
  void send(question)
})

// ── Settings view ────────────────────────────────────────────────────────────
// A modal detour from whatever ChatState is applied (see `current`): opened by
// the ⚙ buttons, closed by Back / Save without touching the state machine.

const setMsg = (text: string): void => {
  el('set-msg').textContent = text
}

function fillSettingsForm(s: Settings): void {
  ;(el('set-provider') as HTMLSelectElement).value = s.provider
  ;(el('set-base-url') as HTMLInputElement).value = s.baseUrl
  ;(el('set-api-key') as HTMLInputElement).value = s.apiKey
  setMsg('') // a stale validation message must not survive a fresh open
}

function openSettings(message = ''): void {
  void getSettings().then((s) => {
    fillSettingsForm(s)
    // After fillSettingsForm clears any stale message, show the caller's why
    // (e.g. the AI-answering gate that sent the user here).
    setMsg(message)
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
