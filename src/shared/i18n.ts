// In-app localization (UI chrome) + language metadata for the model prompt.
//
// This is a hand-rolled dictionary rather than chrome.i18n/_locales on purpose:
// chrome.i18n is bound to the browser locale at startup and cannot be switched
// at runtime, but the user picks the interface language in Settings. The store
// listing's own name/description still uses _locales later; this is only the
// extension's own UI.

import type { AnswerLanguage, UiLanguage } from './settings'

export type UiLang = 'en' | 'ru'

/** Browser tag (e.g. "ru-RU") → the base code we support. */
export function browserLang(): string {
  const tag = navigator.language || 'en'
  return tag.toLowerCase().split('-')[0]
}

/** The interface language to render, given the user's setting. */
export function resolveUiLang(setting: UiLanguage, tag = browserLang()): UiLang {
  if (setting === 'en' || setting === 'ru') return setting
  return tag === 'ru' ? 'ru' : 'en'
}

type Dict = Record<string, string>

const EN: Dict = {
  'capture.newSelection': 'New selection',
  'capture.settings': 'Settings',
  'capture.hint': 'Pick an action above, or ask a question about the selected region.',
  'preset.solve': 'Solve',
  'preset.quiz': 'Quiz',
  'preset.explain': 'Explain',
  'preset.translate': 'Translate',
  'preset.summarize': 'Summarize',
  'ask.placeholder': 'Ask anything about this…',
  'ask.button': 'Ask',
  'ask.stop': 'Stop',
  'msg.copy': 'Copy',
  'msg.copied': 'Copied',
  'msg.retry': 'Retry',
  'msg.simpler': 'Explain simpler',
  'msg.emptyReply': '(the model returned an empty reply)',
  'msg.stopped': '(stopped)',
  'msg.fallback': '{from} is unavailable ({reason}) — switched to {to}.',
  'welcome.title': 'Welcome to Study Buddy',
  'welcome.pitch': 'Select any part of a page and get a clear, step-by-step answer in your language. No account — your key stays on this device.',
  'welcome.keyLabel': 'OpenRouter API key',
  'welcome.getKey': 'Get a free key',
  'welcome.start': 'Start',
  'welcome.test': 'Test key',
  'welcome.testing': 'Checking…',
  'welcome.ok': 'Key works.',
  'welcome.needKey': 'Enter a key to start.',
  'settings.title': 'Settings',
  'settings.provider': 'Provider',
  'settings.baseUrl': 'Base URL',
  'settings.apiKey': 'API key',
  'settings.uiLanguage': 'Interface language',
  'settings.answerLanguage': 'Answer language',
  'settings.model': 'Model',
  'settings.modelInfo': 'DeepSeek (vision), with an automatic fallback if it’s unavailable.',
  'settings.back': 'Back',
  'settings.save': 'Save',
  'settings.keyNote': 'The API key is stored only on this device — never synced or sent anywhere except the model endpoint.',
  'settings.getKey': 'Get a key at',
  'err.enterKey': 'Enter an API key.',
  'err.badUrl': 'Base URL must be a valid http(s) URL.',
  'err.needKey': 'Add an API key, then Save.',
  'state.permissionTitle': 'Allow capture on this site',
  'state.permissionText': 'Study Buddy needs your permission to capture {origin}.',
  'state.permissionTextNoOrigin': 'Study Buddy needs your permission to capture this site.',
  'state.allow': 'Allow for this site',
  'state.granted': 'Granted! Starting selection…',
  'state.restrictedTitle': 'Can’t capture this page',
  'state.restrictedText': 'This page ({reason}) can never be captured by any extension.',
  'state.errorTitle': 'Something went wrong',
  'state.expired': 'This capture has expired (browser restart?). Select the region again.',
  'state.noState': 'Opened without a state. Select a region on a page to begin.',
  'state.noActiveTab': 'Could not determine the site to allow. Please retry from the page.',
  'state.settingsLink': '⚙ Settings…',
  'lang.auto': 'Auto',
}

