// Typed message protocol shared across all extension contexts.
//
// Flow:
//   content overlay ──CAPTURE_REQUEST──► service worker
//   service worker  ──captureVisibleTab → crop on an OffscreenCanvas
//                  ──crop into chrome.storage.session──►
//   service worker  ──SHOW_CHAT──► overlay (embeds the chat window near the selection)
//   chat page       ──reads the capture from storage.session (an extension page
//                     can read the session area directly)

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** What the chat window should show. 'permission' / 'restricted' / 'error' are
 *  rare paths (no host access, Web Store / chrome:// pages, failures). */
export type ChatState =
  | { kind: 'capture'; imageId: string; rect: Rect; conversationId?: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'permission'; origin: string }
  | { kind: 'restricted'; reason: string }
  | { kind: 'error'; message: string }

/** Any extension page → SW: begin selecting a region on the active tab. */
export interface StartSelection {
  type: 'START_SELECTION'
}
export interface RestoreChat { type: 'RESTORE_CHAT' }

/** SW → overlay: show the drag-selection overlay. */
export interface ShowOverlay {
  type: 'SHOW_OVERLAY'
}

/** SW → overlay: hide / cancel the selection overlay. */
export interface HideOverlay {
  type: 'HIDE_OVERLAY'
}

/** overlay → SW: user finished selecting a region (CSS px). */
export interface CaptureRequest {
  type: 'CAPTURE_REQUEST'
  rect: Rect
  devicePixelRatio: number
  /** Page origin, so the SW can guard against mid-selection navigation. */
  origin: string
}

/** overlay → SW: user cancelled the selection (Esc / click). */
export interface SelectionCancelled {
  type: 'SELECTION_CANCELLED'
}

/** SW → overlay: embed the chat window with this state (create or reuse). */
export interface ShowChat {
  type: 'SHOW_CHAT'
  state: ChatState
}

/** SW → overlay: remove the chat window. */
export interface HideChat {
  type: 'HIDE_CHAT'
}

/** chat → SW: the user granted the per-site capture permission; retry. */
export interface PermissionGranted {
  type: 'PERMISSION_GRANTED'
}

export type ConversationAction =
  | { action: 'create'; title: string }
  | { action: 'select'; conversationId: string }
  | { action: 'attach'; conversationId: string; imageId: string }
  | { action: 'delete'; conversationId: string }

export type ConversationResponse<T> = { ok: true; value: T } | { ok: false; error: string }
export const GENERATION_PORT = 'study-buddy-generation'

export type Message =
  | StartSelection
  | RestoreChat
  | ShowOverlay
  | HideOverlay
  | CaptureRequest
  | SelectionCancelled
  | ShowChat
  | HideChat
  | PermissionGranted

/** Captures are held in chrome.storage.session under `capture.<id>`; the chat
 *  page (an extension page) reads them directly. Session storage never touches
 *  disk, so the crop dies with the browser session. */
export const CAPTURE_PREFIX = 'capture.'

/** How many recent crops to keep in session storage (pruning bounds memory). */
export const MAX_KEPT_CAPTURES = 8

export interface StoredCapture {
  /** PNG data URL of the cropped region. */
  dataUrl: string
  /** Selected rect in CSS px, for re-anchoring the window on reuse. */
  rect: Rect
  ts: number
}
