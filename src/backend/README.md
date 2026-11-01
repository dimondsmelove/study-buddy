# Study Buddy backend

The backend is an independently runnable Node service. Use Node **22.22.2** (the repository .nvmrc pins this version). It uses Node's built-in node:sqlite API, which is experimental in this Node release; startup prints Node's experimental API warning. No SQLite package or provider SDK is installed.

## Local setup

Run these commands from the repository root with Node 22.22.2:

```sh
npm ci
npm run build
```

Load `dist/` through **Load unpacked** at `chrome://extensions`, then copy the extension ID shown there. Copy `.env.backend.example` to ignored `.env.backend`, set `ALLOWED_ORIGINS=chrome-extension://<your-extension-id>`, and fill `OPENROUTER_API_KEY` and `SESSION_HMAC_SECRET`. The default client build connects to loopback port 8787.

```sh
cp .env.backend.example .env.backend
# Fill the runtime values in .env.backend before starting the service.
npm run backend:build
node --env-file=.env.backend .backend-dist/server.js
```

In another terminal, `curl http://127.0.0.1:8787/health` should return `{"ok":true}`. This checks process health without contacting the provider. Then capture a region in the extension and explicitly start a task. Real generations use the configured provider account.

`npm run backend` is an alternative when the runtime variables are already exported; it does not load `.env.backend` automatically.

## Configuration

Runtime environment variables:


- OPENROUTER_API_KEY: server-only provider credential.
- SESSION_HMAC_SECRET: at least 32 UTF-8 bytes, used to hash short-lived issuance IP buckets.
- DATABASE_PATH: SQLite file path; defaults to ./data/study-buddy.sqlite.
- HOST: bind address; defaults to 127.0.0.1.
- PORT: listen port; defaults to 8787.
- ALLOWED_ORIGINS: comma-separated exact extension origins, for example chrome-extension://extension-id. Empty means requests without an Origin header only. Only exact origins in the allowlist are echoed; unlisted origins are rejected. HTTP/HTTPS origins must be explicitly listed.
- TRUSTED_PROXY_IPS: optional comma-separated exact proxy peer IPs. Forwarded client IPs are used only when the direct socket peer is listed and the forwarding chain is valid and bounded. Leave empty when binding directly.

Keep both secrets in the backend process environment. They are not Vite defines or extension build variables. `STUDY_BUDDY_GATEWAY_URL` is the public backend origin compiled into the extension; it defaults to `http://127.0.0.1:8787` and must be an origin without a path, query, or fragment. The manifest includes the selected gateway host in addition to its page-access permissions. Provider selection, URL, model chain, prompts, and generation parameters are fixed by server code. A trusted in-process factory option is used by fake-provider tests and an operator-owned proxy; no HTTP request can set the upstream URL.

`npm run backend` builds the Node service into ignored `.backend-dist/` and starts it; `npm run backend:build` only builds. Build the extension with `STUDY_BUDDY_GATEWAY_URL=https://your-backend-origin npm run build` when it should use a remote gateway. `npm run preview:local` builds against a temporary loopback gateway and launches an isolated Chromium profile with an HTTP fake upstream. `npm run contracts:backend` runs deterministic fake-only HTTP, SQLite, image, and SSE contracts; it does not read provider credentials or make provider requests. `npm run typecheck:backend` checks backend and shared TypeScript.

Operational state contains hashed session tokens, durable anonymous installation IDs and hashed installation secrets, opaque HMAC IP buckets, request fingerprints (SHA-256), cooldowns, operation statuses, and per-installation monthly spent/reserved wallet entries with provider generation IDs for unresolved charges. Installations inactive for 395 days and their related operational and budget rows are pruned unless an active operation or reserved/held charge remains. Clearing local extension data does not itself delete server-side identity or ledger state. Expired issuance buckets and completed idempotency records are pruned at startup and on the next session issuance or generation admission; removal is lazy. It does not store message text, images, generated output, or provider response bodies. Request-completion logs contain method, route name, status, and duration; accounting events contain event names and route metadata, without transcript or provider-response bodies. The database file is set to mode 0600; the default data directory is created as mode 0700. Keep custom database paths in a private directory.

The HTTP API bootstraps an anonymous installation and its first session at POST /api/v1/session. The response includes a durable installation ID and one-time secret; the backend stores only its SHA-256 hash, and the extension stores the credential separately from the expiring bearer. POST /api/v1/session/recover accepts that credential to issue a session for the same installation. POST /api/v1/session/claim associates a still-valid legacy bearer with a durable installation; retrying a claim keeps the subject and rotates the secret. POST /api/v1/session/renew renews a bearer, and POST /api/v1/generations streams generations. The generation stream emits context, fallback, delta, and a terminal complete or error event.

Each image is limited to 4 MiB decoded, and PNG/JPEG/WebP dimensions are bounded to 16,384 pixels per side and 40 million pixels total. The service validates headers/chunk structure without decompressing pixels. Text is estimated at one token per four UTF-8 bytes under a nominal 100,000-token context budget. The client holds back 20,000 tokens for estimate variance, so selected context stays at or below 80,000 estimated tokens; the estimate is not a provider tokenizer or exact bound. It retains the current task and its source image, then adds newest complete exchanges while the token and 32 MiB request limits allow. Older exchanges remain saved and can be reused. Duplicate image references are sent once; each image is limited to 4 MiB decoded.

The monthly wallet is $5 per anonymous installation per UTC calendar month, with a separate $100 aggregate cap per UTC month across installations using this service database. The aggregate is the sum of spent and reserved wallet amounts and does not cap unrelated usage of the provider account. Each generation still reserves $0.275, preserving the approved wallet reserve. It was originally rounded up from the provider max-price envelope of 1,050,000 prompt tokens at $0.25/M plus 16,384 output tokens at $0.75/M ($0.274788); the current app sends at most 8,192 output tokens. Trusted final provider usage replaces the reservation; unresolved usage remains reserved and is reconciled by generation ID. The request uses OpenRouter max_price routing limits. The primary model is anthropic/claude-haiku-5.5 through OpenRouter, with medium reasoning excluded from returned content; no fallback model is configured. References: [provider max price](https://openrouter.ai/docs/guides/routing/provider-selection#max-price), [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation).

## Docker and service ownership

The repository includes a [Dockerfile](../../Dockerfile) and [Compose service](../../compose.yaml). Set `STUDY_BUDDY_ENV_FILE` to an external runtime environment file and start with `docker compose up --build -d`. Compose uses a persistent SQLite volume and does not publish a host port; ingress must be configured separately. Use one service instance with its operational database. Multiple replicas require a different operation-ownership and recovery design.

The current provider configuration has one primary model and no fallback. Availability must be checked against the actual provider separately from mock contracts. The provider request includes `data_collection: "deny"`; this routing preference is not a claim that no external processing occurs.

For the storage model, HTTP routes and request lifecycle, see [architecture](../../docs/architecture.md). [Deployment records](../../docs/backend-deployment.md) preserve dated operator history rather than a current public endpoint contract. For a credential-free demonstration, use the [local preview](../../docs/demo.md).
