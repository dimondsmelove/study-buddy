// Study Buddy chat window (an extension page).
//
// It is embedded as an iframe by the overlay's host (src/content/overlay.ts)
// or opened as a detached popup window by the service worker's fallback. The
// initial state arrives via URL params (?kind=capture&id=…); later states are
// relayed in by the host via postMessage (no reload, the conversation survives).
//
// Views: capture (crop + task actions + thread), the rare permission /
// restricted / error states, and a settings detour. The gateway owns provider
// configuration; user settings only control languages.
// The crop goes through the Gateway and the answer streams into the thread,
// rendered as Markdown + LaTeX.

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import renderMathInElement from 'katex/contrib/auto-render'
import 'katex/dist/katex.min.css'

import { createGateway, GatewayError, gatewayErrorMessage } from '../shared/gateway'
import { GATEWAY_LIMITS, gatewayRequestBytes } from '../shared/gateway-protocol'
import type { ChatState, Rect } from '../shared/messages'
import { conversationUsage, getAttachment, getConversation, getConversationState, listConversations } from '../shared/conversation-store'
import { CONTEXT_LIMITS, contextProjection, conversationActivityAt, conversationDisplayTitle, cooldownRemaining, requestContext, type ContextProjection, type Conversation, type ConversationState, type ReplyStatus, type Turn } from '../shared/conversations'
import { conversationAction, GenerationConnection } from './conversation-client'
import type { AnswerLanguage, Settings, UiLanguage } from '../shared/settings'
import { DEFAULT_SETTINGS, getSettings, setSettings } from '../shared/settings'
import type { UiLang } from '../shared/i18n'
import { ANSWER_LANGUAGE_LABELS, browserLang, resolveUiLang, t } from '../shared/i18n'
import { createResponseTitleParser } from '../shared/title'
import { PROMPTS_VERSION, type TaskId, type TurnKind } from '../shared/prompts'

type Kind = 'capture' | 'permission' | 'restricted' | 'error'
const KINDS: Kind[] = ['capture', 'permission', 'restricted', 'error']

const el = (id: string): HTMLElement => document.getElementById(id)!
const lightbox = document.getElementById('lightbox') as HTMLDialogElement
const lightboxImg = lightbox.querySelector('img') as HTMLImageElement
const thread = document.getElementById('thread') as HTMLElement

let lightboxOpener: HTMLElement | undefined
let contextPreview: ContextProjection | undefined
let previewKind: TurnKind | undefined
let previewUpdate = 0
// TEMP manual-test override: restore to 40_000 after checking.
const CONTEXT_WARNING_TOKENS = 2_500

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
      void openConversation(state.conversationId, false).catch(reportError)
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
// The saved reply stays untouched. Only the live preview closes unfinished
// Markdown and waits for complete math; DOMPurify also guards every stream frame.

function streamingMarkdown(source: string): string {
  const emphasis: string[] = []
  const tokens = /`+|~{3,}|\$\$?|\*\*|__|~~|\*|_|\\[\s\S]?/g
  const closingEmphasis = () => [...emphasis].reverse().join('')
  for (let match; (match = tokens.exec(source));) {
    const token = match[0]
    const start = match.index
    const after = start + token.length
    if (token.startsWith('\\')) {
      if (token.length === 1) return source.slice(0, start) + closingEmphasis()
      continue
    }
    if (token.startsWith('`') || token.startsWith('~~~')) {
      const end = source.indexOf(token, after)
      if (end < 0) return source + (token.length >= 3 ? '\n' : '') + token + closingEmphasis()
      tokens.lastIndex = end + token.length
      continue
    }
    if (token.startsWith('$')) {
      let end = after
      while ((end = source.indexOf(token, end)) >= 0) {
        let backslashes = 0
        for (let i = end - 1; i >= 0 && source[i] === '\\'; i--) backslashes++
        if (backslashes % 2 === 0) break
        end += token.length
      }
      if (end < 0) return source.slice(0, start) + 'SBPENDINGMATH' + closingEmphasis()
      tokens.lastIndex = end + token.length
      continue
    }
    const before = source[start - 1] ?? ''
    const next = source[after] ?? ''
    if (token.includes('_') && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(next)) continue
    if (emphasis.at(-1) === token && before && !/\s/.test(before)) emphasis.pop()
    else if (next && !/\s/.test(next)) emphasis.push(token)
    else if (!next) return source.slice(0, start) + closingEmphasis()
  }
  return source + closingEmphasis()
}

