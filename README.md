# Study Buddy

Select a question on your screen, then choose a task or type a question. Approved task instructions are assembled into the canonical backend request. Ask remains free-form, and the selected task, answer language, and saved conversation history stay separate from interface labels.

Select a region (`Ctrl+Shift+Y`) → the chat window appears next to your
selection → pick a task or ask your own question. The answer streams in beside
the page in the answer language selected in Settings. The toolbar icon also starts
region selection; chat
opens after a successful crop and continues the conversation selected for that tab.
Right-click the toolbar icon → **Show history** to return to a saved chat without
selecting another region. Opening History creates no chat and makes no model request.
Inside a chat, **New chat** opens an empty conversation with text input;
**New selection** adds another image message to the current conversation. Each
capture is saved immediately, without starting an answer. Images remain in the
thread and open at full size; there is no permanent upper preview.

**Status: private laptop integration test.** Capture, streaming, Markdown/LaTeX, local History, image messages and visible context exclusions use the Study Buddy backend; only the backend holds the OpenRouter credential and owns the model and limits. Approved task and title instructions are assembled server-side. Ask remains free-form and transcript text remains immutable. The private backend runs on homelab-laptop; public hosting and store publication remain deferred. See the [private backend handoff](docs/backend-deployment.md#private-laptop-integration-test-2026-10-20) for the endpoint, service commands, update steps and acceptance evidence. No provider key or local tokenizer is needed in the browser.

The backend uses Node 22.22.2 and built-in SQLite for operational state, without
cloud chat history. Requests go through the backend using OpenAI GPT-6 Luna via OpenRouter; provider errors are surfaced without switching models.
Implementation and acceptance evidence for this slice are recorded in `ToDo.md`
and the local loop ledger; earlier UI acceptance records remain historical.
Store copy and privacy disclosures in `store/` are drafts until actual hosting,
contact and audience decisions are complete.

Manual use:

```
Ctrl+Shift+Y or left-click toolbar icon  →  drag a box around a question  →  Solve / Hint / Check  →  read
Right-click toolbar icon  →  Show history  →  choose a saved chat  →  continue
New selection inside a chat  →  add another image message  →  ask about both
New chat  →  empty conversation  →  type a question or select an image
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
- Language/panel settings and the anonymous backend access session live in
  `chrome.storage.local`; the OpenRouter key stays on the backend. The last
  eight transient crops live in `chrome.storage.session`; saved transcripts and
  image Blobs live in extension-origin IndexedDB. History keeps at most 20 chats,
  ordered by their latest non-capture message (creation for empty chats);
  viewing or capturing alone does not promote recency. Older chats are
  automatically deleted, including existing history when the worker starts.
- After Close, the icon’s **Show history** menu opens the saved list; choose a
  chat to restore its transcript and images. A new capture after Close starts a
  fresh chat. History reuses an open or minimized panel and falls back to a
  detached window on privileged pages, without asking for capture permission.
- History shows a topic title and a short date/time, with a delete icon in the
  same row and an in-app confirmation dialog. Shared images remain while any
  retained conversation references them. Copy unsaved text before leaving.
- New-topic title generation from model responses is currently disabled. Existing saved titles and transcript content remain unchanged.
- Minimize keeps the iframe/stream alive. Close saves and cancels; navigation
  or writer loss retains the latest committed partial as interrupted, without
  automatic paid resume. One local generation is admitted across windows.
- Context selection estimates one text token per four UTF-8 bytes under a nominal
  200,000 estimated input-token budget with 20,000 held in reserve. It includes
  selected transcript text and a 1,024-token estimate per image; task templates are currently empty.
  Whole older task groups are excluded first; the transcript stays saved locally.
  Excluded messages remain muted with a reuse action. Only the selected context is
  transmitted. The backend independently validates its canonical request with
  the same estimator; there is no model tokenizer or provider-exact guarantee.
- Each image is limited to 4 MiB decoded; the HTTP payload limit is 32 MiB.
  Server validation accepts inline PNG/JPEG/WebP with bounded dimensions, without
  downloading arbitrary image URLs. Oversized active context is refused and the
  draft stays available.
- Provider-reported usage is saved on the local assistant turn when available.
  A lost final usage chunk means unknown usage. The server does not keep detailed
  per-chat usage or conversation text/images/responses.
- The backend admits one start per installation per ten seconds, one in flight
  per installation, and four globally; issuance of new installations is limited
  per network. It owns a shared 16,384-token response cap and timeout. Provider
  availability errors surface without switching models. Duplicate request IDs
  do not restart a generation within the 24-hour idempotency window.
  Each installation has a $5 monthly budget and this backend has a $100 monthly
  aggregate cap; each new generation reserves $0.275. These limits cover this
  service only and do not cap other OpenRouter account usage.
- Incognito is disabled. There is no cloud sync, telemetry or student profiling.

## Develop and run

Use Node **22.22.2** (`.nvmrc`), including for the built-in experimental
`node:sqlite` backend API. Its startup warning is expected.

```sh
npm ci
npm run typecheck
npm run typecheck:backend
npm run contracts
npm run contracts:storage
npm run contracts:prompts
npm run contracts:context
npm run contracts:backend       # real HTTP/SQLite boundary, fake upstream only
npm run backend:build
npm run build                  # public client; no provider key build variable
npm run verify                 # isolated Chromium -> backend -> fake provider
```

For a real backend, copy `.env.backend.example` to ignored `.env.backend`, fill
runtime secrets and the exact extension-origin allowlist, then:

```sh
node --env-file=.env.backend .backend-dist/server.js
```

Backend configuration, stop/health, single-instance hosting, proxy requirements,
backup and rollback are documented in [backend operation](docs/backend-deployment.md)
and [the backend README](src/backend/README.md). The default bind is loopback;
this does not publish a service. Never place `OPENROUTER_API_KEY` in client/Vite
variables or the extension bundle.

The client defaults to `http://127.0.0.1:8787`. Choose another backend at build time:

```sh
STUDY_BUDDY_GATEWAY_URL=https://api.example.invalid npm run build
```

Use the actual HTTPS service URL for public distribution. The generated manifest
grants access to that gateway host; the backend allowlist must use the actual
extension ID. The ordinary settings form retains language choices, with no
provider key entry.

For a safe local demonstration with a real backend and fake upstream:

```sh
npm run preview:local
npm run preview:local -- health
npm run preview:local -- stop
```

The preview owns a separate Chromium profile and database, uses synthetic page
content and makes no external model calls. `-- start --headless` is available
for background checks. Closing or stopping it does not touch Vivaldi.
Verification builds to `review/verify-dist/`; each preview builds under its own
`review/preview/run-*/dist/`. Both leave the normal `dist/` build intact.

Older real-provider quality/compare/review scripts are historical tools. They
are not part of this gateway acceptance and their reports are not fresh evidence.
Store screenshots are historical until regenerated for the final release.

To load a build manually in a separate browser: open `chrome://extensions`,
enable Developer mode, choose Load unpacked and select `dist/`. Work on this
candidate does not change the user's existing Vivaldi installation.

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
