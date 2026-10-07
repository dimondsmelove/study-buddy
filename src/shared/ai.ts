// The one place that decides WHICH model answers.
//
// For now the model is not user-selectable: every request goes to DeepSeek,
// with an ordered fallback chain for when that model is unavailable. The chain
// is tried only on genuine availability failures (see isRetryable) and only
// while the failing attempt has produced nothing yet — a model that streamed
// half an answer and then died must show that error, not silently restart on
// another model and duplicate the visible text.

import type { ApiMessage, CompletionResult } from './api'
import { chatCompletion, isRetryable } from './api'
import type { Settings } from './settings'

/** Primary model. */
export const MODEL_PRIMARY = 'deepseek/deepseek-v4-flash-vision-exp'
/** Tried in order when the primary (or a previous fallback) is unavailable. */
export const MODEL_FALLBACKS = ['google/gemini-2.5-flash-lite', 'openai/gpt-5-nano']
/** The full chain, primary first. */
export const MODEL_CHAIN = [MODEL_PRIMARY, ...MODEL_FALLBACKS]

/** Friendly names for the UI (fallback notices). */
const MODEL_LABELS: Record<string, string> = {
  [MODEL_PRIMARY]: 'DeepSeek',
  'google/gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
  'openai/gpt-5-nano': 'GPT-5 Nano',
}

/** Short human name for a model id, falling back to the id itself. */
export function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id
}

export interface AskOpts {
  settings: Settings
  messages: ApiMessage[]
  /** Sampling temperature (0 = deterministic; factual tasks). */
  temperature?: number
  /** Hard token cutoff for the answer (a cap, not a length target). */
  maxTokens?: number
  /** Aborts the whole chain (fetch signal). */
  signal?: AbortSignal
  /** Each text delta from whichever model is currently answering. */
  onDelta?: (delta: string) => void
  /** Called right before switching models, so the UI can say so. */
  onFallback?: (from: string, to: string, error: Error) => void
}

/** Ask the chain until one model answers. Returns the completion; throws the
 *  last error if every model failed (or the first one failed non-retryably). */
export async function askWithFallback(opts: AskOpts): Promise<CompletionResult> {
  let lastError: unknown
  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i]
    const next = MODEL_CHAIN[i + 1]
    let emitted = false
    try {
      return await chatCompletion({
        settings: opts.settings,
        model,
        messages: opts.messages,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        onDelta: (delta) => {
          emitted = true
          opts.onDelta?.(delta)
        },
      })
    } catch (err) {
      lastError = err
      // `isRetryable` already excludes 'aborted'; `emitted` guards the
      // half-stream case described above.
      if (!next || emitted || !isRetryable(err)) throw err
      opts.onFallback?.(model, next, err instanceof Error ? err : new Error(String(err)))
    }
  }
  throw lastError
}