function renderAnswer(node: HTMLElement, text: string, streaming = false): void {
  // 1) Models sometimes emit TeX delimiters \( \) / \[ \] instead of $ / $$.
  //    marked strips the backslash as a Markdown escape BEFORE KaTeX runs,
  //    which destroys those delimiters — normalize to $ / $$ first.
  let src = text
    .replace(/\\\[/g, () => '\n$$\n')
    .replace(/\\\]/g, () => '\n$$\n')
    .replace(/\\\(/g, () => '$')
    .replace(/\\\)/g, () => '$')

  if (streaming) src = streamingMarkdown(src)

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
    tn.data = tn.data.replace(/SBMATH(\d+)SB/g, (_, i) => mathSpans[Number(i)])
    if (streaming && tn.data.includes('SBPENDINGMATH')) {
      const pending = document.createElement('span')
      pending.className = 'math-pending'
      pending.textContent = '…'
      pending.setAttribute('aria-hidden', 'true')
      const [before, after] = tn.data.split('SBPENDINGMATH')
      tn.replaceWith(document.createTextNode(before), pending, document.createTextNode(after))
    }
  }
  renderMathInElement(node, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
    trust: false,
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
  if (['context.text', 'context.taskTooLarge', 'context.imageMissing', 'context.imageLarge', 'context.requestLarge'].includes(key)) { setComposerError(key); return }
  if (err instanceof GatewayError) {
    el('dialog-status').textContent = gatewayErrorMessage(err, uiLang)
    el('operation-error').textContent = el('dialog-status').textContent
    el('operation-error').hidden = false
    return
  }
  if (key.startsWith('dialog.cooldown:')) {
    el('operation-error').textContent = ''
    el('operation-error').hidden = true
    void refreshStatus().catch(() => {})
    return
  }
  el('dialog-status').textContent = t(uiLang, key.startsWith('storage.') ? 'dialog.storageError' : key)
  el('operation-error').textContent = el('dialog-status').textContent
  el('operation-error').hidden = false
}

async function projectContext(value: Conversation, generation?: Parameters<typeof contextProjection>[1]['generation']): Promise<ContextProjection> {
  const imageByteSizes = new Map<string, { size: number; type: string }>()
  const attachmentIds = new Set(value.turns.flatMap((turn) => turn.attachmentId ? [turn.attachmentId] : []))
  const attachments = await Promise.all([...attachmentIds].map((id) => getAttachment(id)))
  for (const [index, id] of [...attachmentIds].entries()) {
    const attachment = attachments[index]
    if (attachment) imageByteSizes.set(id, { size: attachment.data.size, type: attachment.data.type || 'image/png' })
  }
  return contextProjection(value, { generation, imageByteSizes })
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

async function openConversation(id: string, select = true): Promise<void> {
  if (closing) return
  previewUpdate++
  contextPreview = undefined
  updateContextWarning()
  const epoch = ++opening
  pendingConversationId = id
  let value: Conversation
  try {
    // A mirrored view must not select its snapshot back over a newer shared chat.
    const selected = select
      ? await conversationAction<Conversation>({ action: 'select', conversationId: id })
      : await getConversation(id)
    if (!selected) throw new Error('dialog.missing')
    value = selected
  } catch (err) {
    if (epoch === opening && pendingConversationId === id) pendingConversationId = undefined
    throw err
  }
  if (epoch !== opening) return
  if (conversation && conversation.id !== id) {
    releaseImages()
    ;(el('ask-input') as HTMLInputElement).value = ''
    previewKind = undefined
    setComposerError()
  }
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

async function appendTurnImage(message: Msg, turn: Turn, epoch?: number): Promise<void> {
  if (!turn.attachmentId) return
  const thumbnail = document.createElement('img')
  thumbnail.className = 'turn-image'
  thumbnail.alt = t(uiLang, 'dialog.attachment')
  try { thumbnail.src = await imageUrl(turn.attachmentId) }
  catch {
    const missing = document.createElement('span')
    missing.className = 'turn-image-missing'
    missing.textContent = t(uiLang, 'context.imageMissing')
    message.wrap.appendChild(missing)
    return
  }
  if (epoch !== undefined && epoch !== rendering) return
  thumbnail.tabIndex = 0
  thumbnail.setAttribute('role', 'button')
  thumbnail.setAttribute('aria-label', t(uiLang, 'dialog.imagePreview'))
  thumbnail.onclick = () => openLightbox(thumbnail, thumbnail.src)
  thumbnail.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLightbox(thumbnail, thumbnail.src) }
  }
  message.wrap.appendChild(thumbnail)
}

async function appendNewCaptureTurns(selected: Conversation): Promise<void> {
  for (const turn of selected.turns) {
    if (turn.kind !== 'capture' || [...thread.querySelectorAll<HTMLElement>('[data-turn]')].some((node) => node.dataset.turn === turn.id)) continue
    const message = addMessage('user', '')
    message.wrap.dataset.turn = turn.id
    await appendTurnImage(message, turn)
  }
}

function updateConversationTitle(value: string): void {
  const title = el('conversation-title')
  title.textContent = value
  title.title = value
}

