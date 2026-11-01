// Preview-only recognition of the canonical Hint/Check instructions sent by the backend.
export function classifyPreviewTask(messages, prompts) {
  const content = messages?.at(-1)?.content
  const text = typeof content === 'string'
    ? content
    : content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
  const context = { answerLanguage: 'en', browserLanguage: 'en', uiLang: 'en' }
  for (const kind of ['hint', 'check']) {
    const instruction = prompts.taskPrompt(kind, context)
    if (text === instruction || text.startsWith(instruction + '\n\n')) return kind
  }
  return 'solve'
}
