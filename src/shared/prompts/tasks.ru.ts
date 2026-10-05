// Russian task templates — the reference dictionary (native RU, written for a
// Russian-speaking student; school conventions: «Ответ → Решение → Проверка»,
// structure as a default with skippable sections, adaptive multiple choice).
// `lang` is the Russian language name in the nominative («русский»); templates
// reference it as a label («Язык ответа: русский») to stay case-neutral.

import type { TaskTemplate } from './tasks.en'

export const taskPromptsRu: Record<'solve' | 'quiz' | 'explain' | 'translate' | 'summarize', TaskTemplate> = {
  solve:
    (lang) =>
      'Реши задачу, показанную на изображении.\n\n' +
      'Структура ответа — пропускай секции, которые не применимы:\n' +
      '1) **Ответ:** …\n' +
      '2) **Решение:** по шагам, с выкладками.\n' +
      '3) **Проверка и частые ошибки:** …\n\n' +
      `Язык ответа: ${lang}.`,
  quiz:
    (lang) =>
      'На изображении задание с выбором ответа.\n\n' +
      'Если варианты видны:\n' +
      '1) **Правильный вариант:** …\n' +
      '2) **Почему он верен:** …\n' +
      '3) **Почему остальные не подходят:** кратко по каждому варианту.\n\n' +
      'Если вариантов на изображении нет — реши задание как обычную задачу и скажи, что варианты не видны.\n\n' +
      `Язык ответа: ${lang}.`,
  explain:
    (lang) =>
      'Объясни показанное на изображении так, как объяснил бы ученику.\n' +
      'Начни с сути в одном предложении, затем разбери по шагам; если есть ключевые термины — поясни их в конце. ' +
      'Секции, которые не применимы, пропускай.\n\n' +
      `Язык ответа: ${lang}.`,
  translate:
    (lang) =>
      `Переведи весь текст с изображения. Целевой язык: ${lang}. ` +
      'Если текст уже на этом языке — переведи на английский. ' +
      'Выведи только перевод, не пересказывай оригинал.',
  summarize: (lang) => `Сжато передай суть показанного: 3–5 ключевых тезисов.\nЯзык ответа: ${lang}.`,
}

/** Per-answer "explain simpler" action (not a task button). */
export const simplerRu: TaskTemplate =
  (lang) =>
    'Объясни свой предыдущий ответ проще и короче, с конкретным примером, если он поможет. ' +
    `Язык ответа: ${lang}.`