async function renderConversation(): Promise<void> {
  if (!conversation) return
  const epoch = ++rendering
  const selected = conversation
  updateConversationTitle(conversationDisplayTitle(selected, t(uiLang, 'dialog.new')))
  if (lightbox.open) lightbox.close()
  if (inflight || starting) {
    await appendNewCaptureTurns(selected)
    await updateContextPreview(null)
    await refreshStatus()
    return
  }
  const displayedImages = new Set<string>()
  thread.replaceChildren()
  for (const turn of selected.turns) {
    const msg = addMessage(turn.role, turn.role === 'user' ? turn.display ?? turn.text : turn.text)
    msg.wrap.dataset.turn = turn.id
    if (turn.role === 'user' && turn.attachmentId && !displayedImages.has(turn.attachmentId)) {
      await appendTurnImage(msg, turn, epoch)
      displayedImages.add(turn.attachmentId)
    }
    if (epoch !== rendering) return
    if (turn.role === 'assistant') {
      if (turn.note) {
        const note = addMessage('note', turn.note)
        thread.insertBefore(note.wrap, msg.wrap)
      }
      renderAnswer(msg.body, turn.text, turn.status === 'streaming')
      const status = document.createElement('div')
      status.className = 'reply-status'
      status.textContent = t(uiLang, `reply.${turn.status ?? 'interrupted'}`) + (turn.error ? ` — ${turn.error}` : '')
      msg.wrap.appendChild(status)
      addActions(msg, turn.id === [...selected.turns].reverse().find((item) => item.kind !== 'capture')?.id)
    }
  }
  if (selected.activeAttachmentId && !displayedImages.has(selected.activeAttachmentId)) {
    const legacyImage: Turn = { id: `legacy-${selected.activeAttachmentId}`, role: 'user', text: '', kind: 'capture', attachmentId: selected.activeAttachmentId, createdAt: selected.createdAt, locale: uiLang, promptVersion: 'legacy' }
    const msg = addMessage('user', '')
    msg.wrap.dataset.turn = legacyImage.id
    await appendTurnImage(msg, legacyImage, epoch)
  }
  if (epoch !== rendering) return
  ensureHint()
  await updateContextPreview()
  await refreshStatus()
}

async function refreshStatus(): Promise<void> {
  profileState = await getConversationState()
  updateStatus()
}

function updateStatus(): void {
  const wait = cooldownRemaining(profileState.lastStartedAt)
  const busy = !!inflight || starting || !!profileState.generation
  setBusy(busy, wait)
  const text = profileState.generation ? t(uiLang, 'reply.streaming') : t(uiLang, 'dialog.saved')
  if (!unsaved.size) el('dialog-status').textContent = text
  if (window.parent !== window) window.parent.postMessage({ source: 'study-buddy-chat', action: 'status', text, lang: uiLang }, '*')
}

function applyContextProjection(projection: ContextProjection): void {
  for (const note of thread.querySelectorAll('.context-boundary')) note.remove()
  for (const entry of projection.entries) {
    const wrap = [...thread.children].find((child) => (child as HTMLElement).dataset.turn === entry.turn.id) as HTMLElement | undefined
    if (!wrap) continue
    const presentationExcluded = !entry.included && !(entry.turn.role === 'assistant' && entry.turn.status === 'streaming')
    wrap.classList.toggle('context-excluded', presentationExcluded)
    if (!entry.included) {
      wrap.dataset.exclusion = entry.reason ?? 'olderTask'
    } else {
      delete wrap.dataset.exclusion
      wrap.querySelector('.context-exclusion-note')?.remove()
      wrap.querySelector('.context-reuse')?.remove()
      continue
    }
    if (entry.turn.role !== 'user') continue
    if (entry.turn.kind === 'capture' && projection.entries.some((other) => other.turn.role === 'user' && other.turn.kind !== 'capture' && other.turn.attachmentId === entry.turn.attachmentId)) continue
    if (wrap.querySelector('.context-reuse')) continue
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'context-reuse'
    action.setAttribute('aria-label', t(uiLang, 'context.reuseTitle'))
    action.title = t(uiLang, 'context.reuseTitle')
    action.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5h7.5a3 3 0 1 1 0 6H8"/><path d="M5 3.5 3 5.5l2 2"/></svg>`
    action.onclick = () => {
      const turn = entry.turn
      if (turn.kind === 'capture') {
        void send('', 'check', t(uiLang, 'preset.check'), undefined, undefined, turn.attachmentId).catch(reportError)
      } else {
        void send(turn.text, turn.kind, turn.display ?? turn.text, turn.input, undefined, turn.attachmentId, true, true).catch(reportError)
      }
    }
    wrap.appendChild(action)
  }
  const firstIncludedUser = projection.entries.findIndex((entry) => entry.included && entry.turn.kind !== 'capture' && entry.turn.role === 'user')
  const boundary = projection.entries.slice(0, firstIncludedUser < 0 ? undefined : firstIncludedUser)
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !entry.included && entry.reason === 'olderTask')
    .at(-1)
  if (boundary) {
    const entry = projection.entries[boundary.index]
    const wrap = [...thread.children].find((child) => (child as HTMLElement).dataset.turn === entry.turn.id) as HTMLElement | undefined
    if (wrap) {
      const note = document.createElement('div')
      note.className = 'msg note context-boundary'
      const body = document.createElement('div')
      body.className = 'msg-body'
      const currentTurn = [...projection.entries].reverse().find((candidate) => candidate.included && candidate.turn.role === 'user' && candidate.turn.kind !== 'capture')?.turn
      const currentImageId = currentTurn?.attachmentId ?? conversation?.activeAttachmentId
      const currentImageIncluded = !!currentImageId && projection.images.has(currentImageId)
      body.textContent = t(uiLang, currentImageIncluded ? 'context.boundaryWithImage' : 'context.boundary')
      note.appendChild(body)
      wrap.after(note)
    }
  }
}