const RU: Dict = {
  'capture.newSelection': 'Новое выделение',
  'capture.settings': 'Настройки',
  'capture.hint': 'Выберите действие выше или задайте вопрос о выделенной области.',
  'preset.solve': 'Решить',
  'preset.quiz': 'Тест',
  'preset.explain': 'Объяснить',
  'preset.translate': 'Перевести',
  'preset.summarize': 'Конспект',
  'ask.placeholder': 'Спросите что угодно об этом…',
  'ask.button': 'Спросить',
  'ask.stop': 'Стоп',
  'msg.copy': 'Копировать',
  'msg.copied': 'Скопировано',
  'msg.retry': 'Повторить',
  'msg.simpler': 'Проще',
  'msg.emptyReply': '(модель вернула пустой ответ)',
  'msg.stopped': '(остановлено)',
  'msg.fallback': '{from} недоступна ({reason}) — переключились на {to}.',
  'welcome.title': 'Добро пожаловать в Study Buddy',
  'welcome.pitch': 'Выделите любую область на странице и получите понятный пошаговый ответ на своём языке. Без аккаунта — ключ хранится только на этом устройстве.',
  'welcome.keyLabel': 'API-ключ OpenRouter',
  'welcome.getKey': 'Получить бесплатный ключ',
  'welcome.start': 'Начать',
  'welcome.test': 'Проверить ключ',
  'welcome.testing': 'Проверяем…',
  'welcome.ok': 'Ключ рабочий.',
  'welcome.needKey': 'Введите ключ, чтобы начать.',
  'settings.title': 'Настройки',
  'settings.provider': 'Провайдер',
  'settings.baseUrl': 'Base URL',
  'settings.apiKey': 'API-ключ',
  'settings.uiLanguage': 'Язык интерфейса',
  'settings.answerLanguage': 'Язык ответов',
  'settings.model': 'Модель',
  'settings.modelInfo': 'DeepSeek (vision) с авто-фолбэком, если недоступна.',
  'settings.back': 'Назад',
  'settings.save': 'Сохранить',
  'settings.keyNote': 'API-ключ хранится только на этом устройстве — не синхронизируется и никуда не уходит, кроме самого endpoint’а модели.',
  'settings.getKey': 'Получить ключ:',
  'err.enterKey': 'Введите API-ключ.',
  'err.badUrl': 'Base URL должен быть корректным http(s)-адресом.',
  'err.needKey': 'Добавьте API-ключ и сохраните.',
  'state.permissionTitle': 'Разрешить захват на этом сайте',
  'state.permissionText': 'Study Buddy нужен доступ, чтобы захватывать {origin}.',
  'state.permissionTextNoOrigin': 'Study Buddy нужен доступ, чтобы захватывать этот сайт.',
  'state.allow': 'Разрешить для этого сайта',
  'state.granted': 'Разрешено! Запускаем выделение…',
  'state.restrictedTitle': 'Эту страницу захватить нельзя',
  'state.restrictedText': 'Эту страницу ({reason}) не может захватить ни одно расширение.',
  'state.errorTitle': 'Что-то пошло не так',
  'state.expired': 'Захват устарел (перезапуск браузера?). Выделите область заново.',
  'state.noState': 'Открыто без состояния. Выделите область на странице.',
  'state.noActiveTab': 'Не удалось определить сайт. Повторите со страницы.',
  'state.settingsLink': '⚙ Настройки…',
  'lang.auto': 'Авто',
}

const DICTS: Record<UiLang, Dict> = { en: EN, ru: RU }

/** Translate a key; `vars` fills `{name}` placeholders. Falls back to English,
 *  then to the key itself, so a missing string degrades visibly, not blankly. */
export function t(lang: UiLang, key: string, vars?: Record<string, string | number>): string {
  let s = DICTS[lang][key] ?? EN[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  }
  return s
}

/** Native names for the answer-language select (same in every UI language). */
export const ANSWER_LANGUAGE_LABELS: Record<AnswerLanguage, string> = {
  auto: 'Auto',
  en: 'English',
  ru: 'Русский',
  uk: 'Українська',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  pt: 'Português',
  pl: 'Polski',
  tr: 'Türkçe',
  zh: '中文',
  ja: '日本語',
}

/** English language names handed to the model in the prompt. */
export const PROMPT_LANGUAGE_NAMES: Record<Exclude<AnswerLanguage, 'auto'>, string> = {
  en: 'English',
  ru: 'Russian',
  uk: 'Ukrainian',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  pl: 'Polish',
  tr: 'Turkish',
  zh: 'Chinese',
  ja: 'Japanese',
}
