// The one place that decides which model answers. Provider failures surface
// directly so an unavailable Luna request is never silently sent elsewhere.

import type { ApiMessage, CompletionResult, ProviderSettings } from './api'
import { chatCompletion } from './api'

/** Primary model. */
export const MODEL_PRIMARY = 'openai/gpt-6-luna'
/** No alternate model is configured for this stage. */
export const MODEL_FALLBACKS: string[] = []
/** The full chain, primary first. */
export const MODEL_CHAIN = [MODEL_PRIMARY]

/** Friendly names for the UI (fallback notices). */
const MODEL_LABELS: Record<string, string> = {
  [MODEL_PRIMARY]: 'GPT-6 Luna',
}

/** Short human name for a model id, falling back to the id itself. */
export function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id
}

export interface AskOpts {
  settings: ProviderSettings
  messages: ApiMessage[]
  /** Hard token cutoff for the answer (a cap, not a length target). */
  maxTokens?: number
  /** Aborts the request (fetch signal). */
  signal?: AbortSignal
  /** Each text delta from whichever model is currently answering. */
  onDelta?: (delta: string) => void
}

/** Ask Luna once and surface its provider error without switching models. */
export async function askWithFallback(opts: AskOpts): Promise<CompletionResult> {
  const result = await chatCompletion({
    settings: opts.settings,
    model: MODEL_PRIMARY,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    signal: opts.signal,
    onDelta: opts.onDelta,
  })
  return { ...result, model: result.model ?? MODEL_PRIMARY }
}
