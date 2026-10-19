// Compatibility seams for task IDs and per-turn request parameters.
// Runtime instruction text remains empty until separately approved.

import type { AnswerLanguage } from '../settings'

/** Bump on any prompt-text or parameter change; logged/verifiable. */
export const PROMPTS_VERSION = '2026-10-19.2'

export type TaskId = 'solve' | 'quiz' | 'explain' | 'translate' | 'summarize' | 'hint'
/** Everything that starts a turn: a task button, a free question, "simpler", or checking an attempt. */
export type TurnKind = TaskId | 'ask' | 'simpler' | 'check'

export interface PromptContext {
  answerLanguage: AnswerLanguage
  /** Already resolved ('auto' collapsed by the caller). */
  uiLang: 'en' | 'ru'
}

export function systemPrompt(_ctx: PromptContext): string {
  return ''
}

export function firstAnswerTitleInstruction(_ctx: PromptContext): string {
  return ''
}

export function taskPrompt(_task: TaskId, _ctx: PromptContext): string {
  return ''
}

export function checkPrompt(attempt: string | undefined, _ctx: PromptContext): string {
  return attempt ?? ''
}

export function simplerPrompt(_ctx: PromptContext): string {
  return ''
}

/** Luna uses provider-default sampling and the same response cap for every turn. */
const TURN_PARAMS: Record<TurnKind, { maxTokens: number }> = {
  solve: { maxTokens: 16_384 },
  quiz: { maxTokens: 16_384 },
  translate: { maxTokens: 16_384 },
  explain: { maxTokens: 16_384 },
  summarize: { maxTokens: 16_384 },
  hint: { maxTokens: 16_384 },
  check: { maxTokens: 16_384 },
  ask: { maxTokens: 16_384 },
  simpler: { maxTokens: 16_384 },
}

export function turnParams(kind: TurnKind): { maxTokens: number } {
  return TURN_PARAMS[kind]
}
