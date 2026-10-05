// AI connection + presentation settings.
//
// The whole Settings object lives under a single chrome.storage.local key.
// local (not sync) is deliberate: the API key is stored only on this device —
// sync storage would push it to the user's cloud account. Reads are merged
// over DEFAULT_SETTINGS field by field, so a partially written or older shape
// still yields a complete typed Settings (unknown fields, including the old
// `model` field, are dropped).
//
// The model is NOT here: it is fixed by the fallback chain in ai.ts, so the
// user never picks one.

/** UI chrome language. 'auto' follows the browser. */
export type UiLanguage = 'auto' | 'en' | 'ru'

/** Language the model is asked to answer in. 'auto' = match the question (and
 *  use the UI language for the fixed preset buttons). */
export type AnswerLanguage =
  | 'auto'
  | 'en'
  | 'ru'
  | 'uk'
  | 'de'
  | 'fr'
  | 'es'
  | 'it'
  | 'pt'
  | 'pl'
  | 'tr'
  | 'zh'
  | 'ja'

export interface Settings {
  /** 'openrouter' = the default preset; 'custom' = any OpenAI-compatible endpoint. */
  provider: 'openrouter' | 'custom'
  baseUrl: string
  apiKey: string
  uiLanguage: UiLanguage
  answerLanguage: AnswerLanguage
}

export const SETTINGS_KEY = 'settings'

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  uiLanguage: 'auto',
  answerLanguage: 'auto',
}

const UI_LANGUAGES: UiLanguage[] = ['auto', 'en', 'ru']
const ANSWER_LANGUAGES: AnswerLanguage[] = [
  'auto', 'en', 'ru', 'uk', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr', 'zh', 'ja',
]

/** Read settings merged over defaults (forward-compatible with new fields). */
export async function getSettings(): Promise<Settings> {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY)
    const stored = (got[SETTINGS_KEY] ?? {}) as Partial<Settings>
    return {
      // Union fields must not leak an unexpected stored value into typed
      // callers, so anything unknown falls back to the default.
      provider: stored.provider === 'custom' ? 'custom' : 'openrouter',
      baseUrl: stored.baseUrl ?? DEFAULT_SETTINGS.baseUrl,
      apiKey: stored.apiKey ?? DEFAULT_SETTINGS.apiKey,
      uiLanguage: UI_LANGUAGES.includes(stored.uiLanguage as UiLanguage)
        ? (stored.uiLanguage as UiLanguage)
        : DEFAULT_SETTINGS.uiLanguage,
      answerLanguage: ANSWER_LANGUAGES.includes(stored.answerLanguage as AnswerLanguage)
        ? (stored.answerLanguage as AnswerLanguage)
        : DEFAULT_SETTINGS.answerLanguage,
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