function updateContextWarning(projection?: ContextProjection): void {
  const warning = el('context-warning')
  const olderMessagesExcluded = !!projection?.entries.some((entry) => !entry.included && entry.reason === 'olderTask')
  const longContext = (projection?.estimatedInputTokens ?? 0) >= CONTEXT_WARNING_TOKENS
  const hidden = !longContext && !olderMessagesExcluded
  const text = hidden
    ? ''
    : t(uiLang, 'context.longWarning') + (olderMessagesExcluded ? ` ${t(uiLang, 'context.longWarningExcluded')}` : '')
  const changed = warning.textContent !== text
  const wasAtBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 8
  warning.hidden = hidden
  if (changed) {
    warning.textContent = text
    if (wasAtBottom) scrollThread()
  }
}

function setComposerError(key?: string): void {
  const node = el('composer-error')
  node.textContent = key ? t(uiLang, key) : ''
  node.hidden = !key
}

function previewTurn(): Turn | undefined {
  let kind = previewKind
  let input: string | undefined
  let text: string
  let display: string
  if (kind === 'check') {
    text = ''
    display = t(uiLang, 'preset.check')
  } else if (kind) {
    text = ''
    display = t(uiLang, 'preset.' + kind)
  } else {
    const ask = (el('ask-input') as HTMLInputElement).value
    if (!ask.trim()) return undefined
    kind = 'ask'
    input = ask
    text = ask
    display = ask
  }
  return { id: 'context-preview-draft', role: 'user', text, display, input, kind: kind as TurnKind, createdAt: Date.now(), locale: uiLang, promptVersion: PROMPTS_VERSION, attachmentId: conversation?.activeAttachmentId }
}

async function updateContextPreview(override?: Turn | null): Promise<void> {
  const sequence = ++previewUpdate
  const selected = conversation
  if (!selected) { updateContextWarning(); return }
  const draft = override === undefined ? previewTurn() : override ?? undefined
  const turns = draft && !selected.turns.some((turn) => turn.id === draft.id) ? [...selected.turns, draft] : selected.turns
  let projection: ContextProjection
  try {
    const currentUser = draft?.role === 'user' ? draft : [...turns].reverse().find((turn) => turn.role === 'user' && turn.kind !== 'capture')
    const generation = draft?.role === 'user' && !selected.turns.some((turn) => turn.id === draft.id) && currentUser ? {
      task: currentUser.kind as TurnKind,
      answerLanguage: settingsCache.answerLanguage,
      uiLanguage: currentUser.locale,
      browserLanguage: browserLang(),
      titleNeeded: !selected.turns.some((turn) => turn.role === 'assistant') && !selected.titleGeneratedAt,
      ...(currentUser.kind === 'simpler' && currentUser.input ? { selectedAnswerText: currentUser.input } : {}),
      ...(currentUser.kind === 'ask' ? { taskInput: currentUser.input ?? currentUser.text } :
        currentUser.kind === 'check' && currentUser.input !== undefined ? { taskInput: currentUser.input } : {}),
    } : undefined
    projection = await projectContext({ ...selected, turns }, generation)
    if (sequence !== previewUpdate || selected !== conversation) return
  } catch (err) {
    if (sequence !== previewUpdate || selected !== conversation) return
    const key = err instanceof Error ? err.message : 'context.text'
    contextPreview = undefined
    updateContextWarning()
    setComposerError(key.startsWith('context.') ? key : 'context.text')
    return
  }
  contextPreview = projection
  updateContextWarning(projection)
  applyContextProjection(projection)
  setComposerError()
  for (const id of projection.images) {
    const attachment = await getAttachment(id)
    if (sequence !== previewUpdate) return
    if (!attachment) { updateContextWarning(); setComposerError('context.imageMissing'); return }
    if (attachment.data.size > CONTEXT_LIMITS.imageBytes) { updateContextWarning(); setComposerError('context.imageLarge'); return }
  }
}

