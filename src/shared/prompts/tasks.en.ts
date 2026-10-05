// English task templates. A template is a function of the resolved answer
// language name (e.g. "Russian"). Texts here are the CURRENT prompts, moved
// verbatim — content rework happens in dedicated slices (see BACKLOG §5.4).

export type TaskTemplate = (lang: string) => string

export const taskPromptsEn: Record<'solve' | 'quiz' | 'explain' | 'translate' | 'summarize', TaskTemplate> = {
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
export const simplerEn: TaskTemplate =
  (lang) =>
    'Explain your previous answer in simpler terms, more briefly, with a concrete example ' +
    `if helpful. Write in ${lang}.`
