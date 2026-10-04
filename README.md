# Study Buddy

Select any region of the screen and ask an AI about it — solve, explain, translate.

Select a region (icon or `Ctrl+Shift+Y`) → the chat window appears next to your
selection → ask a question about what's on screen: get homework solved, a
step-by-step explanation, a translation, or just "what is this?" for any picture.

**Status: Phase 0 skeleton.** The capture pipeline (region selection →
screenshot → crop → chat window) works end to end. AI answering lands next.

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
npm run verify     # smoke test: load dist/ in Chromium, select, capture, chat

# load the unpacked extension:
#   chrome://extensions → Developer mode → Load unpacked → select dist/
```

## Provenance

Forked from [OCR Buddy](https://github.com/Fanfulla/OCR-buddy) (MIT) — its
battle-tested capture core (selection overlay, `captureVisibleTab` guard, MV3
service-worker coordination, per-site permission flow) is retained nearly
verbatim; its fully-local OCR engine was removed in favour of vision LLMs.
See `LICENSE` and OCR Buddy's repository for the upstream work.
