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
  'dialog.close': 'Close',
  'dialog.retention': 'Up to 20 recent chats are kept on this device. Only recent context needed for an answer is sent to the answer service.',
  'dialog.deleteTitle': 'Delete chat?',
  'dialog.deleteError': "Couldn't delete this chat. Try again.",
  'dialog.denied': 'This action is unavailable.',
  'dialog.cancel': 'Cancel',
  'dialog.today': 'Today',
  'dialog.yesterday': 'Yesterday',
  'dialog.deleteChat': 'Delete {title}',
  'dialog.delete': 'Delete',
  'dialog.deleteConfirm': 'Delete “{title}” and its unshared images? This cannot be undone.',
  'dialog.empty': 'No saved conversations.',
  'dialog.usage': 'Saved conversations and images: {size} MiB',
  'dialog.saved': 'Saved on this device',
  'dialog.unsaved': 'Not saved — copy this text before closing',
  'dialog.closeUnsaved': 'The latest visible text is not saved. Copy it first. Close anyway and lose that unsaved text?',
  'dialog.storageError': 'Storage failed. Saved data was kept; the latest visible text may be unsaved. Copy before closing.',
  'dialog.missing': 'This conversation was deleted. Choose History or New chat.',
  'dialog.busy': 'Another answer is running. Stop it in its window or wait.',
  'dialog.disconnected': 'The writer disconnected. The answer was interrupted.',
  'dialog.cooldown': 'Next request in {seconds}s',
  'dialog.cooldownShort': '{seconds}s',
  'dialog.attachment': 'Task image',
  'dialog.imagePreview': 'Preview task image',
  'dialog.closePreview': 'Close image preview',
  'context.text': 'The current task group is too large for the estimated input budget. Start a new chat or reselect a smaller task.',
  'context.imageMissing': 'A saved image is missing. Select the task again.',
  'context.imageLarge': 'An image exceeds 4 MiB. Select a smaller region.',
  'context.requestLarge': 'The selected images and messages exceed the 32 MiB request limit. Start a new chat and send only the needed material; select a smaller image region if needed.',
  'reply.streaming': 'Answering… partial text is being saved',
  'reply.complete': 'Complete · saved',
  'reply.truncated': 'Length limit reached · partial answer saved',
  'reply.interrupted': 'Interrupted · partial answer saved; retry explicitly',
  'reply.cancelled': 'Stopped · partial answer saved',
  'reply.provider_error': 'Provider error · available text saved',
  'reply.empty': 'Empty answer · saved',
  'capture.newSelection': 'Select another screen area and add its image to this chat',
  'context.usage': 'About {tokens}k input tokens · 200k budget',


  'context.details': 'Details',

  'context.detailsTitle': 'What the next answer includes',
  'context.limits': 'About 200,000 estimated input tokens per request, including system instructions and an image reserve; 20,000 tokens are held back for estimate variance. Whole older task groups are omitted first. Each image has a separate app-side 4 MiB payload guard; base64 and JSON add transport overhead. Omitted messages stay saved and can be sent again.',
  'context.included': 'Included',
  'context.excluded': 'Not sent',
  'context.reuse': 'Use again',
  'context.reuseTitle': 'Send this older message or image again to include it in the next request',
  'context.taskTooLarge': 'This task is too large for one request. Select a smaller area or start a new chat.',
  'context.reason.olderTask': 'Outside the current context',



  'context.reason.incomplete': 'Incomplete reply',
  'context.reason.superseded': 'Replaced by a later retry',
  'context.reason.empty': 'Empty reply',
  'context.noItems': 'No messages are excluded.',
  'context.user': 'You',
  'context.assistant': 'Study Buddy',
  'context.imageMessage': 'Image',
  'context.image.included': 'Image sent',
  'context.image.excluded': 'Image excluded',
  'context.image.otherTurn': 'Image is included with another message',
  'actions.more': 'More',
  'capture.settings': 'Settings',
  'capture.tools': 'Conversation tools',
  'capture.actions': 'Study actions',
  'capture.hint': 'Pick an action above, or ask a question about the selected region.',
  'preset.solve': 'Solve',
  'preset.quiz': 'Multiple choice',
  'preset.explain': 'Explain',
  'preset.translate': 'Translate',
  'preset.summarize': 'Summarize',
  'preset.hint': 'Hint',
  'preset.check': 'Check',

  'ask.placeholder': 'Ask anything about this…',
  'ask.button': 'Ask',
  'ask.stop': 'Stop',
  'msg.actions': 'Answer actions',
  'msg.copy': 'Copy',
  'msg.copied': 'Copied',
  'msg.copyFailed': 'Could not copy',
  'msg.retry': 'Retry',
  'msg.simpler': 'Explain simpler',
  'msg.emptyReply': '(the model returned an empty reply)',
  'msg.stopped': '(stopped)',
  'msg.fallback': 'The model is temporarily unavailable. Trying another.',
  'settings.title': 'Settings',
  'settings.uiLanguage': 'Interface language',
  'settings.answerLanguage': 'Answer language',
  'settings.back': 'Back',
  'settings.save': 'Save',
  'err.storageRead': 'Could not read settings. Nothing was saved; please retry.',
  'err.storageWrite': 'Could not save settings. Existing data was kept; please retry.',
  'err.notConnected': 'The answer service is not connected. Try again later.',
  'err.gatewayUnavailable': 'The answer service is unavailable. Check the connection and try again.',
  'err.gatewayUncertain': 'The request may have reached the answer service. Check this chat before starting another request.',
  'err.gatewaySession': 'The answer session expired. Start a new request to reconnect.',
  'err.gatewaySessionRate': 'Too many answer sessions were started from this network. Try again later.',
  'err.gatewayBudget': 'The anonymous monthly limit has been reached. It resets {date}.',
  'err.gatewayAccountingReview': 'A provider charge exceeded its reserved limit. Contact support before continuing.',
  'err.gatewayRate': 'Please wait {seconds}s before starting another request.',
  'err.gatewayBusy': 'The answer service is handling several requests. Try again in a moment.',
  'err.gatewayDuplicate': 'This request was already submitted. Check the saved conversation before retrying.',
  'err.gatewayContext': 'The selected context exceeds the provider limit. Start a new chat and send only the needed material; select a smaller image region if needed.',
  'err.gatewayProvider': 'The answer service could not complete this request. Available text was saved.',
  'err.gatewayTimeout': 'The generation exceeded its time limit. Available text was saved; retry manually.',
  'err.gatewayCancelled': 'Generation stopped. Available text was saved.',
  'err.gatewayStorage': 'The answer session could not be saved on this device.',
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
  'state.settingsLink': 'Settings',
  'lang.auto': 'Auto',
}

