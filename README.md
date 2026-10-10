# Study Buddy

Select any question on your screen and get a step-by-step answer in English
by default. Built for studying — hint, check an attempt, solve, quiz, explain,
translate, summarize.

Select a region (`Ctrl+Shift+Y`) → the chat window appears next to your
selection → pick a task or ask your own question. The answer streams in beside
the page, in English by default. The toolbar icon also starts region selection; chat
opens after a successful crop and continues the conversation selected for that tab.

**Status: MVP.** Region selection → screenshot → crop → chat window,
English interface and answer defaults, task-shaped answers
(Hint / Check / Solve / Quiz / Explain / Translate / Summarize + free-form Ask), Markdown +
LaTeX rendering, per-answer copy / explain simpler / retry, and an automatic
model fallback, compact local history/delete and minimize/reopen work against
local mock fixtures. One real-provider Solve fixture passed (84 km/h and a
clean topic title); broader tutor response quality has not been re-evaluated.
TD-06 hosted backend remains deferred; the direct-provider path is development-only, not a secured public distribution mode.
This loop's acceptance build is keyless. The settings gear is commented out;
retained language settings contain no connection fields. The direct-provider
connection is provided by the development runtime and is not a user setup flow. That runtime
still stores its connection locally on the device. All model calls go through
the `Gateway` seam (`src/shared/gateway.ts`) — currently a direct provider, later
your hosted proxy for subscriptions. The answering model is fixed to DeepSeek
(`src/shared/ai.ts`). Store copy, privacy policy, and screenshots live in `store/`.

Manual use:

```
Ctrl+Shift+Y or toolbar icon  →  drag a box around a question  →  Solve / Quiz / …  →  read
```

## Roadmap

Ближайшие задачи и открытые продуктовые решения описаны в [`ToDo.md`](ToDo.md). [`BACKLOG.md`](BACKLOG.md) хранит историю реализации, заметки исследований и отложенные идеи.

## Architecture at a glance

```
content overlay (drag-select a region)
      │  rect + devicePixelRatio
      ▼
service worker  (coordinator only — no DOM, no model)
      │  captureVisibleTab → crop on an OffscreenCanvas → chrome.storage.session
      ▼
chat window  (extension-page iframe in a closed shadow root, near the selection,
              draggable — or a detached popup window when no host access)
```

- The service worker only coordinates (MV3 workers are ephemeral and have no DOM).
- Capture uses `chrome.tabs.captureVisibleTab` — clean composited pixels, taint-free
  even over cross-origin `<video>` (e.g. code shown in a paused video).
- No declared content script: the overlay is injected on demand (`activeTab`),
  so there is no "read and change all your data" install warning.
- The chat window lives in a **closed shadow root**, so page styles can't leak in
  and ours can't leak out.
- The API key, settings and panel size live in `chrome.storage.local`. The last
  eight transient crops live in `chrome.storage.session`; saved transcripts and
  image Blobs live in extension-origin IndexedDB. History keeps at most 20 chats,
  ordered by their latest message (creation for empty chats); older chats are
  automatically deleted, including existing history when the worker starts.
- History shows a topic title and a short date/time, with a delete icon in the
  same row and an in-app confirmation dialog. Shared images remain while any
  retained conversation references them. Copy unsaved text before leaving.
- New topics are generated with the first answer, without a separate request;
  existing chats use readable stored content as a fallback. Topic metadata is
  separate from answer text and provider conversation context.
- Minimize keeps the iframe/stream alive. Close saves and cancels; navigation
  or writer loss retains the latest committed partial as interrupted, without
  automatic paid resume. One local generation is admitted across windows.
- Provider context is at most 12 turns, 32,000 text characters and two images
  of at most 4 MiB each. The current task/attempt/input are retained; oversized
  required input is refused before network. Omitted/incomplete history stays
  saved locally; no automatic summary is created.
- The ten-second start interval is local UX only, not trusted abuse protection
  or a unique-user guarantee. Regenerate is a new start; explicit availability
  fallback before any output is part of the existing start.
- Incognito is disabled. There is no cloud sync, telemetry or student profiling.

## Develop

```
npm install
npm run dev        # Vite + CRXJS with HMR
SB_DEFAULT_API_KEY= npm run build  # keyless production acceptance build → dist/
npm run typecheck
npm run contracts          # settings + SSE/JSON/fallback fixtures, synthetic fetch
npm run contracts:storage  # real IndexedDB, rollback/recovery/GC/context/rate
npm run contracts:prompts  # EN/RU Hint/Check templates; no real model
npm run verify     # smoke test: load dist/ in Chromium, select, capture, chat,
                   # AI answer (mock SSE endpoint) — no API key needed

# safe local acceptance browser + gallery, no credentials or external model calls:
SB_DEFAULT_API_KEY= npm run build
npm run preview:local                  # headed isolated Chromium, localhost:4187
npm run preview:local -- health
npm run preview:local -- stop
# -- start --headless is available for automated checks.
# Each start has its own profile under review/preview; stop does not delete it.
# review/loop contains the actual verify screenshots. Run verify to regenerate.

# manual real-provider test (demo page opens; no request is sent until you start a task):
npm run playtest
#   The development runtime reads OpenRouter credentials from
#   ~/.config/study-buddy/credentials.json or OPENROUTER_API_KEY.
#   OPENROUTER_API_KEY overrides the default OpenRouter connection. A saved
#   custom provider, endpoint, and key stay paired and are preserved.
#   These local dev credentials are stored on-device and never shown in the
#   interface. The settings gear is hidden; the language form is retained.
#   The dedicated ~/.config/study-buddy/playtest-profile persists settings and
#   History across restarts; PLAYTEST_PROFILE can point to an isolated QA profile.
#   New profiles default to English; saved language choices survive restarts.
#   PLAYTEST_UI_LANGUAGE=en PLAYTEST_ANSWER_LANGUAGE=en npm run playtest
#   explicitly switches an existing test profile while preserving its connection.

# task quality: drive the real UI against the real API, one fixture per task:
npm run quality

# compare answer quality across models on mixed tasks/languages:
npm run compare                # or: node scripts/compare.mjs model-a model-b

# regenerate Chrome Web Store screenshots → store/screenshots/:
npm run screenshots

# load the unpacked extension in your own browser:
#   chrome://extensions → Developer mode → Load unpacked → select dist/
```

The legacy real-provider commands above were not run for this local acceptance.
In particular, `quality` and `review` predate saved conversations and the start
interval: their multi-fixture drivers need explicit conversation isolation and
cooldown handling before their reports can be treated as fresh evidence.
Store screenshots remain historical; the verified current UI is in `review/loop`.

## Store

Submission copy, permission justifications, and the privacy policy are in
`store/` (`listing.md`, `privacy.md`); screenshots in `store/screenshots/`.
The working name "Study Buddy" is likely taken — alternatives and a checklist
are in `store/listing.md`.

## Provenance

Forked from [OCR Buddy](https://github.com/Fanfulla/OCR-buddy) (MIT) — its
battle-tested capture core (selection overlay, `captureVisibleTab` guard, MV3
service-worker coordination, per-site permission flow) is retained nearly
verbatim; its fully-local OCR engine was removed in favour of vision LLMs.
See `LICENSE` and OCR Buddy's repository for the upstream work.
