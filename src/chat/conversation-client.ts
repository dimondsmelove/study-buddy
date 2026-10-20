import { GENERATION_PORT, type ConversationAction, type ConversationResponse } from '../shared/messages'

export async function conversationAction<T>(action: ConversationAction): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type: 'CONVERSATION', ...action }) as ConversationResponse<T>
  if (!response?.ok) throw new Error(response?.error ?? 'storage.write')
  return response.value
}

/** A live writer lease: disconnect means the visible provider request stops. */
export class GenerationConnection {
  private port = chrome.runtime.connect({ name: GENERATION_PORT })
  private sequence = 0
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  private heartbeat: ReturnType<typeof setInterval>

  constructor(onLost: () => void, onStop: () => void) {
    this.port.onMessage.addListener((message) => {
      if (message.action === 'stop') { onStop(); return }
      const pending = this.pending.get(message.seq)
      if (!pending) return
      this.pending.delete(message.seq)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.error))
    })
    this.port.onDisconnect.addListener(() => {
      clearInterval(this.heartbeat)
      for (const pending of this.pending.values()) pending.reject(new Error('dialog.disconnected'))
      this.pending.clear()
      onLost()
    })
    // Sending a port message (not merely opening it) keeps an active MV3 writer alive.
    this.heartbeat = setInterval(() => { void this.request({ action: 'ping' }).catch(() => {}) }, 20_000)
  }

  request<T>(message: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const seq = ++this.sequence
      this.pending.set(seq, { resolve: (value) => resolve(value as T), reject })
      try { this.port.postMessage({ ...message, seq }) } catch {
        this.pending.delete(seq)
        reject(new Error('dialog.disconnected'))
      }
    })
  }

  close(): void {
    clearInterval(this.heartbeat)
    this.port.disconnect()
  }
}
