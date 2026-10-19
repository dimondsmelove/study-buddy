// Empty task template seams. Replacement text requires separate approval.
export type TaskTemplate = (lang: string) => string

export const taskPromptsEn: Record<'solve' | 'quiz' | 'explain' | 'translate' | 'summarize' | 'hint', TaskTemplate> = {
  solve: () => '',
  quiz: () => '',
  explain: () => '',
  translate: () => '',
  summarize: () => '',
  hint: () => '',
}

export const checkEn = (attempt: string | undefined, _lang: string): string => attempt ?? ''

export const simplerEn: TaskTemplate = () => ''