let contextPreviewTimer: ReturnType<typeof setTimeout> | undefined
window.addEventListener('resize', () => {
  if (contextPreview) applyContextProjection(contextPreview)
})

function queueContextPreview(): void {
  if (contextPreviewTimer) clearTimeout(contextPreviewTimer)
  contextPreviewTimer = setTimeout(() => { contextPreviewTimer = undefined; void updateContextPreview() }, 120)
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
  if (text) wrap.appendChild(body)
  thread.appendChild(wrap)
  scrollThread()
  return { wrap, body, raw: text }
}

/** 16px stroke icons for the per-answer actions — text labels ate half the
 *  panel width; icons + tooltips keep the thread readable. */
const ACTION_ICONS = {
  copy: '<rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 3.5h-6a1.5 1.5 0 0 0-1.5 1.5v6"/>',
  copied: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
  more: '<circle cx="8" cy="3" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="8" cy="13" r="1.1"/>',
  simpler: '<path d="M1.8 12.5 5 3.5l3.2 9M3 9.2h4"/><path d="M14.2 8.2c-.35-.7-.95-1-1.75-1-1.35 0-2.25 1-2.25 2.65s.9 2.65 2.25 2.65c.8 0 1.4-.3 1.75-1M14.2 7.4v4.8"/>',
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
  actions.setAttribute('role', 'group')
  const actionItems = document.createElement('div')
  actionItems.className = 'msg-action-items'
  const actionsLabel = t(uiLang, 'msg.actions')
  const toggle = iconButton('more', actionsLabel)
  toggle.className = 'msg-actions-toggle'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.setAttribute('aria-controls', 'actions-' + (msg.wrap.dataset.turn ?? crypto.randomUUID()))
  actionItems.id = toggle.getAttribute('aria-controls')!
  toggle.onclick = () => {
    const open = actions.classList.toggle('is-open')
    toggle.setAttribute('aria-expanded', String(open))
  }
  actions.appendChild(toggle)

  const copy = iconButton('copy', t(uiLang, 'msg.copy'))
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined
  copy.onclick = async () => {
    const feedback = document.createElement('span')
    feedback.className = 'msg-copy-feedback'
    feedback.setAttribute('role', 'status')
    feedback.setAttribute('aria-live', 'polite')
    try {
      try {
        await navigator.clipboard.writeText(msg.raw)
      } catch {
        const field = document.createElement('textarea')
        field.value = msg.raw
        field.setAttribute('aria-hidden', 'true')
        field.tabIndex = -1
        field.style.position = 'fixed'
        field.style.opacity = '0'
        document.body.append(field)
        let copied = false
        try {
          field.select()
          copied = document.execCommand('copy')
        } finally {
          field.remove()
          copy.focus({ preventScroll: true })
        }
        if (!copied) throw new Error('clipboard.copyFailed')
      }
      feedback.textContent = t(uiLang, 'msg.copied')
      copy.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS.copied}</svg>`
      copy.title = t(uiLang, 'msg.copied')
      copy.setAttribute('aria-label', t(uiLang, 'msg.copied'))
    } catch {
      feedback.textContent = t(uiLang, 'msg.copyFailed')
    }
    actions.querySelector('.msg-copy-feedback')?.remove()
    actions.appendChild(feedback)
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
    copyFeedbackTimer = setTimeout(() => {
      feedback.remove()
      copy.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS.copy}</svg>`
      copy.title = t(uiLang, 'msg.copy')
      copy.setAttribute('aria-label', t(uiLang, 'msg.copy'))
      copyFeedbackTimer = undefined
    }, 1400)
  }
  actionItems.appendChild(copy)

  const simpler = iconButton('simpler', t(uiLang, 'msg.simpler'))
  simpler.dataset.generation = '1'
  simpler.onclick = () => {
    const selected = conversation?.turns.find((turn) => turn.role === 'assistant' && turn.id === msg.wrap.dataset.turn)
    const selectedSource = selected?.replyTo ? conversation?.turns.find((turn) => turn.id === selected.replyTo) : undefined
    if (selected?.text) void send('', 'simpler', t(uiLang, 'msg.simpler'), undefined, undefined, selectedSource?.attachmentId, false, true, selected.text).catch(reportError)
  }
  actionItems.appendChild(simpler)

  if (canRegenerate) {
    const retry = iconButton('retry', t(uiLang, 'msg.retry'))
    retry.dataset.retry = '1'
    retry.dataset.generation = '1'
    retry.onclick = () => void regenerate().catch(reportError)
    actionItems.appendChild(retry)
  }

  actions.appendChild(actionItems)
  msg.body.appendChild(actions)
  actions.addEventListener('click', (event) => {
    if (toggle.contains(event.target as Node)) return
    actions.classList.remove('is-open')
    toggle.setAttribute('aria-expanded', 'false')
  })
  actions.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !actions.classList.contains('is-open')) return
    event.preventDefault()
    actions.classList.remove('is-open')
    toggle.setAttribute('aria-expanded', 'false')
    toggle.focus()
  })
}

