# Backend operation and release handoff

## Public backend: Stage 1 hosting record (2026-10-19)

This is a verified design record for the approved public-backend direction. It is not a deployment record. The Chrome Web Store release is planned for this week; users must not need Tailscale. Only the Study Buddy backend is in scope for public reachability. The extension, its local chat/image history, and its independent UI/answer-language settings retain their current architecture. The model remains openai/gpt-6-luna through OpenRouter, with the approved prompt package and parameters unchanged.

### FACT

- The current backend is one Node 22.22.2 process with built-in SQLite and a single-instance assumption. It listens on loopback by default, exposes /health, and serves session and generation APIs, including SSE. Runtime secrets remain server-side.
- Generation timeout is 180 seconds; maximum JSON request body is 32 MiB. The app emits text/event-stream; the ingress must preserve streaming, Authorization, and request bodies. These are application limits, not proof that a chosen ingress supports them end to end.
- On diamondserver, Docker 29.3 and Compose 5.1 are available. The host has private IPv4 addresses 192.168.1.7 and .3, default router 192.168.1.1, and no global IPv6. WAN address, CGNAT status, and router port-forward state are unknown. The Docker host has 157 GiB free disk and 5 GiB available memory at inspection; a Node 22 Alpine image is cached, but the project pins Node 22.22.2. Existing application ports are published to private addresses. Bounded checks found no active Caddy, Nginx, Apache, or Cloudflare Tunnel service/configuration and no Study Buddy deployment. This does not establish that the host is unreachable from the Internet.
- The scoped Study Buddy docs/config contain no selected public hostname, domain, DNS provider, or hosting account. Store privacy/contact and support fields remain draft placeholders. The packed/store extension ID is not yet known; the unpacked placeholder is not a release ID.
- Anonymous bearer sessions and CORS do not authenticate a person or trusted caller and do not impose a monetary spending cap. No account system, per-user billing, dollar cap, domain, ingress provider, or public hostname has been approved.

### DECISION

- Public access is required for the planned store release this week; users are not required to join a private mesh. Host the backend on this server in Docker. Expose only this service. Keep the OpenRouter key on the server and retain local browser chat/image persistence and separate UI/answer languages.
- No prompt, model, parameter, privacy meaning, authentication, budget, or user-facing behavior changes are included in this hosting slice.

### HYPOTHESIS — ingress paths to compare

