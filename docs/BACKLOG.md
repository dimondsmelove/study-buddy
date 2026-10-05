# Study Buddy — backlog & status

Single source of truth for every proposed item and where it stands.
Legend: ✅ done · 🟡 partial · ⬜ not started · ❌ dropped by decision.

_Last updated: 2026-10-05 (after commit `47e4a03`)_

## 1. Study tasks (intents)

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Solve | ✅ | preset, structured answer, verified on real API |
| 2 | Quiz (multiple choice) | ✅ | correct option + why + why others are wrong |
| 3 | Explain | ✅ | one sentence → steps → key terms |
| 4 | Translate | ✅ | translation only, source not repeated |
| 5 | Summarize | ✅ | 3–5 key points |
| 6 | Ask (free-form) | ✅ | text input, full conversation context |
| 7 | Hint / Socratic (no final answer) | ⬜ | proposed; educationally valuable, anti-cheating |
| 8 | Check my work (verify a shown solution) | ⬜ | proposed |
| 9 | Simplify / ELI5 as a task | 🟡 | exists as a follow-up action ("Проще") on an answer, not as a task on the crop |
| 10 | Glossary / key terms | ⬜ | proposed |
| 11 | Read the visual (chart / diagram / table) | ⬜ | proposed |
| 12 | Practice more (similar problems, rising difficulty) | ⬜ | proposed |
| 13 | Flashcards | ⬜ | proposed |
| 14 | Study plan / exam cram | ⬜ | proposed |
| 15 | Teach me (mini-lesson) | ⬜ | proposed |
| 16 | Concept map / diagram | ⬜ | proposed |
| 17 | Essay feedback (by rubric) | ⬜ | proposed |
| 18 | Rewrite / grammar & style | ⬜ | proposed |
| 19 | Vocabulary (words / idioms) | ⬜ | proposed |
| 20 | Outline (essay / answer plan) | ⬜ | proposed |
| 21 | Read aloud (TTS) | ⬜ | proposed, accessibility |
| 22 | History / review mistakes | ⬜ | proposed |
| 23 | Multi-snippet (stack several selections) | ⬜ | proposed |
| 24 | Subject-aware system prompt (math / history / code…) | ⬜ | proposed; intents stay cross-subject |
| 25 | Auto-format detection (MCQ / essay / lab / code / source) | 🟡 | Quiz handles MCQ; no automatic detection/announcement |
| 26 | Task categories (group the buttons) | ⬜ | proposed; needed as the catalog grows |

## 2. Chat panel UX / UI

| # | Item | Status | Notes |
|---|---|---|---|
| 27 | Markdown + LaTeX rendering | ✅ | marked + DOMPurify + KaTeX; verified |
| 28 | Copy / Retry / Explain simpler | ✅ | per-answer actions |
| 29 | New selection button | ✅ | sends START_SELECTION |
| 30 | Loading indicator / skeleton / streaming cursor | 🟡 | plain "…" bubble; no skeleton or cursor animation |
| 31 | Task categories / tabs | ⬜ | depends on #26 |
| 32 | SVG icons | ⬜ | currently text/emoji |
| 33 | Design tokens | 🟡 | CSS variables exist; no full token system |
| 34 | Dark theme | ⬜ |    |
| 35 | Resizable panel + remember size/position | ⬜ | draggable already; size not adjustable |
| 36 | Quick-action toolbar next to the selection | ⬜ | proposed flow improvement |
| 37 | Side panel ("expand to Chrome side panel") | ⬜ | proposed for long sessions/history |
| 38 | Answer history | ⬜ | proposed |
| 39 | First-run hint ("press Ctrl+Shift+Y") | ⬜ | onboarding was removed on purpose; a one-time hint is still missing |
| 40 | Accessibility (keyboard/ARIA pass) | 🟡 | aria-live + native buttons; no full pass |
| 41 | Empty / error states | ✅ | localized |

## 3. Architecture / key / model

| # | Item | Status | Notes |
|---|---|---|---|
| 42 | Gateway seam | ✅ | `src/shared/gateway.ts`; one interface for model calls |
| 43 | Baked key, no onboarding | ✅ | `SB_DEFAULT_API_KEY` at build; works on install |
| 44 | Hosted proxy (subscriptions, quotas) | ⬜ | planned; Gateway seam is ready for it |
| 45 | BYOK override (Advanced) | ✅ | collapsed details in settings |
| 46 | Model locked to DeepSeek + fallback | ✅ | DeepSeek → Gemini Flash Lite → GPT-5 Nano |
| 47 | User-selectable model | ❌ | dropped by decision (baked/shared key) |
| 48 | UI + answer language settings | ✅ | RU/EN UI; Auto/…/answer languages |
| 49 | Key-abuse guardrails (max_tokens, soft rate limits) | ⬜ | needed while the key is baked |

## 4. Reliability / dev tooling

| # | Item | Status | Notes |
|---|---|---|---|
| 50 | Smoke test (`npm run verify`) | ✅ | 16 checks incl. fallback; no key needed |
| 51 | Real-API task quality runner (`npm run quality`) | ✅ | one fixture per task |
| 52 | Model comparison runner (`npm run compare`) | ✅ | mixed tasks/languages |
| 53 | Turnkey manual test (`npm run playtest`) | ✅ | headed browser, key seeded, demo page |
| 54 | Visual review gallery (`npm run review`) | ✅ | real screens; `review/` gitignored |
| 55 | Store screenshot generator (`npm run screenshots`) | ✅ | 4 shots at 1280×800 |

## 5. Store / marketing

| # | Item | Status | Notes |
|---|---|---|---|
| 56 | Listing copy + permission justifications | ✅ | `store/listing.md` |
| 57 | Privacy policy | 🟡 | `store/privacy.md`; needs a public URL and a real contact email |
| 58 | Store screenshots 1280×800 | ✅ | 4 (solve, quiz, translate, settings) |
| 59 | Promo tile 440×280 | ⬜ | optional CWS asset |
| 60 | Final name (check conflicts) | ⬜ | candidates in `store/listing.md`; "Study Buddy" likely taken |
| 61 | CWS form: category, language, privacy URL | ⬜ | manual, needs the policy URL from #57 |
| 62 | Icons 16/32/48/128 | 🟡 | present; may be reworked with the final brand |

## 6. Explicitly out of scope for now (P2)

- Guest mode with a proxy (needs a backend) — superseded by #44.
- Local models (Ollama) — possible later.
- Accounts / payments / sync — after #44.
- Multiple captures, custom saved prompts, right-click "ask about selection" — P1 (some overlap with #23).
