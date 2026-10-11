// Study Buddy chat window (an extension page).
//
// It is embedded as an iframe by the overlay's host (src/content/overlay.ts)
// or opened as a detached popup window by the service worker's fallback. The
// initial state arrives via URL params (?kind=capture&id=…); later states are
// relayed in by the host via postMessage (no reload, the conversation survives).
//
// Views: capture (crop + task actions + thread), the rare permission /
// restricted / error states, and a settings detour. Provider configuration is
// supplied by the development runtime; user settings only control languages.
// The crop goes through the Gateway and the answer streams into the thread,
// rendered as Markdown + LaTeX.

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import renderMathInElement from 'katex/contrib/auto-render'
import 'katex/dist/katex.min.css'

import { ApiError } from '../shared/api'
import { createGateway } from '../shared/gateway'
import type { ChatState, Rect } from '../shared/messages'
import { conversationUsage, getAttachment, getConversation, getConversationState, listConversations } from '../shared/conversation-store'
import { conversationActivityAt, conversationDisplayTitle, cooldownRemaining, requestContext, type Conversation, type ConversationState, type ReplyStatus, type Turn } from '../shared/conversations'
import { conversationAction, GenerationConnection } from './conversation-client'
import type { AnswerLanguage, Settings, UiLanguage } from '../shared/settings'
import { DEFAULT_SETTINGS, getSettings, resolveSettings, setSettings } from '../shared/settings'
import type { UiLang } from '../shared/i18n'
import { ANSWER_LANGUAGE_LABELS, browserLang, resolveUiLang, t } from '../shared/i18n'
import { createResponseTitleParser } from '../shared/title'
import { checkPrompt, firstAnswerTitleInstruction, PROMPTS_VERSION, simplerPrompt, systemPrompt, taskPrompt, turnParams, type TaskId, type TurnKind } from '../shared/prompts'

type Kind = 'capture' | 'permission' | 'restricted' | 'error'
const KINDS: Kind[] = ['capture', 'permission', 'restricted', 'error']

const el = (id: string): HTMLElement => document.getElementById(id)!
const img = document.getElementById('crop') as HTMLImageElement
const lightbox = document.getElementById('lightbox') as HTMLDialogElement
const lightboxImg = lightbox.querySelector('img') as HTMLImageElement
const thread = document.getElementById('thread') as HTMLElement

let lightboxOpener: HTMLElement | undefined

function closeLightbox(): void {
  if (lightbox.open) lightbox.close()
}

function openLightbox(source: HTMLElement, src: string): void {
  if (!src) return
  lightboxOpener = source
  lightboxImg.src = src
  lightbox.showModal()
}

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
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(uiLang, node.dataset.i18nAria!))
  }
  for (const node of document.querySelectorAll<HTMLImageElement>('[data-i18n-alt]')) {
    node.alt = t(uiLang, node.dataset.i18nAlt!)
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
  await setSettings(next)
  settingsCache = next
  uiLang = resolveUiLang(next.uiLanguage, browserLang())
  applyI18n()
  fillLanguageSelects()
}

// ── views ────────────────────────────────────────────────────────────────────

function show(kind: Kind | 'settings' | 'history'): void {
  for (const k of KINDS) el(`view-${k}`).hidden = k !== kind
  el('view-settings').hidden = kind !== 'settings'
  el('view-history').hidden = kind !== 'history'
}

function apply(state: ChatState): void {
  opening++
  pendingConversationId = undefined
  current = state
  historyEntry = state.kind === 'history'
  show(state.kind === 'conversation' ? 'capture' : state.kind)
  switch (state.kind) {
    case 'capture':
      void showCapture(state.imageId, state.conversationId).catch(reportError)
      break
    case 'conversation':
      void openConversation(state.conversationId).catch(reportError)
      break
    case 'history':
      void showHistory().catch(reportError)
      break
    case 'permission':
      showPermission(state.origin)
      break
    case 'restricted':
      showText('restricted-text', t(uiLang, 'state.restrictedText', { reason: state.reason }))
      break
    case 'error':
      showText('error-text', state.message.startsWith('storage.') ? t(uiLang, 'dialog.storageError') : state.message)
      break
  }
}