const RU: Dict = {
  'dialog.history': 'История',
  'dialog.new': 'Новый чат',
  'dialog.close': 'Закрыть',
  'dialog.retention': 'На устройстве хранятся до 20 недавних чатов. В сервис ответа отправляется только нужный недавний контекст.',
  'dialog.deleteTitle': 'Удалить чат?',
  'dialog.deleteError': 'Не удалось удалить чат. Попробуйте ещё раз.',
  'dialog.denied': 'Это действие недоступно.',
  'dialog.cancel': 'Отмена',
  'dialog.today': 'Сегодня',
  'dialog.yesterday': 'Вчера',
  'dialog.deleteChat': 'Удалить {title}',
  'dialog.delete': 'Удалить',
  'dialog.deleteConfirm': 'Удалить «{title}» и неиспользуемые изображения? Отменить удаление нельзя.',
  'dialog.empty': 'Сохранённых диалогов нет.',
  'dialog.usage': 'Диалоги и изображения: {size} МиБ',
  'dialog.saved': 'Сохранено на устройстве',
  'dialog.unsaved': 'Не сохранено — скопируйте текст до закрытия',
  'dialog.closeUnsaved': 'Последний видимый текст не сохранён. Сначала скопируйте его. Всё равно закрыть и потерять несохранённый текст?',
  'dialog.storageError': 'Ошибка хранения. Прежние данные сохранены; последний видимый текст может быть не сохранён. Скопируйте его до закрытия.',
  'dialog.missing': 'Диалог удалён. Откройте историю или новый чат.',
  'dialog.busy': 'Другой ответ ещё генерируется. Остановите его в том окне или дождитесь завершения.',
  'dialog.disconnected': 'Связь с записью потеряна. Ответ прерван.',
  'dialog.cooldown': 'Следующий запрос через {seconds} с',
  'dialog.cooldownShort': '{seconds}с',
  'dialog.attachment': 'Изображение задачи',
  'dialog.imagePreview': 'Показать изображение задания',
  'dialog.closePreview': 'Закрыть просмотр изображения',
  'context.text': 'Текущая группа задания слишком велика для оценочного бюджета запроса. Создайте новый чат или выделите меньшую область.',
  'context.imageMissing': 'Сохранённое изображение отсутствует. Выделите задачу повторно.',
  'context.imageLarge': 'Изображение больше 4 МиБ. Выделите меньшую область.',
  'context.requestLarge': 'Изображения и сообщения превышают лимит запроса 32 МиБ. Начните новый чат и отправьте только нужные материалы; при необходимости выделите меньшую область изображения.',
  'reply.streaming': 'Отвечаю… частичный текст сохраняется',
  'reply.complete': 'Завершено · сохранено',
  'reply.truncated': 'Лимит длины · частичный ответ сохранён',
  'reply.interrupted': 'Обрыв · частичный ответ сохранён; повтор — вручную',
  'reply.cancelled': 'Остановлено · частичный ответ сохранён',
  'reply.provider_error': 'Ошибка провайдера · доступный текст сохранён',
  'reply.empty': 'Пустой ответ · сохранено',
  'capture.newSelection': 'Выделить другую область экрана и добавить изображение в этот чат',
  'context.usage': '≈{tokens} тыс. / 200 тыс. токенов',


  'context.details': 'Состав',

  'context.detailsTitle': 'Что войдёт в следующий ответ',
  'context.limits': 'Около 200 000 оценочных входных токенов на запрос, включая системные инструкции и резерв на изображения; 20 000 токенов оставлены на погрешность оценки. Сначала исключаются целые старые группы заданий. Для изображения отдельно действует внутренний лимит полезной нагрузки 4 МиБ; base64 и JSON увеличивают объём передачи. Данные остаются в переписке, их можно отправить повторно.',
  'context.included': 'В запросе',
  'context.excluded': 'Не отправляется',
  'context.reuse': 'Использовать снова',
  'context.reuseTitle': 'Отправить старое сообщение или изображение повторно, чтобы включить в следующий запрос',
  'context.taskTooLarge': 'Это задание слишком велико для одного запроса. Выделите меньшую область или начните новый чат.',
  'context.reason.olderTask': 'Вне текущего контекста',



  'context.reason.incomplete': 'Незавершённый ответ',
  'context.reason.superseded': 'Заменён последним повтором',
  'context.reason.empty': 'Пустой ответ',
  'context.noItems': 'Все сообщения будут отправлены.',
  'context.user': 'Вы',
  'context.assistant': 'Study Buddy',
  'context.imageMessage': 'Изображение',
  'context.image.included': 'Изображение отправлено',
  'context.image.excluded': 'Изображение исключено',
  'context.image.otherTurn': 'Изображение отправляется в другом сообщении',
  'actions.more': 'Ещё',
  'capture.settings': 'Настройки',
  'capture.tools': 'Инструменты диалога',
  'capture.actions': 'Учебные действия',
  'capture.hint': 'Выберите действие выше или задайте вопрос о выделенной области.',
  'preset.solve': 'Решить',
  'preset.quiz': 'Выбор ответа',
  'preset.explain': 'Объяснить',
  'preset.translate': 'Перевести',
  'preset.summarize': 'Конспект',
  'preset.hint': 'Подсказка',
  'preset.check': 'Проверить',

  'ask.placeholder': 'Спросите что угодно об этом…',
  'ask.button': 'Спросить',
  'ask.stop': 'Стоп',
  'msg.actions': 'Действия с ответом',
  'msg.copy': 'Копировать',
  'msg.copied': 'Скопировано',
  'msg.copyFailed': 'Не удалось скопировать',
  'msg.retry': 'Повторить',
  'msg.simpler': 'Проще',
  'msg.emptyReply': '(модель вернула пустой ответ)',
  'msg.stopped': '(остановлено)',
  'msg.fallback': 'Модель временно недоступна. Пробуем другую.',
  'settings.title': 'Настройки',
  'settings.uiLanguage': 'Язык интерфейса',
  'settings.answerLanguage': 'Язык ответов',
  'settings.back': 'Назад',
  'settings.save': 'Сохранить',
  'err.storageRead': 'Не удалось прочитать настройки. Ничего не сохранено; попробуйте снова.',
  'err.storageWrite': 'Не удалось сохранить настройки. Прежние данные сохранены; попробуйте снова.',
  'err.notConnected': 'Сервис ответов не подключён. Попробуйте позже.',
  'err.gatewayUnavailable': 'Сервис ответа недоступен. Проверьте соединение и попробуйте ещё раз.',
  'err.gatewayUncertain': 'Запрос мог дойти до сервиса ответа. Проверьте диалог, прежде чем запускать новый запрос.',
  'err.gatewaySession': 'Сеанс ответа истёк. Создайте новый запрос, чтобы подключиться снова.',
  'err.gatewaySessionRate': 'Из этой сети запущено слишком много сеансов. Попробуйте позже.',
  'err.gatewayBudget': 'Месячный лимит анонимного использования исчерпан. Он обновится {date}.',
  'err.gatewayAccountingReview': 'Списание провайдера превысило резерв. Обратитесь в поддержку, прежде чем продолжить.',
  'err.gatewayRate': 'Подождите {seconds} с перед следующим запросом.',
  'err.gatewayBusy': 'Сервис ответа обрабатывает несколько запросов. Попробуйте немного позже.',
  'err.gatewayDuplicate': 'Этот запрос уже отправлен. Проверьте сохранённый диалог перед повтором.',
  'err.gatewayContext': 'Выбранный контекст превышает лимит провайдера. Начните новый чат и отправьте только нужные материалы; при необходимости выделите меньшую область изображения.',
  'err.gatewayProvider': 'Сервис ответа не смог завершить запрос. Доступный текст сохранён.',
  'err.gatewayTimeout': 'Истекло время ожидания ответа. Доступный текст сохранён; повторите запрос вручную.',
  'err.gatewayCancelled': 'Генерация остановлена. Доступный текст сохранён.',
  'err.gatewayStorage': 'Не удалось сохранить сеанс ответа на этом устройстве.',
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
  'state.settingsLink': 'Настройки',
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
