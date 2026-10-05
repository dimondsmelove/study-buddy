// AI connection settings — provider preset, endpoint, API key.
//
// The whole Settings object lives under a single chrome.storage.local key.
// local (not sync) is deliberate: the API key is stored only on this device —
// sync storage would push it to the user's cloud account. Reads are merged
// over DEFAULT_SETTINGS field by field, so a partially written or older shape
// still yields a complete typed Settings (unknown future fields, including the
// old `model` field, are dropped).
//
// The model is NOT here: it is fixed by the fallback chain in ai.ts, so the
// user never picks one. `model` used to live here and is deliberately ignored.

export interface Settings {
  /** 'openrouter' = the default preset; 'custom' = any OpenAI-compatible endpoint. */
  provider: 'openrouter' | 'custom'
  baseUrl: string
  apiKey: string
}

export const SETTINGS_KEY = 'settings'

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
}

/** Read settings merged over defaults (forward-compatible with new fields). */
export async function getSettings(): Promise<Settings> {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY)
    const stored = (got[SETTINGS_KEY] ?? {}) as Partial<Settings>
    return {
      // The only union field: an unexpected stored value must not leak into
      // typed callers, so anything but the two known presets falls back to
      // the default instead of being trusted.
      provider: stored.provider === 'custom' ? 'custom' : 'openrouter',
      baseUrl: stored.baseUrl ?? DEFAULT_SETTINGS.baseUrl,
      apiKey: stored.apiKey ?? DEFAULT_SETTINGS.apiKey,
    }
  } catch {
    // Storage can fail (quota, transient API errors); failing open to the
    // defaults matches the rest of the extension's error handling.
    return { ...DEFAULT_SETTINGS }
  }
}

/** Persist settings (whole object) to chrome.storage.local. */
export async function setSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
}
