# Chrome Web Store listing (draft)

> Local client wording reconciled on 2026-10-10; **not ready for submission**.
> Public gateway/budget controls, support contact/privacy URL and real AI quality
> remain open. Existing store screenshots predate the local-dialog UI.

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

1. `Select a task, ask for a hint or check your attempt. Your latest 20 chats stay on this device. No account.`
2. `Snip a question for hints, checking, solving or translation. English by default. Your latest 20 chats stay local.`

## Detailed description

**Snip a question. Get the answer, step by step — right where you are.**

Study Buddy turns any part of your screen into a study tutor. Drag a box around
a problem, a quiz, a diagram, or a passage, and get a clear, structured answer
beside your selection — without switching tabs or copy-pasting into a chat.

**Built for studying, not just "asking AI".**

- **Solve** — a worked answer: final result, the steps, and the common mistakes to watch for.
- **Hint** — a prompt for one next step, rather than an immediate full solution.
- **Check my attempt** — enter your multiline work and request the first substantive error plus a correcting hint.
- **Quiz** — the correct option, why it's correct, and why the other options are wrong.
- **Explain** — the gist in one sentence, then step by step, then the key terms.
- **Translate** — translate selected text into English by default; a typed question can explicitly request another language.
- **Summarize** — the 3–5 key points.
- **Ask** — anything else, in your own words.

**English by default.** The interface and answer language default to English.
Previously saved language choices remain available in private development
profiles; the settings gear is currently hidden.

**Local dialogs, no account or analytics.** Text and selected images are saved
on the device for up to 20 chats, ordered by the latest message. Older chats
are automatically deleted; History provides topic titles, readable times and
manual deletion. Questions,
attempts, instructions and bounded prior context are sent directly to your
configured provider. The private development launcher supplies the connection;
the ordinary interface does not ask for or expose a provider key. A public
shared-key release still requires the deferred hosted gateway.

**Study alongside web content.** Select a region on a supported regular web
page. Compatibility with individual learning platforms and PDF viewers has not
been re-evaluated in this loop. Privileged pages cannot be captured.

**Visible response boundaries.** A vision model answers by default. Explicit
availability failures before output can use another model. Length limits,
interruption, cancellation and provider errors remain visible; ambiguous or
partial failures do not silently restart a model operation.

**How to start**

1. Add the extension and pin it.
2. Press **Ctrl+Shift+Y**, drag a box around a question. The toolbar icon also starts selection.
3. Pick an action — or type your own question.

Minimize keeps an answer running; Close saves and cancels. Saved history is
separate from the bounded provider context. Model accuracy is not guaranteed;
the new Hint/Check contracts have been verified with fixtures, not real AI.

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
- `storage` — keep settings/key/panel size locally and transient crops in session;
  saved transcripts and images use extension-origin IndexedDB.
- optional `host_permissions <all_urls>` — requested per site only when a capture
  needs a tab the user didn't invoke on; the screenshot stays gated per origin.
- `commands` — the `Ctrl+Shift+Y`/`Cmd+Shift+Y` shortcut to start a selection.
