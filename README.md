# Study Buddy

Select any question on your screen and get a step-by-step answer in your
language. Built for studying — solve, quiz, explain, translate, summarize.

Select a region (icon or `Ctrl+Shift+Y`) → the chat window appears next to your
selection → pick a task or ask your own question. The answer streams in beside
the page, in your language.

**Status: MVP.** Region selection → screenshot → crop → chat window,
interface + answer language settings (English / Russian), task-shaped answers
(Solve / Quiz / Explain / Translate / Summarize + free-form Ask), Markdown +
LaTeX rendering, per-answer copy / explain simpler / retry, and an automatic
model fallback all work. There is **no onboarding**: a store build bakes an API
key so it works on install (see `src/shared/config.ts`). All model calls go
through the `Gateway` seam (`src/shared/gateway.ts`) — currently a direct
provider, later your hosted proxy for subscriptions. The answering model is
fixed to DeepSeek (`src/shared/ai.ts`). Store copy, privacy policy, and
screenshots live in `store/`.

Manual use:

```
Ctrl+Shift+Y  →  drag a box around a question  →  Solve / Quiz / …  →  read
```

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
- The API key and settings live in `chrome.storage.local`; the transient crop
  lives in RAM-only `chrome.storage.session`.

## Develop

```
npm install
npm run dev        # Vite + CRXJS with HMR
npm run build      # production build → dist/ (set SB_DEFAULT_API_KEY to bake a key)
# store build:  SB_DEFAULT_API_KEY=sk-or-... npm run build
npm run typecheck
npm run verify     # smoke test: load dist/ in Chromium, select, capture, chat,
                   # AI answer (mock SSE endpoint) — no API key needed

# manual test in a ready browser (key pre-seeded, demo page opens):
npm run playtest
#   the OpenRouter key is read from ~/.config/study-buddy/credentials.json
#   (or OPENROUTER_API_KEY); it is never written into the repo

# task quality: drive the real UI against the real API, one fixture per task:
npm run quality

# compare answer quality across models on mixed tasks/languages:
npm run compare                # or: node scripts/compare.mjs model-a model-b

# regenerate Chrome Web Store screenshots → store/screenshots/:
npm run screenshots

# load the unpacked extension in your own browser:
#   chrome://extensions → Developer mode → Load unpacked → select dist/
```

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