function clearRetryButtons(): void {
  for (const b of thread.querySelectorAll('[data-retry]')) b.remove()
}

function setBusy(busy: boolean, cooldownMs = 0): void {
  const cooldownSeconds = Math.ceil(cooldownMs / 1000)
  const coolingDown = cooldownSeconds > 0
  for (const b of document.querySelectorAll<HTMLButtonElement>('.preset')) b.disabled = busy || coolingDown
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-generation]')) b.disabled = busy || coolingDown
  ;(el('new-chat-btn') as HTMLButtonElement).disabled = busy
  ;(el('ask-input') as HTMLInputElement).disabled = busy
  const askButton = el('ask-btn') as HTMLButtonElement
  const canStop = !!inflight || !!conversation && profileState.generation?.conversationId === conversation.id
  askButton.disabled = (busy || coolingDown) && !canStop
  const label = t(uiLang, canStop ? 'ask.stop' : coolingDown ? 'dialog.cooldown' : 'ask.button', coolingDown && !canStop ? { seconds: cooldownSeconds } : undefined)
  askButton.title = label
  askButton.setAttribute('aria-label', label)
  askButton.innerHTML = canStop
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : coolingDown
      ? `<span class="cooldown-countdown">${t(uiLang, 'dialog.cooldownShort', { seconds: cooldownSeconds })}</span>`
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 18-8-8 18-2-8-8-2Z"/><path d="m11 13 4-4"/></svg>'
}

async function requireSettings(): Promise<Settings | null> {
  try { return await loadSettings() }
  catch (error) { reportError(new Error(error instanceof Error ? error.message : 'storage.read')); return null }
}