async function showCapture(imageId: string, conversationId?: string): Promise<void> {
  if (closing) return
  const state = await getConversationState()
  if (closing) return
  const id = conversationId ?? conversation?.id ?? state.lastConversationId
  const target = id ? await getConversation(id) : undefined
  if (closing) return
  const selected = target ?? await conversationAction<Conversation>({ action: 'create', title: t(uiLang, 'dialog.new') })
  if (closing) return
  await conversationAction({ action: 'attach', conversationId: selected.id, imageId })
  if (closing) return
  await openConversation(selected.id)
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

;(el('set-save') as HTMLButtonElement).onclick = async () => {
  let existing: Settings
  try {
    existing = await getSettings()
  } catch {
    setMsg(t(uiLang, 'err.storageRead'))
    return
  }
  try {
    await updateSettings({
      ...existing,
      uiLanguage: (el('set-ui-lang') as HTMLSelectElement).value as UiLanguage,
      answerLanguage: (el('set-ans-lang') as HTMLSelectElement).value as AnswerLanguage,
    })
    restoreView()
  } catch {
    setMsg(t(uiLang, 'err.storageWrite'))
  }
}

;(el('set-back') as HTMLButtonElement).onclick = () => restoreView()

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-goto-settings]')) {
  btn.onclick = () => openSettings()
}
// Settings is intentionally unavailable in the current UI. Keep its handler disabled with the commented-out control.

// ── capture actions ──────────────────────────────────────────────────────────

;(el('new-selection-btn') as HTMLButtonElement).onclick = () => {
  void chrome.runtime.sendMessage({ type: 'START_SELECTION' }).catch(() => {})
}

// ── answer rendering ─────────────────────────────────────────────────────────
// Answers are Markdown with LaTeX. Render once the stream ends; during the
// stream the bubble shows plain text (cheap), so KaTeX never re-typesets on
// every token. DOMPurify guards the HTML; KaTeX runs with trust:false.

function renderAnswer(node: HTMLElement, text: string): void {
  // 1) Models sometimes emit TeX delimiters \( \) / \[ \] instead of $ / $$.
  //    marked strips the backslash as a Markdown escape BEFORE KaTeX runs,
  //    which destroys those delimiters — normalize to $ / $$ first.
  let src = text
    .replace(/\\\[/g, '\n$$\n')
    .replace(/\\\]/g, '\n$$\n')
    .replace(/\\\(/g, '$')
    .replace(/\\\)/g, '$')

  // 2) With breaks:true, marked turns newlines inside a $$...$$ block into
  //    <br>, splitting the text nodes KaTeX auto-render matches on — multi-line
  //    display math then renders as raw LaTeX. Protect every math span with a
  //    placeholder, parse Markdown, restore afterwards.
  const mathSpans: string[] = []
  src = src.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => {
    // A lone backslash before a newline is a broken line break (e.g. rows of
    // \begin{cases}); make it a proper \\ so KaTeX renders the rows.
    mathSpans.push(m.replace(/(?<!\\)\\\n/g, '\\\\\n'))
    return `SBMATH${mathSpans.length - 1}SB`
  })

  const html = marked.parse(src, { gfm: true, breaks: true }) as string
  node.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })

  // Restore the math spans as TEXT: they survived sanitize untouched; putting
  // them back via innerHTML would let stray < or & be parsed as markup.
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
  for (const tn of textNodes) {
    if (!tn.data.includes('SBMATH')) continue
    tn.data = tn.data.replace(/SBMATH(\d+)SB/g, (_, i) => mathSpans[Number(i)])
  }
  renderMathInElement(node, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
  })
}

// ── AI answering ─────────────────────────────────────────────────────────────
let conversation: Conversation | undefined
let profileState: ConversationState = { id: 'state', lastStartedAt: 0 }
let opening = 0
let pendingConversationId: string | undefined
let rendering = 0
let starting = false
let closing = false
let activeCloseId: string | undefined
let historyEntry = false
let generationDone: Promise<boolean> | undefined
const unsaved = new Map<string, Turn>()
const imageUrls = new Map<string, string>()
let inflight: AbortController | null = null

function reportError(err: unknown): void {
  const key = err instanceof Error ? err.message : 'storage.write'
  const cooldown = key.startsWith('dialog.cooldown:')
  el('dialog-status').textContent = cooldown ? t(uiLang, 'dialog.cooldown', { seconds: key.split(':')[1] }) : t(uiLang, key.startsWith('storage.') ? 'dialog.storageError' : key)
  el('operation-error').textContent = el('dialog-status').textContent
  el('operation-error').hidden = false
}