1. **Direct HTTPS ingress:** router forwards only 443 to a dedicated HTTPS reverse proxy on the host; proxy reaches the backend over a private Docker network. This avoids a tunnel account and has a straightforward request path, but depends on a publicly routable WAN address and correct router/firewall configuration plus certificate issuance/renewal. Neither is verified. Do not expose the Node port directly.
2. **Named Cloudflare Tunnel:** an outbound tunnel routes a chosen hostname to the private proxy/backend and needs no inbound router port. This fits a home-hosted service behind NAT, but needs a domain/DNS and Cloudflare configuration/account. Cloudflare documents a 125-second Proxy Read Timeout; the app can wait up to 180 seconds, so quiet periods may be cut off. The app flushes SSE headers and a context event immediately but has no periodic heartbeat, so an external long-idle/stream test is required. Cloudflare's SSE guidance says event streams are not buffered when sent as text/event-stream. Its default documented upload limit is 100 MB, above the app's 32 MiB body limit, but account/zone settings must be checked. Sources: [routing a tunnel](https://developers.cloudflare.com/tunnel/concepts/routing/), [Tunnel troubleshooting and SSE buffering](https://developers.cloudflare.com/tunnel/troubleshooting/), [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/), [default cache behavior and upload limits](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).
These are design candidates, not a selected ingress or provider. In particular, do not treat CORS allowlisting as access control. A separate abuse/cost posture is still needed before sharing an anonymous paid gateway widely; the current limits are load controls, not a spend ceiling.

### OPEN

- Choose the public hostname/domain and who controls its DNS; then choose direct HTTPS or a named tunnel based on verified WAN/CGNAT/router facts and the stream timeout test.
- Confirm the actual extension store ID before setting exact ALLOWED_ORIGINS and building the distributed extension.
- Decide whether anonymous access remains acceptable for the first release and what spend/abuse response is acceptable. Do not silently add login, quotas, or dollar caps.
- Complete support contact and privacy URL/audience details, then reconcile disclosures with host, ingress, and provider retention. The current listing/privacy drafts also contain stale product claims (Quiz, multiline Check, English default and fallback); review them against the shipped behavior in the store stage.

### Docker packaging

The repository now contains a two-stage Dockerfile. Its build stage uses the exact Node 22.22.2 Debian slim image, runs npm ci and the existing backend build, and copies only the bundled server plus package.json (which declares ESM) into the runtime stage. The runtime keeps the official Node base utilities, but no project source, node_modules, frontend bundle, credentials, or build dependencies. Compose runs one non-root backend on a private bridge network, publishes no host ports, grants no Linux capabilities, uses a read-only root filesystem with a small writable /tmp, and mounts a persistent named volume at /data. The bridge allows required provider egress; it limits inbound reachability to containers attached to that network, but it is not a firewall against the Docker host or LAN.

Keep the runtime env file outside the checkout and image, mode 0600. For example, create it from .env.backend.example, fill the real server-only values, and then build/start explicitly:

~~~sh
install -d -m 700 /etc/study-buddy
install -m 600 .env.backend.example /etc/study-buddy/backend.env
# Edit /etc/study-buddy/backend.env with the real values.
export STUDY_BUDDY_ENV_FILE=/etc/study-buddy/backend.env
export STUDY_BUDDY_IMAGE=study-buddy/backend:release-<version>
docker compose build backend
docker compose up -d backend
docker compose ps
~~~

The compose file requires STUDY_BUDDY_ENV_FILE and does not publish the Node port. Compose creates the bridge named study-buddy-egress and named data volume study-buddy_backend-data under the default project name. A future ingress container must explicitly join that bridge and route to backend:8787. No ingress is included or selected here. Bridge networking alone does not prove that host/LAN access is blocked.

For a stopped, consistent backup, stop the single service and copy its entire data directory, including any WAL/SHM sidecars:

~~~sh
docker compose stop backend
install -d -m 700 ./backups
docker cp "$(docker compose ps -a -q backend)":/data ./backups/study-buddy-data
~~~

Keep that backup private. For an application rollback without a destructive schema migration, keep the existing volume and start the previous image tag:

~~~sh
STUDY_BUDDY_IMAGE=study-buddy/backend:previous docker compose up -d backend
~~~

The stopped backup is available if the volume must be restored. Do not use down -v: it removes the persistent volume.

Verified on diamondserver on 2026-10-19. Compose built image study-buddy/backend:review-20261019-container (ID sha256:b0cc82e5a83e7563d642c27945d43d1da90ad5566b3d73d89dc044580f8f1e81) from node:22.22.2-bookworm-slim, resolved to base digest sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e. The container started healthy with Node 22.22.2 and the built-in SQLite module, ran as UID 1000 with a read-only root, no Linux capabilities, no published host ports, and only the persistent /data mount writable. The runtime /app contains only package.json and .backend-dist/server.js. An anonymous session renewed successfully after forced container recreation; SIGTERM returned exit 0 and health passed after restart. The temporary container, network and volume were removed; the review image remains on the build host. Sanitized inspect and smoke evidence: /tmp/study-buddy-container-inspect-20261019.json and /tmp/study-buddy-container-smoke-20261019.log. A 2 MiB unlisted capture plus a fake oddly named credential file stayed out of the allowlisted build context (1.31 kB transferred). The smoke used only a dummy runtime key and HMAC secret and did not call the provider or exercise generation/SSE. npm ci printed one high-severity audit warning; no dependency change was made.

These checks establish isolated packaging and session-state persistence only. They do not establish public reachability, ingress SSE behavior, live service operation, or a store release.

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

## Generic single-host hardening notes

Pin Node 22.22.2 in the runtime image and run exactly one service instance.
For the approved public-host direction and unresolved ingress choices, see
[the Stage 1 hosting record above](#public-backend-stage-1-hosting-record-2026-10-19). The
container and ingress are still unimplemented; deployment is a later stage.

- For a non-container process, keep the backend bound to loopback behind HTTPS
  termination. In Docker, bind only to the private container network and publish
  no Node port on the host. Use a dedicated unprivileged service user and private
  data directory. Keep the runtime env file outside extension assets, mode 0600.
- Use the actual extension ID as an exact CORS allowlist entry. CORS is a browser
  boundary, not authentication: clients outside a browser can omit Origin.
- Set `TRUSTED_PROXY_IPS` only for the direct reverse-proxy peers. The proxy must
  replace untrusted forwarded-address headers. Empty means direct socket IP.
- Permit request bodies up to 32 MiB. Disable SSE response buffering/compression
  buffering and preserve Authorization. Where configurable, use at least 190
  seconds of upstream read-idle time for the 180-second app timeout. Cloudflare
  currently documents 125 seconds on its proxied path, so long quiet periods can
  still fail; verify the chosen ingress with an external long-idle stream before
  release.
- Configure access/error logs to avoid Authorization, request/response bodies,
  image data and raw IP retention inconsistent with the published policy. App
  logs contain only method, route, status and duration.
- Persist the SQLite file across deploys. Do not use an ephemeral filesystem or
  reset the file to work around a cooldown. Startup marks prior active operations
  interrupted and keeps cooldown/idempotency state.

Example systemd command for a non-Docker alternative only (substitute actual paths):

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

Before publication, choose and verify the hostname and ingress, confirm the store
extension ID, complete support/privacy contact and audience decisions, reconcile
host/ingress/provider retention disclosures, and refresh store assets. Public
reachability, abuse/cost posture, and the streaming path must be accepted before
release. These are release actions, not evidence that this branch is deployed.