/** Persist the accepted turn before any provider operation; only this port writes. */
async function streamReply(settings: Settings, user: Turn | null, source: Turn, onAccepted?: () => void): Promise<boolean> {
  if (!conversation) return false
  const selectedId = conversation.id
  if (source.kind === 'capture') throw new Error('dialog.invalid')
  const assistant: Turn = { id: crypto.randomUUID(), role: 'assistant', text: '', kind: source.kind, status: 'streaming', replyTo: source.id, createdAt: Date.now(), locale: uiLang, promptVersion: PROMPTS_VERSION }
  const controller = new AbortController()
  let lost = false
  const connection = new GenerationConnection(() => { lost = true; controller.abort() }, () => controller.abort())
  let reply: Msg | undefined
  let acc = ''
  let generatedTitle: string | undefined
  let needsTitle = false
  let titleParserFinished = false
  const titleParser = createResponseTitleParser()
  let status: ReplyStatus = 'interrupted'
  let error: string | undefined
  let fallbackNote: string | undefined
  let usage: Turn['usage']
  let write: Promise<unknown> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let renderTimer: ReturnType<typeof setTimeout> | undefined
  let storageFailed = false
  const finishTitle = (): void => {
    if (!needsTitle || titleParserFinished) return
    const parsed = titleParser.finish()
    acc += parsed.text
    generatedTitle = titleParser.title
    titleParserFinished = true
  }
  const persist = (final: ReplyStatus) => {
    write = write.then(() => connection.request({ action: 'update', text: acc, status: final, error, note: fallbackNote, title: generatedTitle, usage }))
    return write
  }
  starting = true
  inflight = controller
  el('operation-error').hidden = true
  setBusy(true)
  try {
    const prior = conversation
    needsTitle = !prior.turns.some((turn) => turn.role === 'assistant') && !prior.titleGeneratedAt
    const sourceIndex = prior.turns.findIndex((turn) => turn.id === source.id)
    const selectedTurns = user
      ? [...prior.turns, user]
      : prior.turns.slice(0, sourceIndex + 1)
    const contextConversation = { ...prior, turns: selectedTurns }
    const preflightGeneration = {
      requestId: '00000000-0000-4000-8000-000000000000',
      task: source.kind,
      answerLanguage: settings.answerLanguage,
      uiLanguage: source.locale,
      browserLanguage: browserLang(),
      titleNeeded: needsTitle,
      ...(source.kind === 'simpler' && source.input ? { selectedAnswerText: source.input } : {}),
      ...(source.kind === 'ask' ? { taskInput: source.input ?? source.text } :
        source.kind === 'check' && source.input !== undefined ? { taskInput: source.input } : {}),
    }
    const projection = await projectContext(contextConversation, preflightGeneration)
    const context = await requestContext(async (id) => (await getAttachment(id))?.data, projection)
    const preflightPayload = { ...preflightGeneration, messages: context.messages }
    if (gatewayRequestBytes(preflightPayload) > GATEWAY_LIMITS.requestBytes) throw new Error('context.requestLarge')

    const accepted = await connection.request<{ generation: { requestId: string }; conversation: Conversation }>({ action: 'start', conversationId: selectedId, user, assistant })
    conversation = accepted.conversation
    onAccepted?.()
    updateConversationTitle(conversation.title)
    starting = false
    if (user) addMessage('user', user.display ?? user.text).wrap.dataset.turn = user.id
    reply = addMessage('assistant', '…')
    reply.wrap.dataset.turn = assistant.id
    await refreshStatus()
    contextPreview = projection
    updateContextWarning(projection)
    applyContextProjection(projection)
    const generation = { ...preflightGeneration, requestId: accepted.generation.requestId }
    const result = await createGateway().ask({
      ...generation,
      messages: context.messages,
      signal: controller.signal,
      onContext: (value) => {
        if (value.estimatedInputTokens !== projection.estimatedInputTokens ||
            value.inputBudget !== projection.inputBudget || value.estimateHeadroom !== CONTEXT_LIMITS.estimateHeadroom) {
          controller.abort()
          throw new GatewayError('gateway.context_mismatch', 'uncertain')
        }
      },
      onDelta: (delta) => {
        acc += needsTitle ? titleParser.push(delta) : delta
        generatedTitle = needsTitle ? titleParser.title : undefined
        reply!.raw = acc
        if (!renderTimer) renderTimer = setTimeout(() => {
          renderTimer = undefined
          renderAnswer(reply!.body, acc, true)
          scrollThread()
        }, 100)
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
    if (needsTitle) finishTitle()
    else acc = result.text
    status = result.status
    usage = { model: result.model, ...result.usage }
  } catch (err) {
    if (!reply) { reportError(err); return false }
    status = lost || storageFailed ? 'interrupted' : controller.signal.aborted || err instanceof GatewayError && err.kind === 'cancelled' ? 'cancelled' : err instanceof GatewayError && (err.kind === 'uncertain' || err.partial) ? 'interrupted' : 'provider_error'
    error = err instanceof GatewayError ? gatewayErrorMessage(err, uiLang) : undefined
  } finally {
    if (needsTitle) finishTitle()
    if (timer) clearTimeout(timer)
    if (renderTimer) clearTimeout(renderTimer)
    if (reply) {
      if (lost) storageFailed = true
      try { if (!storageFailed) await persist(status) } catch { storageFailed = true }
      const savedTurn = { ...assistant, text: acc, status, error, note: fallbackNote, usage }
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
    if (!storageFailed) await renderConversation().catch(reportError)
    scrollThread()
  }
  return true
}

async function send(prompt: string, kind: TurnKind = 'ask', display?: string, input?: string, onAccepted?: () => void, attachmentId?: string, storedText = false, preserveAttachment = false, selectedAnswerText?: string): Promise<boolean> {
  if ((!prompt.trim() && kind === 'ask') || inflight || starting || !conversation || cooldownRemaining(profileState.lastStartedAt) > 0) return false
  starting = true
  setBusy(true)
  try {
    const settings = await requireSettings()
    if (!settings || closing) return false
    const text = kind === 'ask' ? prompt : storedText ? prompt : ''
    const label = display ?? (kind === 'ask' ? prompt : kind === 'check' ? t(uiLang, 'preset.check') : kind === 'simpler' ? t(uiLang, 'msg.simpler') : t(uiLang, 'preset.' + kind))
    const user: Turn = { id: crypto.randomUUID(), role: 'user', text, display: label, input: input ?? selectedAnswerText ?? (kind === 'ask' ? prompt : undefined), kind, createdAt: Date.now(), locale: uiLang, promptVersion: PROMPTS_VERSION, attachmentId: preserveAttachment ? attachmentId : attachmentId ?? conversation.activeAttachmentId }
    previewKind = undefined
    await updateContextPreview(user)
    if (!el('composer-error').hidden) return false
    generationDone = streamReply(settings, user, user, onAccepted)
    return await generationDone
  } finally { starting = false; updateStatus() }
}

async function regenerate(): Promise<void> {
  if (inflight || starting || cooldownRemaining(profileState.lastStartedAt) > 0 || !conversation) return
  const last = [...conversation.turns].reverse().find((turn) => turn.role === 'user' && turn.kind !== 'capture')
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

const taskTooltip = el('task-tooltip')
let tooltipButton: HTMLButtonElement | undefined
function hideTaskTooltip(): void {
  if (taskTooltip.matches(':popover-open')) taskTooltip.hidePopover()
  tooltipButton?.removeAttribute('aria-describedby')
  tooltipButton = undefined
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-task-help]')) {
  const showTooltip = () => {
    hideTaskTooltip()
    tooltipButton = button
    taskTooltip.textContent = t(uiLang, button.dataset.taskHelp!)
    button.setAttribute('aria-describedby', 'task-tooltip')
    taskTooltip.showPopover()
    const anchor = button.getBoundingClientRect()
    const tip = taskTooltip.getBoundingClientRect()
    taskTooltip.style.left = `${Math.max(12, Math.min(anchor.left + (anchor.width - tip.width) / 2, innerWidth - tip.width - 12))}px`
    taskTooltip.style.top = `${Math.max(8, Math.min(anchor.bottom + 8, innerHeight - tip.height - 8))}px`
  }
  button.addEventListener('pointerenter', showTooltip)
  button.addEventListener('focus', showTooltip)
  button.addEventListener('pointerleave', () => { if (document.activeElement !== button) hideTaskTooltip() })
  button.addEventListener('blur', hideTaskTooltip)
  button.addEventListener('click', hideTaskTooltip)
  button.addEventListener('keydown', event => { if (event.key === 'Escape') hideTaskTooltip() })
}
taskTooltip.addEventListener('toggle', () => {
  if (!taskTooltip.matches(':popover-open')) {
    tooltipButton?.removeAttribute('aria-describedby')
    tooltipButton = undefined
  }
})
window.addEventListener('blur', hideTaskTooltip)
window.addEventListener('resize', hideTaskTooltip)

for (const btn of document.querySelectorAll<HTMLButtonElement>('.preset')) {
  const task = btn.dataset.preset as TaskId | undefined
  btn.addEventListener('focus', () => { if (task) { previewKind = task; queueContextPreview() } })
  btn.addEventListener('pointerenter', () => { if (task) { previewKind = task; queueContextPreview() } })
  btn.addEventListener('blur', () => { if (previewKind === task) { previewKind = undefined; queueContextPreview() } })
  btn.addEventListener('pointerleave', () => { if (previewKind === task) { previewKind = undefined; queueContextPreview() } })
  btn.addEventListener('click', () => {
    const task = btn.dataset.preset as TaskId | undefined
    if (!task) return
    // The bubble shows the button label; the full template goes to the model.
    void send('', task, t(uiLang, `preset.${task}`)).catch(reportError)
  })
}

;(el('ask-input') as HTMLInputElement).addEventListener('input', () => { setComposerError(); queueContextPreview() })
el('ask-form').addEventListener('submit', (event) => {
  event.preventDefault()
  if (inflight) {
    inflight.abort()
    return
  }
  if (conversation && profileState.generation?.conversationId === conversation.id) {
    void conversationAction({ action: 'stop', conversationId: conversation.id }).catch(reportError)
    return
  }
  const input = el('ask-input') as HTMLInputElement
  const question = input.value
  if (question.trim()) void send(question, 'ask', question, undefined, () => {
    if (input.value === question) { input.value = ''; queueContextPreview() }
  }).catch(reportError)
})

el('check-btn').onclick = () => {
  el('operation-error').hidden = true
  setComposerError()
  void send('', 'check', t(uiLang, 'preset.check')).catch(reportError)
}

el('new-chat-btn').onclick = () => {
  if (closing) return
  void conversationAction<Conversation>({ action: 'create', title: t(uiLang, 'dialog.new') }).then(async (value) => {
    if (closing) return
    releaseImages()
    ;(el('ask-input') as HTMLInputElement).value = ''
    previewKind = undefined
    setComposerError()
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
    open.disabled = !!inflight || starting || !!profileState.generation
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
    if (epoch !== opening || !conversation || unsaved.size) return
    const selectedId = conversation.id
    const latest = await getConversation(selectedId)
    if (epoch !== opening || conversation?.id !== selectedId || unsaved.size) return
    if (latest) { conversation = latest; await renderConversation() }
    else { conversation = undefined; await showHistory() }
  })().catch(reportError)
})

setInterval(updateStatus, 1000)

// The crop and attached images open in a native modal dialog. Native dialog
// behavior keeps keyboard focus inside and returns it to the exact opener.
{
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
  const data = e.data as { source?: string; state?: ChatState; action?: string; closeId?: string; conversationId?: string } | null
  if (e.source !== window.parent || window.parent === window || data?.source !== 'study-buddy-host') return
  if (data.state) apply(data.state)
  if (data.action === 'dismiss-tooltip') hideTaskTooltip()
  if (data.action === 'conversation-changed' && typeof data.conversationId === 'string') {
    void openConversation(data.conversationId, false).catch(reportError)
  }
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
