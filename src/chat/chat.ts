// Study Buddy chat window (an extension page).
//
// It is embedded as an iframe by the overlay's host (src/content/overlay.ts)
// or opened as a detached popup window by the service worker's fallback. The
// initial state arrives via URL params (?kind=capture&id=…); later states are
// relayed in by the host via postMessage (no reload, the conversation survives).
//
// Views: capture (crop + task buttons + thread), the rare permission /
// restricted / error states, and a settings detour. There is no onboarding:
// the store build ships a baked key, so the extension works on install. The
// crop goes through the Gateway (src/shared/gateway.ts) and the answer streams
// into the thread, rendered as Markdown + LaTeX.

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import renderMathInElement from 'katex/contrib/auto-render'
import 'katex/dist/katex.min.css'

import type { ApiContent, ApiMessage } from '../shared/api'
import { modelLabel } from '../shared/ai'
import { DEFAULT_API_KEY, DEFAULT_BASE_URL } from '../shared/config'
import { createGateway } from '../shared/gateway'
import type { ChatState, Rect, StoredCapture } from '../shared/messages'
import { CAPTURE_PREFIX } from '../shared/messages'
import type { AnswerLanguage, Settings, UiLanguage } from '../shared/settings'
import { DEFAULT_SETTINGS, getSettings, setSettings } from '../shared/settings'
import type { UiLang } from '../shared/i18n'
import { ANSWER_LANGUAGE_LABELS, PROMPT_LANGUAGE_NAMES, browserLang, resolveUiLang, t } from '../shared/i18n'

type Kind = 'capture' | 'permission' | 'restricted' | 'error'
const KINDS: Kind[] = ['capture', 'permission', 'restricted', 'error']

const el = (id: string): HTMLElement => document.getElementById(id)!
const img = document.getElementById('crop') as HTMLImageElement
const thread = document.getElementById('thread') as HTMLElement

let uiLang: UiLang = 'en'
let settingsCache: Settings = { ...DEFAULT_SETTINGS }

// Last real state rendered; settings is a detour on top of it.
let current: ChatState = { kind: 'error', message: '' }

// ── i18n ─────────────────────────────────────────────────────────────────────

function applyI18n(): void {
  document.documentElement.lang = uiLang
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    node.textContent = t(uiLang, node.dataset.i18n!)
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    node.title = t(uiLang, node.dataset.i18nTitle!)
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    ;(node as HTMLInputElement).placeholder = t(uiLang, node.dataset.i18nPlaceholder!)
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option')
  o.value = value
  o.textContent = label
  return o
}

function uiLangOptions(): HTMLOptionElement[] {
  return [option('auto', t(uiLang, 'lang.auto')), option('en', 'English'), option('ru', 'Русский')]
}

function answerLangOptions(): HTMLOptionElement[] {
  return (Object.keys(ANSWER_LANGUAGE_LABELS) as AnswerLanguage[]).map((code) =>
    option(code, code === 'auto' ? t(uiLang, 'lang.auto') : ANSWER_LANGUAGE_LABELS[code]),
  )
}

function fillLanguageSelects(): void {
  for (const [id, make] of [
    ['set-ui-lang', uiLangOptions],
    ['set-ans-lang', answerLangOptions],
  ] as const) {
    const sel = el(id) as HTMLSelectElement
    const prev = sel.value
    sel.replaceChildren(...make())
    if (prev) sel.value = prev
  }
}

async function loadSettings(): Promise<Settings> {
  settingsCache = await getSettings()
  uiLang = resolveUiLang(settingsCache.uiLanguage, browserLang())
  applyI18n()
  fillLanguageSelects()
  return settingsCache
}

async function updateSettings(next: Settings): Promise<void> {
  settingsCache = next
  uiLang = resolveUiLang(next.uiLanguage, browserLang())
  applyI18n()
  fillLanguageSelects()
  await setSettings(next)
}

/** Settings with the baked defaults filled in: a shipped build always has a key. */
function effectiveSettings(): Settings {
  return {
    ...settingsCache,
    baseUrl: settingsCache.baseUrl || DEFAULT_BASE_URL,
    apiKey: settingsCache.apiKey || DEFAULT_API_KEY,
  }
}

// ── views ────────────────────────────────────────────────────────────────────

