// Classify only the actions with specialized preview answers. Canonical prompt
// builders keep detection aligned with EN/RU text without matching incidental
// words inside instructions such as Solve's “Check / common mistakes” heading.
export function classifyPreviewTask(messages, prompts) {
  const content = messages?.at(-1)?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter(part => part?.type === 'text').map(part => part.text).join('')
      : ''
  const contexts = [
    { answerLanguage: 'auto', uiLang: 'en' },
    { answerLanguage: 'auto', uiLang: 'ru' },
  ]
  for (const context of contexts) {
    const prefix = prompt => prompt.split(/\r?\n/, 1)[0]
    if (text.startsWith(prefix(prompts.checkPrompt(undefined, context)))) return 'check'
    if (text.startsWith(prefix(prompts.taskPrompt('hint', context)))) return 'hint'
  }
  return 'solve'
}
