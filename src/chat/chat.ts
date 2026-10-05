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
import { chatCompletion } from '../shared/api'
import type { ChatState, Rect, StoredCapture } from '../shared/messages'
import { CAPTURE_PREFIX } from '../shared/messages'
import { fetchVisionModels } from '../shared/models'
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

// One voice for the model's role: concise tutor, grounded in the screenshot,
// never inventing content that isn't there. Kept short — the preset prompts
// below carry the task-specific instruction.
const SYSTEM_PROMPT =
  'You are Study Buddy, a concise and friendly tutor. The user shares a screenshot ' +
  'of part of their screen and asks about what is visible. Solve or explain ' +
  'exercises and translate text. Ground every answer in the image; if something ' +
  'is unreadable or not present, say so instead of guessing.'

// Preset button label → the instruction sent with the crop. English on purpose:
// vision models follow it most reliably, regardless of the answer's language.
const PRESET_PROMPTS: Record<string, string> = {
  solve: 'Solve the exercise shown in the image. Give the final answer first, then a short step-by-step solution.',
  explain: 'Explain what is shown in the image, step by step, as a patient tutor.',
  translate: 'Translate all the text in the image into English, keeping the layout where it matters.',
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
function appendMessage(role: 'user' | 'assistant' | 'error', text: string): HTMLDivElement {
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
  if (settings.apiKey && settings.model) return settings
  openSettings('Add an API key and choose a model, then Save.')
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
    await chatCompletion({
      settings,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      signal: controller.signal,
      onDelta: (delta) => {
        acc += delta
        reply.textContent = acc
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

for (const btn of document.querySelectorAll<HTMLButtonElement>('.preset')) {
  btn.addEventListener('click', () => {
    const prompt = PRESET_PROMPTS[btn.dataset.preset ?? '']
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
  ;(el('set-model') as HTMLInputElement).value = s.model
  setMsg('') // a stale validation message must not survive a fresh open
  modelNote('')
}

/** Status line under the model field (load progress / result), separate from
 *  the red Save-validation message so the two can't overwrite each other. */
function modelNote(text: string, isError = false): void {
  const note = el('set-model-note')
  note.textContent = text
  note.classList.toggle('err', isError)
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

// Populate the model datalist from the endpoint's /models. The field stays
// free-text, so a model missing from the list can still be typed by hand; the
// datalist only saves spelling. fetchVisionModels needs the CURRENT form's
// base URL and key — not the saved ones — so the list matches what's typed.
;(el('set-load-models') as HTMLButtonElement).onclick = async () => {
  const apiKey = (el('set-api-key') as HTMLInputElement).value.trim()
  if (!apiKey) {
    modelNote('Enter an API key first.', true)
    return
  }
  const settings: Settings = {
    provider: (el('set-provider') as HTMLSelectElement).value as Settings['provider'],
    baseUrl: (el('set-base-url') as HTMLInputElement).value.trim(),
    apiKey,
    model: (el('set-model') as HTMLInputElement).value.trim(),
  }
  const btn = el('set-load-models') as HTMLButtonElement
  btn.disabled = true
  modelNote('Loading…')
  try {
    const { models, filtered } = await fetchVisionModels(settings)
    const list = el('model-options') as HTMLDataListElement
    list.replaceChildren(
      ...models.map((m) => {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.label = m.name
        return opt
      }),
    )
    modelNote(
      filtered
        ? `Loaded ${models.length} vision models. Pick one, or type an id.`
        : `Loaded ${models.length} models — this endpoint doesn't report which are vision-capable, so the list isn't filtered.`,
    )
    setMsg('')
  } catch (err) {
    modelNote(err instanceof Error ? err.message : String(err), true)
  } finally {
    btn.disabled = false
  }
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
