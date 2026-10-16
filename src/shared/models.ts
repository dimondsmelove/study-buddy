// Model listing for the settings view's model picker.
//
// GET {baseUrl}/models is the one endpoint every OpenAI-compatible server
// speaks, but how much it says varies: OpenRouter decorates each entry with an
// `architecture` object whose input_modalities names the accepted inputs
// ('text', 'image', …), while a plain OpenAI-style endpoint returns a bare id
// list with no modality info at all. The picker can only be as honest as the
// data allows — hence the `filtered: false` shape: "everything listed" must
// never be mistaken for "everything here is vision-capable".
//
// Error phrasing is deliberately shared with chatCompletion (api.ts): one
// voice for every failure the endpoint can produce, because this list is
// fetched from the same settings form the chat request goes out from.

import { apiHttpError, apiNetworkError, authHeaders } from './api'
import type { ProviderSettings } from './api'

export interface ModelInfo {
  id: string
  /** Human label from the endpoint; when absent, the id doubles as the name. */
  name: string
}

export interface ModelsResult {
  models: ModelInfo[]
  /** false = the endpoint exposed no modality info (plain OpenAI-style list):
   *  everything is listed, the vision filter could NOT be applied. */
  filtered: boolean
}

// The part of a /models entry this module reads; everything else is ignored.
// Fields are typed unknown where a malformed value must be detected rather
// than trusted — third-party JSON is the least controlled data in the
// extension, and one bad entry must cost nothing but itself.
interface RawModel {
  id?: unknown
  name?: unknown
  architecture?: { input_modalities?: unknown }
}

/** Fetch the endpoint's model list, keeping only vision-capable models when
 *  the endpoint says which ones those are (OpenRouter does). Sorted by id.
 *  Throws with the same human phrasing as chatCompletion; an empty
 *  settings.model must NOT trigger that guard — listing models is exactly how
 *  a user picks one, so nothing here reads settings.model at all. */
export async function fetchVisionModels(settings: ProviderSettings): Promise<ModelsResult> {
  let res: Response
  try {
    res = await fetch(`${settings.baseUrl}/models`, {
      // Bearer key only: X-Title stays a chat-completions attribution header
      // (api.ts); /models carries no model attribution on any endpoint.
      headers: authHeaders(settings),
    })
  } catch (err) {
    throw apiNetworkError(err)
  }
  if (!res.ok) throw await apiHttpError(res)

  let body: { data?: unknown } | null
  try {
    body = (await res.json()) as { data?: unknown } | null
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('Cancelled.')
    throw new Error('The API response was not valid JSON.')
  }

  const entries = Array.isArray(body?.data) ? (body.data as unknown[]) : []
  // First pass — collect whatever entries are readable. A malformed entry
  // (no id, wrong types) is skipped, never fatal: a single hiccup in someone
  // else's listing must not blank the whole picker.
  const parsed: Array<{ id: string; name?: string; mods?: string[] }> = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as RawModel
    if (typeof e.id !== 'string' || !e.id) continue
    parsed.push({
      id: e.id,
      name: typeof e.name === 'string' && e.name ? e.name : undefined,
      // Non-string modality names are dropped, not coerced into the filter.
      mods:
        e.architecture && Array.isArray(e.architecture.input_modalities)
          ? e.architecture.input_modalities.filter((m): m is string => typeof m === 'string')
          : undefined,
    })
  }

  // Modality info on ANY entry ⇒ the endpoint declares modalities per model:
  // keep only image-capable ids (entries without the array are NOT vision-
  // capable, they are unlisted). Info on NO entry ⇒ a plain OpenAI-style
  // list — filtering would be guessing, so everything is listed and the
  // caller (settings UI) is told the filter could not be applied.
  const filtered = parsed.some((m) => m.mods !== undefined)
  const kept = filtered ? parsed.filter((m) => (m.mods ?? []).includes('image')) : parsed

  return {
    models: kept
      .map((m) => ({ id: m.id, name: m.name ?? m.id }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    filtered,
  }
}
