# Current validated state — 2026-11-01

Read this file before using dated task, release or deployment notes. `FACT` describes checks performed on this date; `DECISION` describes an explicit user constraint; `OPEN` describes remaining work.

## Validated implementation and artifacts

- **FACT — frontend reference:** `/home/diamondsepticon/Projects/OCR-AI/study-buddy/dist`, extension version **0.1.1**, compiled gateway `https://api.studybuddyai.one`. A fresh production-URL build from the current sources after `npm ci` matches **all 123 files byte for byte**. Aggregate SHA-256: `6539ec8c2bfa93e431bf7f7d51c439ee9b016c0f1c11c5c696a669393cbd1c41` (SHA-256 of compact JSON mapping sorted relative filenames to their SHA-256).
- **FACT — deployed backend:** container `study-buddy-backend-1` on `diamondserver`, image `study-buddy/backend:release-20261029`, image ID `sha256:17a983f38eb847514aab15c695431b0d77845c0187f9fac025288904be0c1809`. Container health is healthy; its internal `/health` returns HTTP 200 and `{"ok":true}`.
- **FACT — backend bundle:** `/app/.backend-dist/server.js`, 82,559 bytes, SHA-256 `e9c562e08b696a11c71de90ca61b25441503db0ac1f574425461cd012112f26a`. Building the current backend/shared sources with the exact Dockerfile COPY inputs reproduces these bytes. Runtime package metadata says 0.1.0; this is separate from extension version 0.1.1.
- **FACT — build distinction:** Docker does not copy the root `tsconfig.json`. A normal laptop backend build therefore adds an uninitialized `db` class-field declaration; the Docker-context build matches the running service exactly. Do not mistake that compiler-output difference for different backend business logic.
- **FACT — source location:** this repository is the source for publication. The server's `~/apps/study-buddy` backend/shared sources match, but its frontend is older; do not replace the laptop frontend with that server copy.
- **DECISION — no tokenizer. FACT:** none in current application sources, lockfile, frontend artifact or backend bundle. Context estimation is `ceil(UTF-8 bytes / 4)`, with image/framing estimates and headroom. A stale extraneous tokenizer package in the laptop node_modules was removed by installing the exact lockfile.
- **FACT — model and limits:** the code configures `anthropic/claude-haiku-5.5`, no alternate model, 8,192 output tokens; 100,000 estimated input tokens with 20,000 headroom. No live model-quality claim follows from the mock checks.

## Rendered frontend acceptance

The actual reference `dist` was loaded unchanged in an isolated Chromium 148.0.7778.96 profile. Its compiled HTTPS gateway was redirected only inside that test browser to a loopback TLS relay, real local backend and deterministic upstream fixture. No production generation was requested.

Passed: toolbar-triggered region capture; visible incremental answer; completion; reload restoration without another upstream request; answer-language picker; history; minimize/restore; Close preserving the saved conversation; six task controls and visible composer at 320 × 568 without horizontal overflow. Page errors: **0**. The full-page screenshot uses 1200 × 800.

Evidence: [record and artifact hashes](docs/validation/runtime-2026-11-01.json), [full view](docs/images/demo.png), [narrow view](docs/images/narrow.png).

## Which context to trust

| Source | Status |
| --- | --- |
| `src/`, pinned toolchain, `package-lock.json`, build configurations | Current implementation; reproduced against the reference artifacts above |
| `README.md`, `docs/architecture.md`, `docs/demo.md`, `src/backend/README.md` | Current setup and engineering guides |
| `docs/prompts-review-stage4.md` | Approved instruction text, checked by prompt contracts |
| `PRODUCT.md` | Product intent and constraints; implementation facts belong here and in code |
| `ToDo.md`, `BACKLOG.md`, `docs/study-buddy-direction.md`, dated research/deployment notes | Historical ledgers; their dated FACT/status sections are not current runtime assertions |
| `scripts/archive/*.txt` | Retired harness source, not runnable acceptance or live-provider tooling |
| `store/` | Draft store materials and historical store screenshots; not current release acceptance |

`npm run verify` now uses the maintained capture/backend/SSE/UI scenario. `npm run playtest` opens the isolated preview. `npm run screenshots` captures the maintained scenario. Retired direct-provider commands are removed from the active npm surface.

## Remaining boundaries

- **OPEN:** dependency audit reports DOMPurify critical, Vite high and source-map-js high. No dependency upgrade was mixed into this packaging work.
- **OPEN:** native headed tab-visibility checks, physical keyboard shortcuts, public ingress/model-quality acceptance and store submission are separate from the isolated checks above.
- The broad old Settings/context-counter harness is archived; its full historical regression coverage is not claimed by the maintained smoke scenario.
- Historical Git secret scanning has one false positive on a tokenizer-config SHA-256 in a deleted file. The current tracked snapshot scan found no secrets. Old Git history is retained; no history rewrite was performed.
