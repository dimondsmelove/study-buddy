# Architecture and engineering decisions

This guide follows the current source. It separates the browser application, the service boundary and server operational state. The repository is a single package with two independently built entry points: `vite.config.ts` builds the extension and `vite.backend.config.ts` builds the Node service.

## Frontend: browser application and lifecycle

### Capture the intended document

The content script draws the selection overlay. The service worker receives a rectangle and device-pixel ratio, calls `chrome.tabs.captureVisibleTab`, and crops the viewport image with `OffscreenCanvas`.

Chrome captures a window's active tab, not an arbitrary tab ID. [capture.ts](../src/background/capture.ts) therefore observes activation, navigation and closure and verifies the active tab before and after the asynchronous screenshot. A switch away and back still invalidates the capture. The originating document ID also protects against capturing a replacement document after navigation. The guard is inherited from OCR Buddy.

A capture is saved before any generation starts. Selecting an image does not itself trigger a model call.

### Isolate the panel and keep the stream alive

[overlay.ts](../src/content/overlay.ts) hosts an extension-origin iframe in a closed shadow root. This separates page styling from the panel; the extension iframe contains chat rendering and networking. A detached extension window handles contexts where embedding is unavailable.

The iframe owns the active HTTP stream. The MV3 worker coordinates browser events and persisted state; it does not rely on a permanent process for model execution. Minimizing keeps the iframe alive. Switching tabs can restore another view of the shared conversation without opening another paid generation.

The conversation coordinator serializes transcript changes through one queue and tracks the active writer port. Stop is forwarded to that writer. Close cancels and saves the active reply and clears shared panel state. Losing the writer document preserves the latest committed partial as interrupted; it does not silently retry a paid request.

### Persist the transcript separately from selected context

[conversation-store.ts](../src/shared/conversation-store.ts) uses IndexedDB transactions for conversations, image Blobs and generation state. Writes complete before callers receive success. Startup recovery marks unfinished work as interrupted. Attachment deletion considers references from retained conversations.

The local history retains 20 conversations by message activity. Capturing or viewing alone does not promote a conversation's recency. A transient cache of recent crops lives separately in `chrome.storage.session`.

[conversations.ts](../src/shared/conversations.ts) builds the context projection for a request. It keeps the current task and its source image, then adds recent complete exchanges while token estimates and serialized request size allow. Omission from the outgoing request does not erase the original transcript.

The shared estimator uses one token per four UTF-8 bytes plus message framing and a fixed image estimate. The nominal input budget is 100,000 estimated tokens, with 20,000 reserved as headroom. The backend recomputes the same estimate against the canonical request. Neither side treats this as a provider-exact tokenizer.

### Render partial output safely

[chat.ts](../src/chat/chat.ts) renders Markdown with Marked and sanitizes generated HTML with DOMPurify. LaTeX rendering waits for complete delimiters while a response is streaming. The saved response text stays separate from presentation repairs for unfinished Markdown.

Interface labels, answer-language choice and task intent are separate inputs. The toolbar language picker updates local preferences without making a model request. The older Settings screen remains in source but is hidden in the current interface.

## Backend: request boundary and streaming

### Accept intent, prepare the provider request server-side

The extension sends a request ID, task, language choices, explicit user input and selected conversation messages. [gateway-protocol.ts](../src/shared/gateway-protocol.ts) defines this contract and prepares canonical instructions.

[app.ts](../src/backend/app.ts) validates the JSON structure, accepted fields, image headers and dimensions, content limits and session before admitting work. Client input cannot select an arbitrary upstream URL or provider key. The service owns model selection and generation parameters.

Images are inline PNG/JPEG/WebP, limited to 4 MiB decoded, 16,384 pixels per side and 40 million pixels in total. The HTTP request limit is 32 MiB. Validation reads image structure rather than decompressing pixels or downloading arbitrary image URLs.

### HTTP surface

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Process health; no provider call |
| POST | `/api/v1/session` | Issue an anonymous installation credential and a session |
| POST | `/api/v1/session/recover` | Issue a session for the same installation using its durable credential |
| POST | `/api/v1/session/claim` | Associate a valid legacy bearer with an installation |
| POST | `/api/v1/session/renew` | Renew the current bearer |
| POST | `/api/v1/generations` | Validate and admit a generation, then stream SSE |

Generation and bearer-based session operations use `Authorization: Bearer …`. Recovery uses the installation ID and secret in its JSON body. Bootstrap, claim and renewal accept no request body. Session credentials are generated with cryptographic randomness; token and installation-secret hashes are stored server-side.

