# Chrome Web Store listing (draft)

> Chrome Web Store copy limits: **name ≤ 45 chars**, **short description ≤ 132
> chars**, detailed description ≤ 16 000 chars. Screenshots 1280×800 (in
> `store/screenshots/`). Keep the short description inside the limit.

## Name

Working name: **Study Buddy** — likely taken/generic. Candidates (check for
conflicts before submitting):

- **SnipTutor** — snip + tutor, study-named, short.
- **RegionSolve** — describes the core action.
- **StudySnip** — study + the snipping gesture.
- **SelectSolve** — verb-forward and unique.
- **AskTheScreen** — memorable, broad.

## Short description (≤ 132 chars)

Pick one:

1. `Select any question on screen, get a step-by-step answer in your language. No account, works instantly.`
2. `Snip a question, get it solved step by step — math, quizzes, code, translation. No account, no setup.`

## Detailed description

**Snip a question. Get the answer, step by step — right where you are.**

Study Buddy turns any part of your screen into a study tutor. Drag a box around
a problem, a quiz, a diagram, or a passage, and get a clear, structured answer
beside your selection — without switching tabs or copy-pasting into a chat.

**Built for studying, not just "asking AI".**

- **Solve** — a worked answer: final result, the steps, and the common mistakes to watch for.
- **Quiz** — the correct option, why it's correct, and why the other options are wrong.
- **Explain** — the gist in one sentence, then step by step, then the key terms.
- **Translate** — turn any text in the selection into your language.
- **Summarize** — the 3–5 key points.
- **Ask** — anything else, in your own words.

**Your language.** Answers follow the language you write in; the interface and
the preset actions can be set to English or Russian.

**Works on install. Private by design.** No account, no setup, no analytics —
add it and start selecting. Only the region you select is ever sent, directly
from your browser to the model provider; the rest of the page never leaves your
browser. (Advanced users can point it at their own key.)

**Works where you study.** Canvas, Blackboard, Moodle, Google Classroom, PDFs
opened in the browser, image-based questions — anywhere you can see it, you can
select it. Chrome's own pages and the Web Store can't be captured by any
extension.

**Reliable by design.** A vision model answers by default, with an automatic
fallback to a second model if it is unavailable, so a momentary outage doesn't
stop your study session.

**How to start**

1. Add the extension and pin it.
2. Press **Ctrl+Shift+Y** (or click the icon), drag a box around a question.
3. Pick an action — or type your own question.

No account and no key to configure: it works the moment it is installed.

## Category & metadata

- **Category:** Education (fallback: Productivity).
- **Languages:** English, Russian.
- **Motto / tagline:** “Select. Solve. Understand.”

## Assets checklist

- [x] Icons 16/32/48/128 (`icons/`)
- [x] Screenshots 1280×800 (`store/screenshots/`, regenerate with `npm run screenshots`)
- [ ] Small promo tile 440×280 (optional)
- [ ] Store category, language, and privacy-policy URL
- [ ] Privacy policy published (see `store/privacy.md`); paste it into the CWS privacy tab
- [ ] Justify each permission in the CWS form (`activeTab`, `scripting`, `storage`, optional `<all_urls>`)

## Permission justifications (for the CWS form)

- `activeTab` — capture the visible tab only after the user asks for a selection.
- `scripting` — inject the on-demand selection overlay (no declared content script).
- `storage` — keep the API key (local) and the transient crop (session, RAM only).
- optional `host_permissions <all_urls>` — requested per site only when a capture
  needs a tab the user didn't invoke on; the screenshot stays gated per origin.
- `commands` — the `Ctrl+Shift+Y`/`Cmd+Shift+Y` shortcut to start a selection.
