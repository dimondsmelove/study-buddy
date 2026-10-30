// Presentation settings live on this device. Provider credentials and endpoint
// configuration belong to the backend and are removed from legacy records.

/** UI chrome language. 'auto' follows the browser. */
export type UiLanguage = 'auto' | 'en' | 'ru'

/** Language the model is asked to answer in. 'auto' = match the question (and
 *  use the UI language for the fixed preset buttons). */
export type AnswerLanguage =
  | 'auto'
  | 'en'
  | 'de'
  | 'fr'
  | 'es'
  | 'it'
  | 'nl'
  | 'sv'
  | 'da'
  | 'no'
  | 'fi'
  | 'ar'
  | 'id'
  | 'ru'
  | 'pt'
  | 'ja'
  | 'fil'
  | 'vi'
  | 'tr'
  | 'th'
  | 'ko'

export interface Settings {
  uiLanguage: UiLanguage
  answerLanguage: AnswerLanguage
}

export const SETTINGS_KEY = 'settings'

export const DEFAULT_SETTINGS: Settings = {
  uiLanguage: 'en',
  answerLanguage: 'en',
}

const UI_LANGUAGES: UiLanguage[] = ['auto', 'en', 'ru']
export const ANSWER_LANGUAGES: readonly AnswerLanguage[] = [
  'auto', 'en', 'de', 'fr', 'es', 'it', 'nl', 'sv', 'da', 'no', 'fi', 'ar', 'id', 'ru', 'pt', 'ja', 'fil', 'vi', 'tr', 'th', 'ko',
]

/** Browser language (primary subtag) if supported, else English. */
export function defaultAnswerLanguage(): AnswerLanguage {
  let tag = ''
  try { tag = (globalThis.navigator?.language ?? '').toLowerCase() } catch { tag = '' }
  let code = tag.split(/[-_]/)[0] ?? ''
  if (code === 'nb' || code === 'nn') code = 'no'
  else if (code === 'tl') code = 'fil'
  return code !== 'auto' && ANSWER_LANGUAGES.includes(code as AnswerLanguage)
    ? (code as AnswerLanguage)
    : DEFAULT_SETTINGS.answerLanguage
}

/** Read language settings and remove provider fields from legacy storage. */
export async function getSettings(): Promise<Settings> {
  let value: unknown
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY)
    value = got[SETTINGS_KEY]
  } catch {
    throw new Error('storage.read')
  }
  const stored = (value && typeof value === 'object' ? value : {}) as Partial<Settings> & Record<string, unknown>
  const settings: Settings = {
    uiLanguage: UI_LANGUAGES.includes(stored.uiLanguage as UiLanguage)
      ? (stored.uiLanguage as UiLanguage)
      : DEFAULT_SETTINGS.uiLanguage,
    answerLanguage: ANSWER_LANGUAGES.includes(stored.answerLanguage as AnswerLanguage)
      ? (stored.answerLanguage as AnswerLanguage)
      : defaultAnswerLanguage(),
  }
  const keys = Object.keys(stored)
  if (keys.length !== 2 || !keys.includes('uiLanguage') || !keys.includes('answerLanguage') ||
      stored.uiLanguage !== settings.uiLanguage || stored.answerLanguage !== settings.answerLanguage) {
    try { await chrome.storage.local.set({ [SETTINGS_KEY]: settings }) }
    catch { throw new Error('storage.write') }
  }
  return settings
}

/** Persist the complete language-only settings record. */
export async function setSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
}