async function imageUrl(id: string): Promise<string> {
  const cached = imageUrls.get(id)
  if (cached) return cached
  const attachment = await getAttachment(id)
  if (!attachment) throw new Error('context.imageMissing')
  const existing = imageUrls.get(id)
  if (existing) return existing
  const url = URL.createObjectURL(attachment.data)
  imageUrls.set(id, url)
  return url
}

function releaseImages(): void {
  for (const url of imageUrls.values()) URL.revokeObjectURL(url)
  imageUrls.clear()
}

async function openConversation(id: string): Promise<void> {
  if (closing) return
  const epoch = ++opening
  pendingConversationId = id
  let value: Conversation
  try {
    value = await conversationAction<Conversation>({ action: 'select', conversationId: id })
  } catch (err) {
    if (epoch === opening && pendingConversationId === id) pendingConversationId = undefined
    throw err
  }
  if (epoch !== opening) return
  conversation = value
  pendingConversationId = undefined
  current = { kind: 'conversation', conversationId: id }
  if (window.parent !== window) {
    window.parent.postMessage(
      { source: 'study-buddy-chat', action: 'conversation-selected', conversationId: id },
      '*',
    )
  }
  show('capture')
  await renderConversation()
}

async function renderConversation(): Promise<void> {
  if (!conversation) return
  const epoch = ++rendering
  const selected = conversation
  el('conversation-title').textContent = conversationDisplayTitle(selected, t(uiLang, 'dialog.new'))
  if (lightbox.open) lightbox.close()
  if (selected.activeAttachmentId) {
    const url = await imageUrl(selected.activeAttachmentId)
    if (epoch !== rendering) return
    img.src = url
    el('crop-figure').hidden = false
  } else {
    img.removeAttribute('src')
    el('crop-figure').hidden = true
  }
  if (inflight || starting) { await refreshStatus(); return }
  thread.replaceChildren()
  for (const turn of selected.turns) {
    const msg = addMessage(turn.role, turn.role === 'user' ? turn.display ?? turn.text : turn.text)
    msg.wrap.dataset.turn = turn.id
    if (turn.role === 'user' && turn.attachmentId) {
      const thumbnail = document.createElement('img')
      thumbnail.className = 'turn-image'
      thumbnail.alt = t(uiLang, 'dialog.attachment')
      thumbnail.src = await imageUrl(turn.attachmentId)
      if (epoch !== rendering) return
      thumbnail.tabIndex = 0
      thumbnail.setAttribute('role', 'button')
      thumbnail.setAttribute('aria-label', t(uiLang, 'dialog.imagePreview'))
      thumbnail.onclick = () => openLightbox(thumbnail, thumbnail.src)
      thumbnail.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLightbox(thumbnail, thumbnail.src) }
      }
      msg.wrap.appendChild(thumbnail)
    }
    if (turn.role === 'assistant') {
      if (turn.note) {
        const note = addMessage('note', turn.note)
        thread.insertBefore(note.wrap, msg.wrap)
      }
      renderAnswer(msg.body, turn.text)
      const status = document.createElement('div')
      status.className = 'reply-status'
      status.textContent = t(uiLang, `reply.${turn.status ?? 'interrupted'}`) + (turn.error ? ` — ${turn.error}` : '')
      msg.wrap.appendChild(status)
      addActions(msg, turn.id === selected.turns.at(-1)?.id)
    }
  }
  ensureHint()
  await refreshStatus()
}

async function refreshStatus(): Promise<void> {
  profileState = await getConversationState()
  updateStatus()
}

function updateStatus(): void {
  setBusy(!!inflight || starting || !!profileState.generation)
  const wait = cooldownRemaining(profileState.lastStartedAt)
  const text = profileState.generation ? t(uiLang, 'reply.streaming') : wait ? t(uiLang, 'dialog.cooldown', { seconds: Math.ceil(wait / 1000) }) : t(uiLang, 'dialog.saved')
  if (!unsaved.size) el('dialog-status').textContent = text
  if (window.parent !== window) window.parent.postMessage({ source: 'study-buddy-chat', action: 'status', text, lang: uiLang }, '*')
}

