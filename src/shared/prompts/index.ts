// One place for EVERY text that goes to the model, and for the per-turn
// request parameters. Changing prompts is editing data here — never logic
// (BACKLOG §5). The dictionaries are picked by the RESOLVED answer language:
// Russian answers get the RU templates, everything else the EN ones (for now
// the two coincide; the RU rewrite is a separate content slice).

import type { AnswerLanguage } from '../settings'
import { PROMPT_LANGUAGE_NAMES, RU_LANGUAGE_NAMES } from '../i18n'
import { buildSystemPrompt, buildSystemPromptRu } from './system'
import { checkEn, simplerEn, taskPromptsEn } from './tasks.en'
import { checkRu, simplerRu, taskPromptsRu } from './tasks.ru'

/** Bump on any prompt-text or parameter change; logged/verifiable. */
export const PROMPTS_VERSION = '2026-10-07.1'

export type TaskId = 'solve' | 'quiz' | 'explain' | 'translate' | 'summarize' | 'hint'
/** Everything that starts a turn: a task button, a free question, "simpler", or checking an attempt. */
export type TurnKind = TaskId | 'ask' | 'simpler' | 'check'

export interface PromptContext {
  answerLanguage: AnswerLanguage
  /** Already resolved ('auto' collapsed by the caller). */
  uiLang: 'en' | 'ru'
}

/** English name of the language the model is told to answer in. With `auto`
 *  the fixed actions fall back to the UI language. */
export function targetLanguageName(ctx: PromptContext): string {
  if (ctx.answerLanguage !== 'auto') return PROMPT_LANGUAGE_NAMES[ctx.answerLanguage]
  return ctx.uiLang === 'ru' ? 'Russian' : 'English'
}

/** Russian name (nominative) for the same — used by the native RU templates. */
function ruLanguageName(ctx: PromptContext): string {
  if (ctx.answerLanguage !== 'auto') return RU_LANGUAGE_NAMES[ctx.answerLanguage]
  return 'русский'
}

function isRussian(ctx: PromptContext): boolean {
  return ctx.answerLanguage === 'auto' ? ctx.uiLang === 'ru' : ctx.answerLanguage === 'ru'
}

export function systemPrompt(ctx: PromptContext): string {
  return isRussian(ctx)
    ? buildSystemPromptRu(ruLanguageName(ctx), ctx.answerLanguage !== 'auto')
    : buildSystemPrompt(targetLanguageName(ctx), ctx.answerLanguage !== 'auto')
}

export function taskPrompt(task: TaskId, ctx: PromptContext): string {
  return isRussian(ctx)
    ? taskPromptsRu[task](ruLanguageName(ctx))
    : taskPromptsEn[task](targetLanguageName(ctx))
}

export function checkPrompt(attempt: string, ctx: PromptContext): string {
  if (!attempt.trim()) throw new Error('Enter a student attempt to check.')
  return isRussian(ctx)
    ? checkRu(attempt, ruLanguageName(ctx))
    : checkEn(attempt, targetLanguageName(ctx))
}

export function simplerPrompt(ctx: PromptContext): string {
  return isRussian(ctx)
    ? simplerRu(ruLanguageName(ctx))
    : simplerEn(targetLanguageName(ctx))
}

/** temperature / max_tokens per turn. Factual tasks run deterministic;
 *  max_tokens is a hard cutoff, not a length target. */
const TURN_PARAMS: Record<TurnKind, { temperature: number; maxTokens: number }> = {
  solve: { temperature: 0, maxTokens: 2048 },
  quiz: { temperature: 0, maxTokens: 1536 },
  translate: { temperature: 0, maxTokens: 2048 },
  explain: { temperature: 0.3, maxTokens: 2048 },
  summarize: { temperature: 0.3, maxTokens: 1024 },
  hint: { temperature: 0.3, maxTokens: 512 },
  check: { temperature: 0, maxTokens: 1024 },
  ask: { temperature: 0.3, maxTokens: 2048 },
  simpler: { temperature: 0.3, maxTokens: 1536 },
}

export function turnParams(kind: TurnKind): { temperature: number; maxTokens: number } {
  return TURN_PARAMS[kind]
}
