# Backend operation and release handoff

This is a local integration candidate, not a deployed service. The initial
architecture is one Node process and one SQLite file on persistent local disk.
Do not run multiple instances against this database: startup recovery assumes
that no other instance owns an active generation.

## Reproduce locally

Use Node 22.22.2 (`.nvmrc`). Built-in `node:sqlite` is experimental in this version;
its startup warning is expected. No provider SDK or database package is needed.

```sh
npm ci
cp .env.backend.example .env.backend
# Fill OPENROUTER_API_KEY, SESSION_HMAC_SECRET and the exact ALLOWED_ORIGINS.
chmod 600 .env.backend
npm run typecheck:backend
npm run contracts:backend
npm run backend:build
node --env-file=.env.backend .backend-dist/server.js
```

`GET http://127.0.0.1:8787/health` returns `{"ok":true}`. SIGINT/SIGTERM stops
the service and aborts active upstream requests. Health does not make a model
request or verify provider credits. For the exact runtime variables and HTTP
routes see [the backend README](../src/backend/README.md).

The extension must be built for the chosen gateway URL; follow the root README.
Its exact `chrome-extension://ID` must be in `ALLOWED_ORIGINS`. The local preview
uses a separate profile/database and fake upstream. It does not need credentials.

## Public host preparation

Select a persistent host with Node 22.22.2 and a single service instance.
A conventional VPS is sufficient; a managed service must support persistent
disk and long-lived streaming requests. There is no dependency on a particular
hosting company. Production hosting and domain selection remain outside this
loop.

- Keep the backend bound to loopback behind HTTPS termination. Give the service
  a dedicated unprivileged OS user and a private data directory. Keep the runtime
  env file outside the public document root and extension assets, mode 0600.
- Use the actual extension ID as an exact CORS allowlist entry. CORS is a browser
  boundary, not authentication: clients outside a browser can omit Origin.
- Set `TRUSTED_PROXY_IPS` only for the direct reverse-proxy peers. The proxy must
  replace untrusted forwarded-address headers. Empty means direct socket IP.
- Permit request bodies up to 32 MiB. Disable SSE response buffering/compression
  buffering, preserve Authorization, and allow at least 190 seconds of upstream
  read time for the 180-second application timeout. A shorter hosting timeout
  can interrupt a valid answer.
- Configure access/error logs to avoid Authorization, request/response bodies,
  image data and raw IP retention inconsistent with the published policy. App
  logs contain only method, route, status and duration.
- Persist the SQLite file across deploys. Do not use an ephemeral filesystem or
  reset the file to work around a cooldown. Startup marks prior active operations
  interrupted and keeps cooldown/idempotency state.

Example service command after building (substitute actual paths):

```ini
[Service]
User=study-buddy
WorkingDirectory=/opt/study-buddy
ExecStart=/opt/node-v22.22.2/bin/node --env-file=/etc/study-buddy/backend.env /opt/study-buddy/.backend-dist/server.js
Restart=on-failure
RestartSec=3
UMask=0077
```

This fragment is documentation; the loop does not install an OS service or
change the production host.

## State, backup and rollback

SQLite holds hashed sessions, issuance buckets and operation fingerprints/status,
not chats. Browser history, images and per-answer usage remain on the device.
A stopped service can be backed up by copying the database and any remaining
`-wal`/`-shm` sidecars together; an arbitrary copy of a live WAL database is not a
consistent backup. Protect backups like the original database and retain them
only for an operational need.

For an upgrade, stop the one service, back up state, switch to the tested
checkout/build and restart; check health and one controlled synthetic request.
Rollback uses the previous build and a schema-compatible database. There are
no destructive migrations in this slice. Rolling back to the old direct-provider
extension would reintroduce its original credential exposure and is not the
public gateway release path.

## Known boundaries

Anonymous sessions are renewable bearer tokens, not accounts or unique people.
A determined caller can reset sessions or change networks. The 10-second/session
interval, one in-flight/session, four globally, 20 issued sessions/IP/hour,
approximate input budget and per-task output caps reduce load but do not impose
a monetary spending ceiling. Shared NATs share issuance limits. There is no
hidden queue, cloud history, billing or cross-device recovery.

The 200,000-input-token policy keeps 20,000 in reserve and estimates one text token
per four UTF-8 bytes, with a separate allowance per image.
Provider-native text/image token counts can differ. Stop requests cancellation;
already processed upstream work can still be billed, and a lost final usage
chunk means unknown usage. Explicit Retry starts a new operation. Never
silently retry an ambiguous or partial generation.

Before publication, choose the service/domain and extension distribution,
complete support/privacy contact and audience decisions, reconcile host/provider
retention disclosures, and refresh store assets. These are release actions,
not evidence that this local branch has been published.
