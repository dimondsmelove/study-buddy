// The one place that decides which model answers. Provider failures surface
// directly so an unavailable Haiku request is never silently sent elsewhere.

import type { ApiMessage, CompletionResult, ProviderSettings } from './api'
import { chatCompletion } from './api'

/** Primary model. */
export const MODEL_PRIMARY = 'anthropic/claude-haiku-5.5'
/** No alternate model is configured for this stage. */
export const MODEL_FALLBACKS: string[] = []
/** The full chain, primary first. */
export const MODEL_CHAIN = [MODEL_PRIMARY]

/** Friendly names for the UI (fallback notices). */
const MODEL_LABELS: Record<string, string> = {
  [MODEL_PRIMARY]: 'Claude Haiku 5.5',
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
  onProviderGenerationId?: (id: string) => void
  onProviderResponseAccepted?: () => void
}

/** Ask Haiku once and surface its provider error without switching models. */
export async function askWithFallback(opts: AskOpts): Promise<CompletionResult> {
  const result = await chatCompletion({
    settings: opts.settings,
    model: MODEL_PRIMARY,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    reasoning: { effort: 'medium', exclude: true },
    signal: opts.signal,
    onDelta: opts.onDelta,
    onProviderGenerationId: opts.onProviderGenerationId,
    onProviderResponseAccepted: opts.onProviderResponseAccepted,
  })
  return { ...result, model: result.model ?? MODEL_PRIMARY }
}
