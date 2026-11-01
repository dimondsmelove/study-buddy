# Demo and verification

The local preview uses the real extension, real Node HTTP backend and a separate SQLite database. Only the upstream model is simulated. It uses synthetic page content and blocks browser network requests outside the local fixture and gateway origins.

## Prerequisites

Use Node.js **22.22.2** and npm. The repository pins the Node version in `.nvmrc`; a Node version manager can select it if one is installed.

```sh
npm ci
npx playwright install chromium
```

On a supported Linux distribution that needs browser system libraries:

```sh
npx playwright install --with-deps chromium
```

The interactive preview needs a graphical desktop. The automated smoke run uses headless Chromium and does not need a display. Both use their own profile, with no attachment to an existing browser session.

## Interactive walkthrough

```sh
npm run preview:local
```

The script builds an isolated copy of the extension, starts the fixture and gateway, opens Chromium and captures the equation on the demo page. Wait for `READY` in the terminal; by default the page is served at `http://127.0.0.1:4187/demo`.

1. Inspect the captured image in the chat. Capture alone does not generate an answer.
2. Click **Hint**. Watch the fixed response arrive in chunks and finish with a saved status. This verifies transport and UI behavior rather than tutoring quality.
3. Minimize and restore the panel. Use the toolbar icon or shortcut to select another region, then continue in the same conversation.
4. Change the answer language using the language button in the chat toolbar. The mock has fixed English and Russian fixture replies; it does not translate arbitrary content.
5. Close the panel. Right-click the extension icon and choose **Show history** to reopen the saved conversation.

The fixture recognizes the canonical Hint and Check instructions. Other tasks and free-form questions receive a generic demonstration answer. Between generation starts, the real backend cooldown applies.

In another terminal, from the same checkout:

```sh
npm run preview:local -- health
npm run preview:local -- stop
```

Closing the isolated browser also stops the preview. Preview files remain under ignored `review/preview/`. If port 4187 is already occupied, select another loopback port:

```sh
STUDY_BUDDY_PREVIEW_PORT=4188 npm run preview:local
```

## Automated fullstack smoke run

```sh
npm run verify
```

This run performs a real toolbar action, selects a 310 × 70 CSS-pixel region of the synthetic page, waits for the captured image, clicks Hint, observes partial output, waits for completion and reloads the chat document. It requires the saved answer to reappear without a second upstream request, then closes its browser and service.

Each run creates a separate `review/preview/run-*/` directory with:

| Artifact | Meaning |
| --- | --- |
| `demo.png` | Actual 1200 × 800 Chromium screenshot after reply restoration |
| `smoke.json` | Viewport, capture dimensions, partial-answer observation, upstream count and reload result |
| `gateway.sqlite` | Preview-only operational database |
| `dist/` and `profile/` | Isolated extension build and browser profile |

The [README screenshot](images/demo.png) was captured from the actual reference dist by this scenario on 2026-11-01 with Chromium at 1200 × 800; [narrow view](images/narrow.png) uses 320 × 568. See [current state](../CURRENT-STATE.md) for source/artifact equivalence. Its study page is synthetic and its answer is a mock. It is not a capture of a student's data or a live model evaluation.

## Verification

[CI](../.github/workflows/ci.yml) uses Node 22.22.2 and the Playwright version locked in `package-lock.json`. No provider credential or repository secret is required.

The contracts/build job runs:

```sh
npm run typecheck
npm run typecheck:backend
npm run contracts
npm run contracts:prompts
npm run contracts:context
npm run contracts:backend
npm run backend:build
npm run build
```

The browser job installs Chromium and runs:

```sh
npm run contracts:storage
node --experimental-strip-types scripts/welcome-contracts.mjs
npm run verify
```

The backend suite crosses real HTTP and SQLite boundaries with a local fake provider. The storage suite crosses real IndexedDB transactions. Welcome contracts include an actual isolated extension messaging exchange. The smoke scenario connects capture, backend admission, SSE rendering and local reply restoration.

### Verify an existing build unchanged

```sh
npm run verify -- --extension-dir /absolute/path/to/dist
```

This bypasses the build step and hashes the supplied artifact before and after acceptance. Its compiled gateway is redirected only inside the isolated test browser to the local backend. HTTPS artifacts use a temporary loopback TLS relay to preserve incremental streaming; this mode requires `openssl`. No requests reach the compiled production gateway. Evidence includes the original gateway URL, all file hashes and the aggregate digest.

### Archived and separate checks

The old Settings/context-counter harness and direct-provider tools are preserved as non-runnable `.txt` files in [scripts/archive](../scripts/archive/README.md). They are excluded from the active npm surface. `npm run verify` now runs the maintained composed scenario; it does not claim the full coverage of the archived broad regression harness.

`npm run verify:overlay-click` checks native tab visibility using a separately launched headed browser. It requires `SB_HEADED=1` and an isolated graphical display. On Linux with Xvfb installed, its invocation is:

```sh
SB_HEADED=1 xvfb-run -a npm run verify:overlay-click
```

It is not part of the headless CI job. Live provider quality, physical keyboard shortcuts, native tab visibility, public hosting and store installation need separate acceptance; the automated smoke result does not establish them.

## Use an actual model

Follow [backend setup](../src/backend/README.md#local-setup). Keep the provider key on the server, configure the exact unpacked extension ID and load the normal `dist/` build. The local preview deliberately uses its own mock gateway and does not become a live-provider demo when runtime credentials are present.
