// Russian task templates — the reference dictionary.
//
// For now this mirrors the English templates verbatim: the i18n architecture
// (pick dictionary by answer language) is what this slice delivers. Rewriting
// the texts into native Russian with school conventions («Дано → Решение →
// Ответ») is a dedicated content slice (BACKLOG §5.4, «Локализация промптов»).

import type { TaskTemplate } from './tasks.en'

export const taskPromptsRu: Record<'solve' | 'quiz' | 'explain' | 'translate' | 'summarize', TaskTemplate> = {
  solve:
    (lang) =>
      'Solve the problem shown in the image. Reply in this exact structure:\n' +
      '1) Answer: ...\n2) Steps: ...\n3) Check / common mistakes: ...\n' +
      `Write in ${lang}.`,
  quiz:
    (lang) =>
      'This is a multiple-choice question. Reply in this structure:\n' +
      '1) Correct option: ...\n2) Why it is correct: ...\n3) Why each other option is wrong: ...\n' +
      `Write in ${lang}.`,
  explain:
    (lang) =>
      'Explain what is shown to a student. Reply in this structure:\n' +
      '1) In one sentence: ...\n2) Step by step: ...\n3) Key terms: ...\n' +
      `Write in ${lang}.`,
  translate:
    (lang) =>
      `Translate all the text in the image into ${lang}. If it is already in ${lang}, ` +
      'translate it into English instead. Output the translation only — do not restate ' +
      'the original text.',
  summarize: (lang) => `Summarize what is shown in 3-5 key points.\nWrite in ${lang}.`,
}

/** Per-answer "explain simpler" action (not a task button). */
export const simplerRu: TaskTemplate =
  (lang) =>
    'Explain your previous answer in simpler terms, more briefly, with a concrete example ' +
    `if helpful. Write in ${lang}.`
