# Study Buddy

Select any region of the screen and ask an AI about it — solve, explain, translate.

Select a region (icon or `Ctrl+Shift+Y`) → the chat window appears next to your
selection → ask a question about what's on screen: get homework solved, a
step-by-step explanation, a translation, or just "what is this?" for any picture.

**Status: capture pipeline + AI answering work end to end.** Region selection →
screenshot → crop → chat window, connection settings (provider / base URL /
API key), and streaming answers (Solve / Explain / Translate presets plus
free-form questions) all function. The answering model is fixed to DeepSeek
(see `src/shared/ai.ts`) with an automatic fallback chain — not user-selectable
yet. Answers follow the question's language; presets use the browser language.

## Architecture

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

## Develop

```
npm install
npm run dev        # Vite + CRXJS with HMR
npm run build      # production build → dist/
npm run typecheck
npm run verify     # smoke test: load dist/ in Chromium, select, capture, chat,
                   # AI answer (mock SSE endpoint) — no API key needed

# manual test in a ready browser (key pre-seeded, demo page opens):
npm run playtest
#   the OpenRouter key is read from ~/.config/study-buddy/credentials.json
#   (or OPENROUTER_API_KEY); it is never written into the repo

# compare answer quality across models on mixed tasks/languages:
npm run compare                # or: node scripts/compare.mjs model-a model-b

# load the unpacked extension in your own browser:
#   chrome://extensions → Developer mode → Load unpacked → select dist/
```

## Provenance

Forked from [OCR Buddy](https://github.com/Fanfulla/OCR-buddy) (MIT) — its
battle-tested capture core (selection overlay, `captureVisibleTab` guard, MV3
service-worker coordination, per-site permission flow) is retained nearly
verbatim; its fully-local OCR engine was removed in favour of vision LLMs.
See `LICENSE` and OCR Buddy's repository for the upstream work.
