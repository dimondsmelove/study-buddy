# Archived harness source

These files are historical reference text, not runnable scripts or current acceptance evidence. Their original versions remain available in Git history. Current commands are `npm run verify`, `npm run playtest`, `npm run screenshots`, the contract suites and `npm run verify:overlay-click` (headed acceptance only).

| File | Reason for retirement |
| --- | --- |
| `verify.mjs.txt` | Broad regression harness tied to the old Settings screen and context-counter layout; reproduced timeout at the hidden Settings button on 2026-11-01. It also contains a session-specific screenshot path. Preserve its useful scenario ideas when extending maintained tests. |
| `playtest.mjs.txt` | Disabled direct-provider launcher that always exits unsuccessfully in gateway mode. |
| `quality.mjs.txt`, `review.mjs.txt` | Inject browser-side provider settings and credentials from the retired direct-provider architecture. They do not validate the current gateway client. |
| `screenshots.mjs.txt` | Injects synthetic answers and targets old UI states; replaced by screenshots from the actual capture/backend/SSE flow. |
| `compare.mjs.txt` | Standalone historical paid model comparison; does not exercise the application's gateway or current request contract. |

The `.txt` suffix keeps these obsolete entry points out of the runnable script surface. See [current state](../../CURRENT-STATE.md) and [verification](../../docs/demo.md#verification).