/** Prompt context from the current settings (answer language + resolved UI). */
function promptCtx() {
  return { answerLanguage: settingsCache.answerLanguage, uiLang }
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

/** 16px stroke icons for the per-answer actions — text labels ate half the
 *  panel width; icons + tooltips keep the thread readable. */
const ACTION_ICONS = {
  copy: '<rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 3.5h-6a1.5 1.5 0 0 0-1.5 1.5v6"/>',
  copied: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
  simpler: '<text x="1.5" y="12.5" font-size="10" stroke="none" fill="currentColor" font-family="system-ui,sans-serif">A</text><text x="9" y="12.5" font-size="8" stroke="none" fill="currentColor" font-family="system-ui,sans-serif">a</text>',
  retry: '<path d="M13.5 8a5.5 5.5 0 1 1-1.7-4"/><path d="M13.5 1.5V4H11"/>',
} as const

function iconButton(icon: keyof typeof ACTION_ICONS, label: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.title = label
  b.setAttribute('aria-label', label)
  b.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS[icon]}</svg>`
  return b
}

function addActions(msg: Msg, canRegenerate: boolean): void {
  const actions = document.createElement('div')
  actions.className = 'msg-actions'

  const copy = iconButton('copy', t(uiLang, 'msg.copy'))
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(msg.raw)
    } catch {
      return // clipboard blocked; leave the icon alone
    }
    copy.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS.copied}</svg>`
    copy.title = t(uiLang, 'msg.copied')
    setTimeout(() => {
      copy.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS.copy}</svg>`
      copy.title = t(uiLang, 'msg.copy')
    }, 1200)
  }
  actions.appendChild(copy)

  const simpler = iconButton('simpler', t(uiLang, 'msg.simpler'))
  simpler.dataset.generation = '1'
  simpler.onclick = () => void send(simplerPrompt(promptCtx()), 'simpler', t(uiLang, 'msg.simpler')).catch(reportError)
  actions.appendChild(simpler)

  if (canRegenerate) {
    const retry = iconButton('retry', t(uiLang, 'msg.retry'))
    retry.dataset.retry = '1'
    retry.dataset.generation = '1'
    retry.onclick = () => void regenerate().catch(reportError)
    actions.appendChild(retry)
  }

  msg.wrap.appendChild(actions)
}

function clearRetryButtons(): void {
  for (const b of thread.querySelectorAll('[data-retry]')) b.remove()
}

function setBusy(busy: boolean): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.preset')) b.disabled = busy
  ;(el('more-btn') as HTMLButtonElement).disabled = busy
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-generation], #check-submit, #new-chat-btn')) b.disabled = busy
  ;(el('ask-input') as HTMLInputElement).disabled = busy
  ;(el('ask-btn') as HTMLButtonElement).disabled = busy && !inflight
  ;(el('ask-btn') as HTMLButtonElement).textContent = t(uiLang, inflight ? 'ask.stop' : 'ask.button')
}

async function requireSettings(): Promise<Settings | null> {
  try { await loadSettings() } catch { reportError(new Error('storage.read')); return null }
  try {
    const settings = resolveSettings(settingsCache)
    if (settings.apiKey) return settings
  } catch {
    // An unavailable runtime connection is reported without exposing setup fields.
  }
  reportError(new Error('err.notConnected'))
  return null
}

/** Persist the accepted turn before any provider operation; only this port writes. */
async function streamReply(settings: Settings, user: Turn | null, source: Turn): Promise<boolean> {
  if (!conversation) return false
  const selectedId = conversation.id
  const promptContext = { answerLanguage: settings.answerLanguage, uiLang: source.locale }
  const requestTitle = !!user && conversation.turns.length === 0 && conversation.titleGeneratedAt === undefined
  const titleParser = requestTitle ? createResponseTitleParser() : undefined
  let generatedTitle: string | undefined
  let titleParserFinished = false
  const assistant: Turn = { id: crypto.randomUUID(), role: 'assistant', text: '', kind: source.kind, status: 'streaming', replyTo: source.id, createdAt: Date.now(), locale: uiLang, promptVersion: PROMPTS_VERSION }
  const controller = new AbortController()
  let lost = false
  const connection = new GenerationConnection(() => { lost = true; controller.abort() })
  let reply: Msg | undefined
  let acc = ''
  let status: ReplyStatus = 'interrupted'
  let error: string | undefined
  let fallbackNote: string | undefined
  let write: Promise<unknown> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let storageFailed = false
  const persist = (final: ReplyStatus) => {
    write = write.then(() => connection.request({ action: 'update', text: acc, status: final, error, note: fallbackNote, title: generatedTitle }))
    return write
  }
  starting = true
  inflight = controller
  el('operation-error').hidden = true
  setBusy(true)
  try {
    const accepted = await connection.request<{ conversation: Conversation }>({ action: 'start', conversationId: selectedId, user, assistant })
    conversation = accepted.conversation
    el('conversation-title').textContent = conversation.title
    starting = false
    if (user) addMessage('user', user.display ?? user.text).wrap.dataset.turn = user.id
    reply = addMessage('assistant', '…')
    reply.wrap.dataset.turn = assistant.id
    await refreshStatus()
    const index = conversation.turns.findIndex((turn) => turn.id === source.id)
    const context = await requestContext({ ...conversation, turns: conversation.turns.slice(0, index + 1) }, async (id) => (await getAttachment(id))?.data)
    if (context.omitted) addMessage('note', t(uiLang, 'context.omitted', { count: context.omitted }))
    const result = await createGateway(settings).ask({
      messages: [{ role: 'system', content: systemPrompt(promptContext) + (requestTitle ? `\n\n${firstAnswerTitleInstruction(promptContext)}` : '') }, ...context.messages],
      ...turnParams(source.kind),
      signal: controller.signal,
      onDelta: (delta) => {
        acc += titleParser ? titleParser.push(delta) : delta
        generatedTitle = titleParser?.title ?? generatedTitle
        if (generatedTitle && conversation) el('conversation-title').textContent = conversationDisplayTitle({ ...conversation, title: generatedTitle, titleGeneratedAt: Date.now() }, t(uiLang, 'dialog.new'))
        reply!.raw = acc
        reply!.body.textContent = acc
        scrollThread()
        if (!timer) timer = setTimeout(() => {
          timer = undefined
          void persist('streaming').catch(() => { storageFailed = true; controller.abort() })
        }, 300)
      },
      onFallback: () => {
        fallbackNote = t(uiLang, 'msg.fallback')
        const note = addMessage('note', fallbackNote)
        thread.insertBefore(note.wrap, reply!.wrap)
      },
    })
    if (!titleParser) acc = result.text
    status = result.status
  } catch (err) {
    if (!reply) { reportError(err); return false }
    status = lost || storageFailed ? 'interrupted' : controller.signal.aborted ? 'cancelled' : err instanceof ApiError && ['network', 'interrupted', 'response'].includes(err.kind) ? 'interrupted' : 'provider_error'
    error = err instanceof ApiError ? err.message : undefined
  } finally {
    if (timer) clearTimeout(timer)
    if (reply) {
      if (titleParser && !titleParserFinished) {
        const tail = titleParser.finish()
        titleParserFinished = true
        acc += tail.text
        generatedTitle = tail.title ?? generatedTitle
        reply.body.textContent = acc || '…'
        reply.raw = acc
      }
      if (titleParser && status === 'complete' && !acc.trim()) status = 'empty'
      if (lost) storageFailed = true
      try { if (!storageFailed) await persist(status) } catch { storageFailed = true }
      const savedTurn = { ...assistant, text: acc, status, error, note: fallbackNote }
      renderAnswer(reply.body, acc)
      reply.raw = acc
      const note = document.createElement('div')
      note.className = 'reply-status'
      note.textContent = t(uiLang, storageFailed ? 'dialog.unsaved' : `reply.${status}`) + (error ? ` — ${error}` : '')
      reply.wrap.appendChild(note)
      if (storageFailed) { unsaved.set(assistant.id, savedTurn); reportError(new Error('storage.write')) }
      clearRetryButtons()
      addActions(reply, true)
    }
    inflight = null
    starting = false
    connection.close()
    conversation = await getConversation(selectedId).catch(() => conversation)
    await refreshStatus().catch(reportError)
    scrollThread()
  }
  return true
}

async function send(prompt: string, kind: TurnKind = 'ask', display?: string, input?: string): Promise<boolean> {
  if (!prompt.trim() || inflight || starting || !conversation) return false
  // Reserve before the asynchronous settings read: rapid events in this page
  // must not replace its Stop controller even if the worker rejects the loser.
  starting = true
  setBusy(true)
  try {
    const settings = await requireSettings()
    if (!settings || closing) return false
    const text = kind === 'ask' ? prompt : kind === 'check' ? checkPrompt(input!, promptCtx()) : kind === 'simpler' ? simplerPrompt(promptCtx()) : taskPrompt(kind, promptCtx())
    const label = kind === 'ask' ? display : kind === 'check' ? `${t(uiLang, 'preset.check')}\n${input}` : kind === 'simpler' ? t(uiLang, 'msg.simpler') : t(uiLang, `preset.${kind}`)
    const user: Turn = { id: crypto.randomUUID(), role: 'user', text, display: label, input: input ?? (kind === 'ask' ? prompt : undefined), kind, createdAt: Date.now(), locale: uiLang, promptVersion: PROMPTS_VERSION, attachmentId: conversation.activeAttachmentId }
    generationDone = streamReply(settings, user, user)
    return await generationDone
  } finally { starting = false; updateStatus() }
}

async function regenerate(): Promise<void> {
  if (inflight || starting || !conversation) return
  const last = [...conversation.turns].reverse().find((turn) => turn.role === 'user')
  if (!last) return
  starting = true
  setBusy(true)
  try {
    const settings = await requireSettings()
    if (!settings || closing) return
    generationDone = streamReply(settings, null, last)
    await generationDone
  } finally { starting = false; updateStatus() }
}

const moreButton = el('more-btn') as HTMLButtonElement
const moreActions = el('more-actions') as HTMLElement
moreActions.addEventListener('beforetoggle', (event) => {
  const opening = (event as ToggleEvent).newState === 'open'
  moreButton.setAttribute('aria-expanded', opening ? 'true' : 'false')
  if (!opening) return
  const rect = moreButton.getBoundingClientRect()
  const width = Math.min(208, innerWidth - 16)
  const left = Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))
  const estimatedHeight = 204
  const top = rect.bottom + estimatedHeight + 8 <= innerHeight
    ? rect.bottom + 6
    : Math.max(8, rect.top - estimatedHeight - 6)
  moreActions.style.left = String(left) + 'px'
  moreActions.style.top = String(top) + 'px'
})
moreActions.addEventListener('toggle', (event) => {
  moreButton.setAttribute('aria-expanded', (event as ToggleEvent).newState === 'open' ? 'true' : 'false')
})

window.addEventListener('blur', () => {
  if (moreActions.matches(':popover-open')) moreActions.hidePopover()
})

for (const btn of document.querySelectorAll<HTMLButtonElement>('.preset')) {
  btn.addEventListener('click', () => {
    const task = btn.dataset.preset as TaskId | undefined
    if (!task) return
    if (moreActions.matches(':popover-open')) moreActions.hidePopover()
    // The bubble shows the button label; the full template goes to the model.
    void send(taskPrompt(task, promptCtx()), task, t(uiLang, `preset.${task}`)).catch(reportError)
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
  if (question.trim()) void send(question).then((accepted) => {
    if (accepted && input.value === question) input.value = ''
  }).catch(reportError)
})

el('check-btn').onclick = () => {
  el('view-capture').dataset.composerMode = 'check'
  el('operation-error').hidden = true
  el('check-form').hidden = false
  el('ask-form').hidden = true
  el('check-input').focus()
}
el('check-cancel').onclick = () => {
  delete el('view-capture').dataset.composerMode
  el('check-form').hidden = true
  el('ask-form').hidden = false
  el('check-btn').focus()
}
el('check-input').oninput = () => {
  el('operation-error').hidden = true
  updateStatus()
}
el('check-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const attempt = (el('check-input') as HTMLTextAreaElement).value
  if (!attempt.trim()) { reportError(new Error('check.needAttempt')); return }
  delete el('view-capture').dataset.composerMode
  el('check-form').hidden = true
  el('ask-form').hidden = false
  ;(el('ask-input') as HTMLInputElement).focus()
  void send(checkPrompt(attempt, promptCtx()), 'check', `${t(uiLang, 'preset.check')}\n${attempt}`, attempt).catch(reportError)
})

el('new-chat-btn').onclick = () => {
  if (closing) return
  void conversationAction<Conversation>({ action: 'create', title: t(uiLang, 'dialog.new') }).then(async (value) => {
    if (closing) return
    releaseImages()
    ;(el('ask-input') as HTMLInputElement).value = ''
    ;(el('check-input') as HTMLTextAreaElement).value = ''
    delete el('view-capture').dataset.composerMode
    el('check-form').hidden = true
    el('ask-form').hidden = false
    await openConversation(value.id)
  }).catch(reportError)
}

let deletingConversationId: string | undefined
let deletingHistoryIndex = 0

function formatHistoryDate(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  yesterday.setDate(yesterday.getDate() - 1)
  const label = day === today
    ? t(uiLang, 'dialog.today')
    : day === yesterday.getTime()
      ? t(uiLang, 'dialog.yesterday')
      : date.toLocaleDateString(uiLang, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  return `${label} · ${date.toLocaleTimeString(uiLang, { hour: '2-digit', minute: '2-digit' })}`
}

async function showHistory(): Promise<void> {
  await conversationAction({ action: 'prune' })
  if (conversation && !await getConversation(conversation.id)) { conversation = undefined; releaseImages() }
  show('history')
  const rows = await listConversations()
  const list = el('history-list')
  list.replaceChildren()
  for (const row of rows) {
    const wrap = document.createElement('div')
    wrap.className = 'history-row'
    const open = document.createElement('button')
    open.className = 'history-open'
    open.dataset.conversation = row.id
    const title = document.createElement('span')
    title.className = 'history-title'
    const displayTitle = conversationDisplayTitle(row, t(uiLang, 'dialog.new'))
    title.textContent = displayTitle
    const date = document.createElement('span')
    date.className = 'history-date'
    date.textContent = formatHistoryDate(conversationActivityAt(row))
    open.append(title, date)
    open.disabled = !!inflight || starting
    open.onclick = () => { releaseImages(); void openConversation(row.id).catch(reportError) }
    const remove = document.createElement('button')
    remove.className = 'history-delete'
    remove.type = 'button'
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>'
    remove.setAttribute('aria-label', t(uiLang, 'dialog.deleteChat', { title: displayTitle }))
    remove.disabled = profileState.generation?.conversationId === row.id
    remove.onclick = () => {
      deletingHistoryIndex = [...list.children].indexOf(wrap)
      deletingConversationId = row.id
      el('delete-error').textContent = ''
      el('delete-error').hidden = true
      el('delete-message').textContent = t(uiLang, 'dialog.deleteConfirm', { title: displayTitle })
      ;(el('delete-dialog') as HTMLDialogElement).showModal()
    }
    wrap.append(open, remove)
    list.appendChild(wrap)
  }
  if (!rows.length) list.textContent = t(uiLang, 'dialog.empty')
  el('storage-usage').textContent = t(uiLang, 'dialog.usage', { size: ((await conversationUsage()) / 1024 / 1024).toFixed(2) })
}

;(el('delete-cancel') as HTMLButtonElement).onclick = () => (el('delete-dialog') as HTMLDialogElement).close()
;(el('delete-dialog') as HTMLDialogElement).addEventListener('cancel', (event) => {
  if ((el('delete-confirm') as HTMLButtonElement).disabled) event.preventDefault()
})
;(el('delete-confirm') as HTMLButtonElement).onclick = async () => {
  const id = deletingConversationId
  if (!id) return
  const button = el('delete-confirm') as HTMLButtonElement
  button.disabled = true
  ;(el('delete-cancel') as HTMLButtonElement).disabled = true
  try {
    await conversationAction({ action: 'delete', conversationId: id })
    if (conversation?.id === id) { conversation = undefined; releaseImages() }
    deletingConversationId = undefined
    ;(el('delete-dialog') as HTMLDialogElement).close()
    await showHistory()
    const next = el('history-list').querySelectorAll<HTMLButtonElement>('.history-open')[Math.min(deletingHistoryIndex, el('history-list').querySelectorAll('.history-open').length - 1)]
    ;(next ?? el('history-back') as HTMLButtonElement).focus()
  } catch (err) {
    const key = err instanceof Error ? err.message : 'storage.write'
    const knownErrors = ['dialog.busy', 'dialog.missing', 'dialog.denied', 'dialog.disconnected']
    el('delete-error').textContent = t(uiLang, knownErrors.includes(key) ? key : 'dialog.deleteError')
    el('delete-error').hidden = false
  } finally {
    button.disabled = false
    ;(el('delete-cancel') as HTMLButtonElement).disabled = false
  }
}
;(el('delete-dialog') as HTMLDialogElement).addEventListener('close', () => { deletingConversationId = undefined })

el('history-btn').onclick = () => void showHistory().catch(reportError)
el('history-back').onclick = () => {
  if (conversation) { show('capture'); return }
  if (historyEntry) {
    if (window.parent !== window) window.parent.postMessage({ source: 'study-buddy-chat', action: 'dismiss-history' }, '*')
    else window.close()
    return
  }
  void getConversationState().then(async (state) => {
    const target = state.lastConversationId ? await getConversation(state.lastConversationId) : undefined
    const next = target ?? await conversationAction<Conversation>({ action: 'create', title: t(uiLang, 'dialog.new') })
    await openConversation(next.id)
  }).catch(reportError)
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'CONVERSATIONS_CHANGED') return
  const epoch = opening
  void (async () => {
    await refreshStatus()
    if (epoch !== opening || !conversation || inflight || starting || unsaved.size) return
    const selectedId = conversation.id
    const latest = await getConversation(selectedId)
    if (epoch !== opening || conversation?.id !== selectedId || inflight || starting || unsaved.size) return
    if (latest) { conversation = latest; await renderConversation() }
    else { conversation = undefined; await showHistory() }
  })().catch(reportError)
})

setInterval(updateStatus, 1000)

// The crop and attached images open in a native modal dialog. Native dialog
// behavior keeps keyboard focus inside and returns it to the exact opener.
{
  const figure = document.getElementById('crop-figure') as HTMLElement
  figure.addEventListener('click', () => openLightbox(figure, img.src))
  figure.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLightbox(figure, img.src) }
  })
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) closeLightbox()
  })
  lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault()
      ;(el('lightbox-close') as HTMLButtonElement).focus()
    }
  })
  lightbox.addEventListener('close', () => {
    if (lightboxOpener?.isConnected) lightboxOpener.focus()
    lightboxOpener = undefined
  })
  ;(el('lightbox-close') as HTMLButtonElement).onclick = closeLightbox
}

// The parent is the host web page, so the host validates the sender and this
// frame's extension origin instead of relying on a matching target origin.
window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { source?: string; state?: ChatState; action?: string; closeId?: string } | null
  if (e.source !== window.parent || window.parent === window || data?.source !== 'study-buddy-host') return
  if (data.state) apply(data.state)
  if (data.action === 'close' && typeof data.closeId === 'string') {
    const closeId = data.closeId
    const closingConversationId = pendingConversationId ?? conversation?.id
    if (closing && activeCloseId) {
      window.parent.postMessage({ source: 'study-buddy-chat', action: 'close-cancelled', closeId: activeCloseId }, '*')
    }
    activeCloseId = closeId
    closing = true
    inflight?.abort()
    void (async () => {
      await generationDone
      if (!closing || activeCloseId !== closeId) return
      if (unsaved.size && !confirm(t(uiLang, 'dialog.closeUnsaved'))) {
        closing = false
        activeCloseId = undefined
        window.parent.postMessage({ source: 'study-buddy-chat', action: 'close-cancelled', closeId }, '*')
        return
      }
      window.parent.postMessage({ source: 'study-buddy-chat', action: 'closed', closeId, conversationId: closingConversationId }, '*')
    })().catch((err) => {
      if (activeCloseId !== closeId) return
      closing = false
      activeCloseId = undefined
      window.parent.postMessage({ source: 'study-buddy-chat', action: 'close-cancelled', closeId }, '*')
      reportError(err)
    })
  }
  if (data.action === 'close-cancelled' && typeof data.closeId === 'string' && activeCloseId === data.closeId) {
    closing = false
    activeCloseId = undefined
    updateStatus()
  }
  if (data.action === 'close-failed' && typeof data.closeId === 'string' && activeCloseId === data.closeId) {
    closing = false
    activeCloseId = undefined
    updateStatus()
    reportError(new Error('storage.write'))
  }
})

// Initial state from URL params — set by the overlay's iframe src or by the
// service worker's detached fallback window.
function stateFromLocation(): ChatState | null {
  const p = new URLSearchParams(location.search)
  switch (p.get('kind')) {
    case 'capture': {
      const id = p.get('id')
      return id ? { kind: 'capture', imageId: id, conversationId: p.get('conversation') ?? undefined, rect: { x: 0, y: 0, width: 0, height: 0 } satisfies Rect } : null
    }
    case 'conversation':
      return p.get('conversation') ? { kind: 'conversation', conversationId: p.get('conversation')! } : null
    case 'history':
      return { kind: 'history' }
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
  if (closing) return
  const initial = stateFromLocation()
  if (initial) apply(initial)
  else {
    const state = await getConversationState()
    if (closing) return
    const saved = state.lastConversationId ? await getConversation(state.lastConversationId) : undefined
    if (closing) return
    const next = saved ?? await conversationAction<Conversation>({ action: 'create', title: t(uiLang, 'dialog.new') })
    if (closing) return
    await openConversation(next.id)
  }
}

void boot().catch((err) => {
  applyI18n()
  fillLanguageSelects()
  apply({ kind: 'error', message: err instanceof Error ? err.message : 'storage.read' })
  reportError(err)
})
