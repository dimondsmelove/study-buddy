// The seam between the UI and HOW a question reaches a model.
//
// Today there is one implementation: `createGateway` talks straight to the
// configured OpenAI-compatible endpoint with a key that is either the user's
// (BYOK, dev) or baked into the build (store). The future subscription model
// swaps in a hosted gateway — your proxy holds the key, enforces quotas and
// billing — that implements this same interface. Because the chat UI only ever
// calls `gateway.ask(...)`, that swap is a change in this file, not in the app.

import type { ApiMessage } from './api'
import { askWithFallback } from './ai'
import type { Settings } from './settings'

export interface AskRequest {
  messages: ApiMessage[]
  /** Aborts the whole request. */
  signal?: AbortSignal
  /** Each text delta as it streams in. */
  onDelta?: (delta: string) => void
  /** Called right before the fallback model takes over. */
  onFallback?: (from: string, to: string, error: Error) => void
}

export interface Gateway {
  ask(request: AskRequest): Promise<string>
}

/** Direct-to-provider gateway (BYOK or a baked key). */
export function createGateway(settings: Settings): Gateway {
  return {
    ask: (request) => askWithFallback({ settings, ...request }),
  }
}