function show(kind: Kind | 'settings'): void {
  for (const k of KINDS) el(`view-${k}`).hidden = k !== kind
  el('view-settings').hidden = kind !== 'settings'
}

function apply(state: ChatState): void {
  current = state
  show(state.kind)
  switch (state.kind) {
    case 'capture':
      void showCapture(state.imageId)
      break
    case 'permission':
      showPermission(state.origin)
      break
    case 'restricted':
      showText('restricted-text', t(uiLang, 'state.restrictedText', { reason: state.reason }))
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
    apply({ kind: 'error', message: t(uiLang, 'state.expired') })
    return
  }
  activeImage = stored.dataUrl
  img.src = stored.dataUrl
  ensureHint()
}

function showPermission(origin: string): void {
  showText(
    'perm-text',
    origin
      ? t(uiLang, 'state.permissionText', { origin })
      : t(uiLang, 'state.permissionTextNoOrigin'),
  )
  const btn = document.getElementById('perm-btn') as HTMLButtonElement
  btn.onclick = async () => {
    // The permission request must be triggered by this user gesture (an
    // extension page may call chrome.permissions.request). If the SW was
    // recycled and the origin wasn't carried along, resolve it live.
    const target = origin || (await resolveActiveOrigin())
    if (!target) {
      apply({ kind: 'error', message: t(uiLang, 'state.noActiveTab') })
      return
    }
    const granted = await chrome.permissions.request({ origins: [`${target}/*`] }).catch(() => false)
    if (!granted) return // user declined; stay on the prompt
    showText('perm-text', t(uiLang, 'state.granted'))
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

// ── settings view ────────────────────────────────────────────────────────────

function setMsg(text: string): void {
  el('set-msg').textContent = text
}

function fillSettingsForm(s: Settings): void {
  ;(el('set-ui-lang') as HTMLSelectElement).value = s.uiLanguage
  ;(el('set-ans-lang') as HTMLSelectElement).value = s.answerLanguage
  ;(el('set-provider') as HTMLSelectElement).value = s.provider
  ;(el('set-base-url') as HTMLInputElement).value = s.baseUrl
  ;(el('set-api-key') as HTMLInputElement).value = s.apiKey
  setMsg('')
}

function openSettings(message = ''): void {
  fillSettingsForm(settingsCache)
  setMsg(message)
  show('settings')
}

function restoreView(): void {
  apply(current)
}

// Provider switching: picking the preset repairs the URL if it still shows the
// custom default (or was left empty); a user-typed URL is left alone.
;(el('set-provider') as HTMLSelectElement).onchange = (e) => {
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

;(el('set-save') as HTMLButtonElement).onclick = async () => {
  const baseUrlInput = (el('set-base-url') as HTMLInputElement).value.trim()
  // The URL constructor accepts e.g. "https://x" and any scheme — an http(s)
  // check is the actual gate, not mere parseability. Empty = use the default.
  if (baseUrlInput) {
    try {
      const u = new URL(baseUrlInput)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)')
    } catch {
      setMsg(t(uiLang, 'err.badUrl'))
      return
    }
  }
  await updateSettings({
    provider: (el('set-provider') as HTMLSelectElement).value as Settings['provider'],
    baseUrl: baseUrlInput,
    apiKey: (el('set-api-key') as HTMLInputElement).value.trim(),
    uiLanguage: (el('set-ui-lang') as HTMLSelectElement).value as UiLanguage,
    answerLanguage: (el('set-ans-lang') as HTMLSelectElement).value as AnswerLanguage,
  })
  restoreView()
}

;(el('set-back') as HTMLButtonElement).onclick = () => restoreView()

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-goto-settings]')) {
  btn.onclick = () => openSettings()
}
;(el('settings-btn') as HTMLButtonElement).onclick = () => openSettings()

// One handler for every show/hide key button.
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-key-toggle]')) {
  btn.onclick = () => {
    const input = el(btn.dataset.keyToggle!) as HTMLInputElement
    const showKey = input.type === 'password'
    input.type = showKey ? 'text' : 'password'
    btn.textContent = showKey ? '🚫' : '👁'
  }
}

// ── capture actions ──────────────────────────────────────────────────────────

;(el('new-selection-btn') as HTMLButtonElement).onclick = () => {
  void chrome.runtime.sendMessage({ type: 'START_SELECTION' }).catch(() => {})
}