The gateway accepts exact allowlisted origins. This is a browser-origin policy, not proof of user identity: requests without an Origin header are allowed, and a non-browser client can supply its own headers. Forwarded IPs are trusted only from explicitly configured proxy peers.

### Stream through a bounded operation

The generation response contains `context`, `fallback`, `delta` and terminal `complete` or `error` events. A `: ping` SSE comment is emitted every 20 seconds to keep otherwise quiet connections active. The client ignores comments and processes typed events.

The current model configuration has one primary and no alternate model. The protocol retains a fallback event type, but provider unavailability is surfaced as an error in the current application. Code and build success do not establish that the configured model is currently available from the provider.

The operation timeout is 180 seconds. Response disconnection aborts the upstream fetch; shutdown waits for active operations to finalize their database state. Failure after partial output is represented explicitly rather than treated as a successful full answer.

## SQLite: admission and cost accounting

[store.ts](../src/backend/store.ts) uses built-in `node:sqlite`, WAL mode, full synchronization and `BEGIN IMMEDIATE` transactions. Node 22.22.2 marks this API experimental; no separate SQLite package is installed.

| Table | Stored responsibility |
| --- | --- |
| `installations` | Anonymous subject, hashed recovery secret and activity timestamps |
| `sessions` | Hashed bearer, expiry and installation association |
| `issuance_buckets` | Short-lived HMAC network buckets for installation issuance |
| `operations` | Request fingerprint, admission state and operation lifecycle |
| `monthly_budgets` | Spent and reserved amounts by installation and UTC month |
| `budget_charges` | Per-request reservation, settlement and reconciliation state |

The server does not persist message text, captures or generated answer bodies. The browser persists its own transcript and may store provider-reported usage with the assistant turn.

### Reserve before starting paid work

Admission checks identity, duplicate request IDs, cooldown, per-installation concurrency, global capacity and budget in one transaction before recording a new active operation.

Current constants allow one start per installation every ten seconds, one active generation per installation and four globally. Each generation reserves $0.275 against a $5 installation budget and a $100 service aggregate budget per UTC month. Amounts are stored as integer nanodollars.

Trusted final usage settles a reservation once. A definitely rejected request can release its reservation. An uncertain provider outcome keeps funds reserved; where a generation ID is available, reconciliation retrieves provider metadata. Reconciliation checks the expected model before applying a charge. These caps apply only to this service database, not other activity on a provider account.

Duplicate request IDs do not restart work: a matching fingerprint returns `generation.already_started`; a conflicting payload returns `generation.request_id_conflict`. Completed operation records have a 24-hour pruning window. Existing budget-charge records can continue to reject the same ID after that window.

### Recover and prune conservatively

Startup marks active operations as interrupted and moves unresolved reservations into held state. This prevents a process restart from simply forgetting potentially paid work.

Installations inactive for 395 days are eligible for removal with their sessions, operations and budget rows. An active operation or an unresolved reserved/held charge prevents that removal. Pruning is lazy, at startup and on issuance or admission; it is not a scheduled deletion guarantee.

## Deployment boundary and tradeoffs

The backend is a single-instance service. HTTP controllers and reconciliation run in memory, while SQLite provides durable operational accounting. Sharing the database across independently starting service replicas would require a different ownership and recovery design.

The default host is loopback. The [Dockerfile](../Dockerfile) builds only the backend entry point into the runtime image. [compose.yaml](../compose.yaml) provides a persistent database volume, a non-root process, a read-only root filesystem, reduced capabilities, health checks and resource limits. The checked-in Compose service does not publish a host port; operator networking must provide ingress separately.

The [backend README](../src/backend/README.md) describes local setup. [backend-deployment.md](backend-deployment.md) preserves dated operator records; addresses and acceptance notes there do not establish current public availability.

The main tradeoffs are explicit: Chromium-specific integration, local rather than synchronized history, approximate context estimates, anonymous rather than account-based quotas, and one service instance rather than distributed coordination.

## Evidence

[backend-contracts.mjs](../scripts/backend-contracts.mjs) exercises real HTTP and SQLite against a fake provider: session recovery, duplicate admission, concurrency, budget settlement/reconciliation, invalid images, SSE heartbeat, timeout, disconnect and shutdown.

[storage-contracts.mjs](../scripts/storage-contracts.mjs) exercises real browser IndexedDB, rollback, interruption recovery, retention and attachment cleanup. The [preview smoke scenario](../scripts/preview-local.mjs) exercises the actual extension capture path and an incrementally rendered answer, followed by restoration after reload.

See [demo and verification](demo.md) for runnable commands and coverage limits.
