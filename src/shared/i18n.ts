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
  'dialog.history': 'History',
  'dialog.new': 'New chat',
  'dialog.retention': 'Text and images stay on this device until you delete them. Only the bounded context is sent to your model endpoint.',
  'dialog.export': 'Export JSON',
  'dialog.delete': 'Delete',
  'dialog.deleteConfirm': 'Delete “{title}” and its unshared images? This cannot be undone.',
  'dialog.empty': 'No saved conversations.',
  'dialog.usage': 'Saved conversations and images: {size} MiB',
  'dialog.saved': 'Saved on this device',
  'dialog.unsaved': 'Not saved — copy or export this text before closing',
  'dialog.closeUnsaved': 'The latest visible text is not saved. Copy/export it first. Close anyway and lose that unsaved text?',
  'dialog.storageError': 'Storage failed. Saved data was kept; the latest visible text may be unsaved. Copy or export before closing.',
  'dialog.missing': 'This conversation was deleted. Choose History or New chat.',
  'dialog.busy': 'Another answer is running. Stop it in its window or wait.',
  'dialog.disconnected': 'The writer disconnected. The answer was interrupted.',
  'dialog.cooldown': 'Next request in {seconds}s',
  'dialog.attachment': 'Task image',
  'context.text': 'The required task or attempt exceeds 32,000 characters. Start a new chat or shorten the input explicitly.',
  'context.imageMissing': 'A saved image is missing. Select the task again.',
  'context.imageLarge': 'An image exceeds 4 MiB. Select a smaller region.',
  'context.omitted': '{count} older or incomplete messages are not sent; the full transcript remains saved.',
  'reply.streaming': 'Answering… partial text is being saved',
  'reply.complete': 'Complete · saved',
  'reply.truncated': 'Length limit reached · partial answer saved',
  'reply.interrupted': 'Interrupted · partial answer saved; retry explicitly',
  'reply.cancelled': 'Stopped · partial answer saved',
  'reply.provider_error': 'Provider error · available text saved',
  'reply.empty': 'Empty answer · saved',
  'capture.newSelection': 'New selection',
  'capture.settings': 'Settings',
  'capture.hint': 'Pick an action above, or ask a question about the selected region.',
  'preset.solve': 'Solve',
  'preset.quiz': 'Multiple choice',
  'preset.explain': 'Explain',
  'preset.translate': 'Translate',
  'preset.summarize': 'Summarize',
  'preset.hint': 'Hint',
  'preset.check': 'Check my attempt',
  'check.placeholder': 'Enter your attempt, including any steps…',
  'check.submit': 'Check attempt',
  'check.needAttempt': 'Enter your attempt before checking.',
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
  'settings.advanced': 'Advanced (use your own key)',
  'settings.getKey': 'Get a key at',
  'err.enterKey': 'Enter an API key.',
  'err.badUrl': 'Use an http(s) endpoint without credentials, query or fragment.',
  'err.storage': 'Could not save. Existing data was kept; please retry.',
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
  'dialog.history': 'История',
  'dialog.new': 'Новый чат',
  'dialog.retention': 'Текст и изображения хранятся на устройстве до удаления. Провайдеру отправляется только ограниченный контекст.',
  'dialog.export': 'Экспорт JSON',
  'dialog.delete': 'Удалить',
  'dialog.deleteConfirm': 'Удалить «{title}» и неиспользуемые изображения? Отменить удаление нельзя.',
  'dialog.empty': 'Сохранённых диалогов нет.',
  'dialog.usage': 'Диалоги и изображения: {size} МиБ',
  'dialog.saved': 'Сохранено на устройстве',
  'dialog.unsaved': 'Не сохранено — скопируйте или экспортируйте текст до закрытия',
  'dialog.closeUnsaved': 'Последний видимый текст не сохранён. Сначала скопируйте или экспортируйте его. Всё равно закрыть и потерять несохранённый текст?',
  'dialog.storageError': 'Ошибка хранения. Прежние данные сохранены; последний видимый текст может быть не сохранён. Скопируйте или экспортируйте его до закрытия.',
  'dialog.missing': 'Диалог удалён. Откройте историю или новый чат.',
  'dialog.busy': 'Другой ответ ещё генерируется. Остановите его в том окне или дождитесь завершения.',
  'dialog.disconnected': 'Связь с записью потеряна. Ответ прерван.',
  'dialog.cooldown': 'Следующий запрос через {seconds} с',
  'dialog.attachment': 'Изображение задачи',
  'context.text': 'Обязательная задача или попытка больше 32 000 символов. Создайте новый чат или явно сократите ввод.',
  'context.imageMissing': 'Сохранённое изображение отсутствует. Выделите задачу повторно.',
  'context.imageLarge': 'Изображение больше 4 МиБ. Выделите меньшую область.',
  'context.omitted': '{count} старых или неполных сообщений не отправлены; исходный диалог сохранён полностью.',
  'reply.streaming': 'Отвечаю… частичный текст сохраняется',
  'reply.complete': 'Завершено · сохранено',
  'reply.truncated': 'Лимит длины · частичный ответ сохранён',
  'reply.interrupted': 'Обрыв · частичный ответ сохранён; повтор — вручную',
  'reply.cancelled': 'Остановлено · частичный ответ сохранён',
  'reply.provider_error': 'Ошибка провайдера · доступный текст сохранён',
  'reply.empty': 'Пустой ответ · сохранено',
  'capture.newSelection': 'Новое выделение',
  'capture.settings': 'Настройки',
  'capture.hint': 'Выберите действие выше или задайте вопрос о выделенной области.',
  'preset.solve': 'Решить',
  'preset.quiz': 'Выбор ответа',
  'preset.explain': 'Объяснить',
  'preset.translate': 'Перевести',
  'preset.summarize': 'Конспект',
  'preset.hint': 'Подсказка',
  'preset.check': 'Проверить попытку',
  'check.placeholder': 'Введите свою попытку решения, включая шаги…',
  'check.submit': 'Проверить попытку',
  'check.needAttempt': 'Сначала введите свою попытку решения.',
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
  'settings.advanced': 'Дополнительно (свой ключ)',
  'settings.getKey': 'Получить ключ:',
  'err.enterKey': 'Введите API-ключ.',
  'err.badUrl': 'Укажите http(s)-адрес без логина, пароля, параметров и фрагмента.',
  'err.storage': 'Сохранение не удалось. Прежние данные сохранены; попробуйте снова.',
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

/** Russian language names (nominative) for the RU prompt templates:
 *  «Язык ответа: русский». Case-neutral on purpose — templates reference the
 *  language as a label, never inflect it. */
export const RU_LANGUAGE_NAMES: Record<Exclude<AnswerLanguage, 'auto'>, string> = {
  en: 'английский',
  ru: 'русский',
  uk: 'украинский',
  de: 'немецкий',
  fr: 'французский',
  es: 'испанский',
  it: 'итальянский',
  pt: 'португальский',
  pl: 'польский',
  tr: 'турецкий',
  zh: 'китайский',
  ja: 'японский',
}