// ── answer rendering ─────────────────────────────────────────────────────────
// Answers are Markdown with LaTeX. Render once the stream ends; during the
// stream the bubble shows plain text (cheap), so KaTeX never re-typesets on
// every token. DOMPurify guards the HTML; KaTeX runs with trust:false.

function renderAnswer(node: HTMLElement, text: string): void {
  const html = marked.parse(text, { gfm: true, breaks: true }) as string
  node.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
  renderMathInElement(node, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
  })
}

// ── AI answering ─────────────────────────────────────────────────────────────
// The thread is held in memory, not persisted: the host reuses this iframe
// across captures, so `history` keeps the conversation's context.

let activeImage: string | null = null
const history: ApiMessage[] = []
let inflight: AbortController | null = null

/** Language the model is told to answer in for app-generated prompts. */
function targetLanguageName(): string {
  const code = settingsCache.answerLanguage
  if (code !== 'auto') return PROMPT_LANGUAGE_NAMES[code]
  return uiLang === 'ru' ? 'Russian' : 'English'
}

function systemPrompt(): string {
  const base =
    'You are Study Buddy, a concise and friendly tutor. The user shares a screenshot ' +
    'of part of their screen and asks about what is visible. Solve or explain ' +
    'exercises and translate text. Ground every answer in the image; if something ' +
    'is unreadable or not present, say so instead of guessing. ' +
    'Format answers in Markdown; use LaTeX for math ($...$ inline, $$...$$ display).'
  const lang =
    settingsCache.answerLanguage !== 'auto'
      ? `Language: always answer in ${targetLanguageName()}, unless the user explicitly asks for another language.`
      : 'Language: answer in the language the user writes in. For the app\u2019s fixed ' +
        `actions (which carry no prose of their own), answer in ${targetLanguageName()}. ` +
        'If the user explicitly asks to answer in, or translate into, a particular language, follow that.'
  return `${base}\n\n${lang}`
}

/** Task-shaped prompts: each button asks for a specific answer STRUCTURE, not a
 *  vague "ask AI". Composed per call so it always uses the current language. */
function presetPrompts(): Record<string, string> {
  const lang = targetLanguageName()
  return {
    solve:
      'Solve the problem shown in the image. Reply in this exact structure:\n' +
      '1) Answer: ...\n2) Steps: ...\n3) Check / common mistakes: ...\n' +
      `Write in ${lang}.`,
    quiz:
      'This is a multiple-choice question. Reply in this structure:\n' +
      '1) Correct option: ...\n2) Why it is correct: ...\n3) Why each other option is wrong: ...\n' +
      `Write in ${lang}.`,
    explain:
      'Explain what is shown to a student. Reply in this structure:\n' +
      '1) In one sentence: ...\n2) Step by step: ...\n3) Key terms: ...\n' +
      `Write in ${lang}.`,
    translate:
      `Translate all the text in the image into ${lang}. If it is already in ${lang}, ` +
      'translate it into English instead. Output the translation only — do not restate ' +
      'the original text.',
    summarize: `Summarize what is shown in 3-5 key points.\nWrite in ${lang}.`,
  }
}

interface Msg {
  wrap: HTMLDivElement
  body: HTMLDivElement
  /** Plain text of the answer (for clipboard), independent of the rendered HTML. */
  raw: string
}

function ensureHint(): void {
  if (thread.children.length || thread.querySelector('.hint')) return
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = t(uiLang, 'capture.hint')
  thread.appendChild(hint)
}

function scrollThread(): void {
  thread.scrollTop = thread.scrollHeight
}

function addMessage(role: 'user' | 'assistant' | 'error' | 'note', text: string): Msg {
  thread.querySelector('.hint')?.remove()
  const wrap = document.createElement('div')
  wrap.className = `msg ${role}`
  const body = document.createElement('div')
  body.className = 'msg-body'
  body.textContent = text
  wrap.appendChild(body)
  thread.appendChild(wrap)
  scrollThread()
  return { wrap, body, raw: text }
}

