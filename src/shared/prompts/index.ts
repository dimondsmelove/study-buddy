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
export const PROMPTS_VERSION = '2026-10-19.1'

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

export function firstAnswerTitleInstruction(ctx: PromptContext): string {
  return isRussian(ctx)
    ? 'Перед ответом выведи первую строку строго в формате [[STUDY_BUDDY_TITLE]]Краткая тема. Название — короткое, по сути задания, не более 80 символов. Затем на следующей строке дай обычный ответ. Не добавляй пояснений к метаданным.'
    : 'Before the answer, emit a first line exactly as [[STUDY_BUDDY_TITLE]]Short topic title. Keep the title concise and specific to the task, at most 80 characters. Then give the normal answer on the next line. Do not explain the metadata.'
}

export function taskPrompt(task: TaskId, ctx: PromptContext): string {
  return isRussian(ctx)
    ? taskPromptsRu[task](ruLanguageName(ctx))
    : taskPromptsEn[task](targetLanguageName(ctx))
}

export function checkPrompt(attempt: string | undefined, ctx: PromptContext): string {
  return isRussian(ctx)
    ? checkRu(attempt, ruLanguageName(ctx))
    : checkEn(attempt, targetLanguageName(ctx))
}

export function simplerPrompt(ctx: PromptContext): string {
  return isRussian(ctx)
    ? simplerRu(ruLanguageName(ctx))
    : simplerEn(targetLanguageName(ctx))
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
