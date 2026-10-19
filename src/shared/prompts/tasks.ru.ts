// Empty task template seams. Replacement text requires separate approval.
import type { TaskTemplate } from './tasks.en'

export const taskPromptsRu: Record<'solve' | 'quiz' | 'explain' | 'translate' | 'summarize' | 'hint', TaskTemplate> = {
  solve: () => '',
  quiz: () => '',
  explain: () => '',
  translate: () => '',
  summarize: () => '',
  hint: () => '',
}

export const checkRu = (attempt: string | undefined, _lang: string): string => attempt ?? ''

export const simplerRu: TaskTemplate = () => ''