function addActions(msg: Msg, canRegenerate: boolean): void {
  const actions = document.createElement('div')
  actions.className = 'msg-actions'

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = t(uiLang, 'msg.copy')
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(msg.raw)
    } catch {
      return // clipboard blocked; leave the label alone
    }
    copy.textContent = t(uiLang, 'msg.copied')
    setTimeout(() => (copy.textContent = t(uiLang, 'msg.copy')), 1200)
  }
  actions.appendChild(copy)

  const simpler = document.createElement('button')
  simpler.type = 'button'
  simpler.textContent = t(uiLang, 'msg.simpler')
  simpler.onclick = () =>
    void send(
      'Explain your previous answer in simpler terms, more briefly, with a concrete example if helpful. ' +
        `Write in ${targetLanguageName()}.`,
    )
  actions.appendChild(simpler)

  if (canRegenerate) {
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.dataset.retry = '1'
    retry.textContent = t(uiLang, 'msg.retry')
    retry.onclick = () => void regenerate()
    actions.appendChild(retry)
  }

  msg.wrap.appendChild(actions)
}

function clearRetryButtons(): void {
  for (const b of thread.querySelectorAll('[data-retry]')) b.remove()
}

function setBusy(busy: boolean): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.preset')) b.disabled = busy
  ;(el('ask-input') as HTMLInputElement).disabled = busy
  ;(el('ask-btn') as HTMLButtonElement).textContent = t(uiLang, busy ? 'ask.stop' : 'ask.button')
}

/** With a baked key this always succeeds; the settings detour is the dev-only
 *  path when a build carries no key and none was entered. */
async function requireSettings(): Promise<Settings | null> {
  const settings = effectiveSettings()
  if (settings.apiKey) return settings
  openSettings(t(uiLang, 'err.needKey'))
  return null
}

/** Stream the answer to the current `history` into a fresh bubble. */
async function streamReply(): Promise<void> {
  const reply = addMessage('assistant', '…')
  const controller = new AbortController()
  inflight = controller
  setBusy(true)
  let acc = ''
  try {
    await createGateway(settingsCache).ask({
      messages: [{ role: 'system', content: systemPrompt() }, ...history],
      signal: controller.signal,
      onDelta: (delta) => {
        acc += delta
        reply.raw = acc
        reply.body.textContent = acc // plain while streaming; rendered on finish
        scrollThread()
      },
      onFallback: (from, to, err) => {
        const note = addMessage(
          'note',
          t(uiLang, 'msg.fallback', { from: modelLabel(from), to: modelLabel(to), reason: err.message }),
        )
        thread.insertBefore(note.wrap, reply.wrap)
        scrollThread()
      },
    })
    if (acc) {
      history.push({ role: 'assistant', content: acc })
      renderAnswer(reply.body, acc)
      clearRetryButtons()
      addActions(reply, true)
    } else {
      reply.body.textContent = t(uiLang, 'msg.emptyReply')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'Cancelled.') {
      // User pressed Stop — keep the partial answer as a normal turn (rendered).
      if (acc) {
        history.push({ role: 'assistant', content: acc })
        renderAnswer(reply.body, acc)
        clearRetryButtons()
        addActions(reply, true)
      } else {
        history.pop()
        reply.body.textContent = t(uiLang, 'msg.stopped')
      }
    } else {
      // Drop the failed turn so a retry re-sends cleanly.
      history.pop()
      reply.wrap.classList.add('error')
      reply.body.textContent = acc ? `${acc}\n\n[${message}]` : message
    }
  } finally {
    inflight = null
    setBusy(false)
    scrollThread()
  }
}

async function send(prompt: string): Promise<void> {
  const text = prompt.trim()
  if (!text || inflight) return
  const settings = await requireSettings()
  if (!settings) return
  const content: ApiContent = [{ type: 'text', text }]
  if (activeImage) content.push({ type: 'image_url', image_url: { url: activeImage } })
  history.push({ role: 'user', content })
  addMessage('user', text)
  await streamReply()
}

/** Re-ask the last user turn: drop the last assistant answer and re-run. */
async function regenerate(): Promise<void> {
  if (inflight) return
  if (history[history.length - 1]?.role !== 'assistant') return
  history.pop()
  const assistants = thread.querySelectorAll('.msg.assistant')
  assistants[assistants.length - 1]?.remove()
  scrollThread()
  await streamReply()
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('.preset')) {
  btn.addEventListener('click', () => {
    const prompt = presetPrompts()[btn.dataset.preset ?? '']
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

async function boot(): Promise<void> {
  await loadSettings()
  apply(stateFromLocation() ?? { kind: 'error', message: t(uiLang, 'state.noState') })
}

void boot()
