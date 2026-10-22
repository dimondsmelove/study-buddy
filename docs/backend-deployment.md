# Backend operation and release handoff

## Public backend: Stage 1 hosting record (2026-10-19)

This is a verified design record for the approved public-backend direction. It is not a deployment record. Public domain, tunnel, deployment, and store release work is deferred to later sessions; users must not need Tailscale for the eventual public release. Only the Study Buddy backend is in scope for public reachability. The extension, its local chat/image history, and its independent UI/answer-language settings retain their current architecture. Current implementation update (2026-10-21): the primary is anthropic/claude-haiku-5.5 through OpenRouter, with medium reasoning excluded from returned content and no fallback. Output is capped at 8,192 tokens; nominal input budget is 100,000 with 20,000 held back for estimator variance. This supersedes the earlier model/output description; the approved prompt package remains unchanged.

### FACT

- The current backend is one Node 22.22.2 process with built-in SQLite and a single-instance assumption. It listens on loopback by default, exposes /health, and serves session and generation APIs, including SSE. Runtime secrets remain server-side.
- Generation timeout is 180 seconds; maximum JSON request body is 32 MiB. The app emits text/event-stream; the ingress must preserve streaming, Authorization, and request bodies. These are application limits, not proof that a chosen ingress supports them end to end.
- On diamondserver, Docker 29.3 and Compose 5.1 are available. The host has private IPv4 addresses 192.168.1.7 and .3, default router 192.168.1.1, and no global IPv6. WAN address, CGNAT status, and router port-forward state are unknown. The Docker host has 157 GiB free disk and 5 GiB available memory at inspection; a Node 22 Alpine image is cached, but the project pins Node 22.22.2. Existing application ports are published to private addresses. Bounded checks found no active Caddy, Nginx, Apache, or Cloudflare Tunnel service/configuration and no Study Buddy deployment. This does not establish that the host is unreachable from the Internet.
- No public hostname/domain has been acquired or selected yet. Domain acquisition, Cloudflare account/zone setup, tunnel creation, and DNS routing are deferred to a later session. Store privacy/contact and support fields remain draft placeholders. The packed/store extension ID is not yet known; the unpacked placeholder is not a release ID.
- Anonymous bearer sessions and CORS do not authenticate a person or trusted caller. A durable anonymous installation identity now carries the monthly wallet; clearing extension data, using a new profile, or reinstalling can create another identity. The per-installation budget is described below.

### DECISION

- Public access is required for the planned store release this week; users are not required to join a private mesh. Host the backend on this server in Docker, expose only this service, keep the OpenRouter key server-side, and retain local browser chat/image persistence and separate UI/answer languages.
- The user selected a **named Cloudflare Tunnel** as ingress. Direct router HTTPS is not selected. A domain and stable hostname are still required; purchase and Cloudflare/DNS setup have not happened.
- Access should be free to anyone installing the extension, with no account or invitation gate. The API remains anonymous: an extension install does not identify a caller, and public clients outside the extension can also call the endpoint. CORS is not authorization. No login or registration behavior is being added.
- Each anonymous installation receives **$5 per UTC calendar month**. Each new generation atomically reserves $0.275; trusted final usage replaces the reserve, while missing or ambiguous usage remains reserved until reconciled. An installation with less than $0.275 available cannot start a request. A known charge above its reserve blocks that installation pending operator review. The backend also enforces a **$100 global aggregate per UTC calendar month** across all installations using this service database. This limits traffic through this service only; it does not cap unrelated usage of the same provider account.
- The $0.275 reserve remains unchanged by the 2026-10-21 model and cap change. It preserves the earlier conservative envelope: 1,050,000 prompt tokens × $0.25/M + 16,384 output tokens × $0.75/M = $0.274788, rounded up to $0.275. The request carries OpenRouter provider max_price limits for prompt/completion and zero request/image surcharges. Sources: [OpenRouter provider max price](https://openrouter.ai/docs/guides/routing/provider-selection#max-price), [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting), and [generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation). The request currently uses the approved prompt package and caps output at 8,192 tokens.

### Selected ingress — named Cloudflare Tunnel

The tunnel will route a stable domain hostname to the backend without an inbound router port. Domain acquisition, Cloudflare zone/account configuration, tunnel creation, DNS routing, and deployment remain pending. Cloudflare documents a 125-second Proxy Read Timeout; the app can wait up to 180 seconds, so a quiet SSE stream may be cut off. The app flushes SSE headers and a context event immediately but has no periodic heartbeat; test a long-idle stream through the chosen route before release. Cloudflare's SSE guidance says event streams are not buffered when sent as `text/event-stream`. Its default documented upload limit is 100 MB, above the app's 32 MiB request-body limit, but verify the account/zone setting. Sources: [routing a tunnel](https://developers.cloudflare.com/tunnel/concepts/routing/), [Tunnel troubleshooting and SSE buffering](https://developers.cloudflare.com/tunnel/troubleshooting/), [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/), and [default cache behavior and upload limits](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).

Do not use a Cloudflare Quick Tunnel for this release: Cloudflare documents that it is for testing, has an ephemeral hostname and no uptime guarantee, and does not support SSE. See [Quick Tunnel limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

### OPEN

- In a later public-release session, acquire the domain, decide its stable hostname, confirm DNS control, and configure the selected named Cloudflare Tunnel and route; none of these steps is complete yet.
- Confirm the actual extension store ID before setting exact ALLOWED_ORIGINS and building the distributed extension.
- Complete support contact and privacy URL/audience details, then reconcile disclosures with host, ingress, and provider retention. The current listing/privacy drafts also contain stale product claims (Quiz, multiline Check, English default and fallback); review them against the shipped behavior in the store stage.

### Docker packaging

The repository contains a two-stage Dockerfile. Its build stage uses the exact Node 22.22.2 Debian slim image, runs npm ci and the existing backend build, and copies only the bundled server plus package.json (which declares ESM) into the runtime stage. The runtime keeps the official Node base utilities, but no project source, node_modules, frontend bundle, credentials, or build dependencies. Compose runs one non-root backend on a private bridge network, publishes no host ports, grants no Linux capabilities, uses a read-only root filesystem with a small writable /tmp, and mounts a persistent named volume at /data. The bridge allows required provider egress. A separate, host-scoped nftables guard is described below; packaging alone does not block access to the Docker host, LAN, or other bridge peers.

Keep the runtime env file outside the checkout and image, mode 0600. This setup copies the example only when the file is missing, so rerunning it during upgrades preserves existing values:

~~~sh
install -d -m 700 "$HOME/.config/study-buddy"
if [ ! -e "$HOME/.config/study-buddy/backend.env" ]; then
  install -m 600 .env.backend.example "$HOME/.config/study-buddy/backend.env"
fi
# Edit the file once to add the real server-only values.
export STUDY_BUDDY_ENV_FILE="$HOME/.config/study-buddy/backend.env"
export STUDY_BUDDY_IMAGE=study-buddy/backend:release-20261019
docker compose build backend
# After the root-owned guard files and service unit are installed and reviewed:
sudo systemctl start study-buddy.service
sudo systemctl status study-buddy.service
~~~

Do not run `docker compose up` or `docker start` directly on the host: that bypasses the network guard. The service unit pins the selected image tag and env-file path; align them with the reviewed release configuration before installing the unit.

The compose file requires STUDY_BUDDY_ENV_FILE and does not publish the Node port. Compose creates the bridge named study-buddy-egress and named data volume study-buddy_backend-data under the default project name. The service also has a 1 GiB memory limit with swap disabled for the container, a two-CPU ceiling, 128-PID limit, and rotating 10 MiB × 3 JSON logs. These are host-resource bounds, not request quotas. A future ingress must be explicitly reviewed and added to the guarded path; the current bridge peer rule blocks all same-bridge traffic. The named Cloudflare Tunnel is selected but not configured or deployed.

### Host network guard (ephemeral verification)

The repository includes two narrowly scoped nftables tables and a root-owned service wrapper. The `inet study_buddy_guard` input/forward hooks match only `iifname "study-buddy0"`: new connections to the host are dropped, replies to host-initiated connections are allowed, forwarded private/reserved IPv4 destinations are dropped, DNS is allowed only to 1.1.1.1 and 1.0.0.1 on TCP/UDP 53, public IPv4 TCP 443 is allowed, and the remaining forwarded traffic is dropped. This is broad public HTTPS egress, not an OpenRouter-only allowlist. The `bridge study_buddy_guard` forward hook drops all layer-2 peer traffic entering or leaving only `study-buddy0`; this closes same-bridge container-to-container access without enabling global bridge netfilter. Docker IPv6 is disabled on this bridge and the inet rules drop IPv6 forwarded/input traffic from it. Root can still alter Docker or nftables; these rules are a scoped guard, not a boundary against the host administrator. The guard does not modify Docker, Tailscale, UFW, or global firewall tables.

An initial inet-only trial did not block same-bridge traffic because the host did not have bridge netfilter active; that trial was removed before the reviewed bridge-family peer table was added. On 2026-10-19, an ephemeral host test then applied both tables through the wrapper and removed them after stopping and deleting every test container. Before the guard, a same-bridge listener and a test listener published only on the bridge gateway were reachable; after applying it both were blocked and the bridge-peer and private-destination drop counters increased. A public TCP/80 probe was reachable before and blocked after; DNS through the two approved resolvers and an unauthenticated HTTPS GET to OpenRouter's models endpoint (200) continued to work. A host-initiated connection to a test listener in the backend container returned successfully and incremented the input reply counter; a new connection from the container to a temporary host-gateway listener was blocked and incremented the input drop counter. Removing the guard while a container was attached was refused; removal succeeded after Compose stopped and removed the container. The sanitized runtime/cgroup and counter record is `/tmp/study-buddy-network-stage-20261019/guard-runtime-evidence.txt` on diamondserver. The tested image ran as UID/GID 10001 with `/data` owned 10001:10001 mode 0700, a read-only root filesystem, ephemeral `/tmp`, no capabilities, no published ports, and effective cgroup limits of 1 GiB memory with swap disabled, 2 CPUs, and 128 PIDs. Its 52.7 MB `memory.peak` was measured during this idle network smoke; it is not a peak for four admitted generations.

This test did not exercise IPv6 packets end to end because the Docker bridge has IPv6 disabled, and it did not prove that every host/LAN route is blocked; some direct private routes were already blocked by host policy before the candidate guard. The rules allow any public IPv4 TCP 443 destination. The named Cloudflare Tunnel is selected but not configured; any ingress sharing this bridge will need a separately reviewed peer exception rather than a broad allow rule. Temporary test resources and temporary rule files were removed; the guard is not installed and no Study Buddy service is running.

The supported future start path is the root-owned `study-buddy.service` plus `ops/study-buddy-service.sh`: it applies and validates both tables before Compose starts the backend, stops the backend before removing the tables, and orders startup after Docker. The container uses `restart: on-failure` so Docker daemon startup does not independently start it ahead of the guard. Install Compose and the ops files as root-owned files (directories 0755, rules/Compose/unit 0644, executable scripts 0755) under `/opt/study-buddy`, `/usr/local/share/study-buddy`, `/usr/local/libexec`, and `/etc/systemd/system`; never preserve checkout ownership or let an unprivileged operator edit the root-run Compose file. For a reviewed installation, the exact commands are:

~~~sh
sudo install -d -o root -g root -m 0755 /opt/study-buddy /usr/local/share/study-buddy /usr/local/libexec /etc/systemd/system
sudo install -o root -g root -m 0644 compose.yaml /opt/study-buddy/compose.yaml
sudo install -o root -g root -m 0644 ops/study-buddy-guard.nft ops/study-buddy-guard-bridge.nft /usr/local/share/study-buddy/
sudo install -o root -g root -m 0755 ops/study-buddy-guard.sh ops/study-buddy-service.sh /usr/local/libexec/
sudo install -o root -g root -m 0644 ops/study-buddy.service /etc/systemd/system/study-buddy.service
sudo systemd-analyze verify /etc/systemd/system/study-buddy.service
~~~

Do not start the public backend with raw `docker compose up` or `docker start`, because those paths bypass the guard. The unit and files are not installed or enabled yet; an administrator can bypass any host guard.

For a stopped, consistent backup, stop the single service and copy its entire data directory, including any WAL/SHM sidecars:

~~~sh
sudo systemctl stop study-buddy.service
install -d -m 700 ./backups
backup_dir="$(mktemp -d ./backups/study-buddy-data-XXXXXX)"
docker cp study-buddy-backend-1:/data/. "$backup_dir/"
~~~

Keep that backup private. For an application rollback without a destructive schema migration, keep the existing volume, point the root-owned service unit at the previous tested image tag, reload systemd, and start the service through the guarded unit. Do not bypass the guard with a direct Compose start:

~~~sh
sudo systemctl daemon-reload
sudo systemctl start study-buddy.service
~~~

The stopped backup is available if the volume must be restored. Do not use down -v: it removes the persistent volume.

Verified on diamondserver on 2026-10-19. Compose built image study-buddy/backend:review-20261019-container (ID sha256:b0cc82e5a83e7563d642c27945d43d1da90ad5566b3d73d89dc044580f8f1e81) from node:22.22.2-bookworm-slim, resolved to base digest sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e. The container started healthy with Node 22.22.2 and the built-in SQLite module, ran as UID 1000 with a read-only root, no Linux capabilities, no published host ports, with /data as a persistent writable volume and /tmp as an ephemeral writable tmpfs. The runtime /app contains only package.json and .backend-dist/server.js. An anonymous session renewed successfully after forced container recreation; SIGTERM returned exit 0 and health passed after restart. The temporary container, network and volume were removed; the review image remains on the build host. Sanitized inspect and smoke evidence: /tmp/study-buddy-container-inspect-20261019.json and /tmp/study-buddy-container-smoke-20261019.log. A 2 MiB unlisted capture plus a fake oddly named credential file stayed out of the allowlisted build context (1.31 kB transferred). The smoke used only a dummy runtime key and HMAC secret and did not call the provider or exercise generation/SSE. A later Compose-only hardening pass added init/SIGTERM grace handling and limits of 1 GiB memory with equal memswap limit (no swap), 2 CPUs, 128 PIDs, and rotating 10 MiB × 3 JSON logs; these effective settings were verified on the ephemeral container without provider calls. Four simultaneous 32 MiB JSON requests with an unsupported field each returned 400 before provider admission; the container stayed healthy, reported no OOM kill, and used about 240 MiB cgroup memory immediately afterward. The 240 MiB figure is a post-completion reading, not a measured peak. This synthetic body-pressure check exercises request reception, JSON parsing and early rejection only; it does not exercise admitted generations, provider serialization, stream buffers, or provider/SSE load. Treat 1 GiB as an initial engineering ceiling pending a fake-provider test with four admitted operations. npm ci printed one high-severity audit warning; no dependency change was made.

These checks establish packaging, session-state persistence, and the scoped host guard's tested packet paths only. They do not establish public reachability, ingress SSE behavior, live service operation, IPv6 packet enforcement, or a store release.

## Private laptop integration test (2026-10-20)

The merged backend is running as the user service study-buddy-backend.service on
homelab-laptop. It is bound only to 127.0.0.1:8787 and allowlists the current
unpacked Vivaldi extension origin chrome-extension://hlclddpmiehffbnjknfnjcaapeoihkbf.
The source checkout is /home/diamondsepticon/Projects/OCR-AI/study-buddy. The
installed extension copy is /home/diamondsepticon/Загрузки/Study-Buddy-Local;
main/dist is only the build output and is not the installed bundle. The installed
bundle points to http://127.0.0.1:8787. This is a private laptop integration
test, not the public deployment or packed store build.

The unit starts with the user systemd session and restarts on failure. Its
owner-only runtime env is ~/.config/study-buddy/private-backend.env; the
OpenRouter key is read from the existing credentials file when this env is
created and remains server-side. SESSION_HMAC_SECRET is persistent across
restarts. Operational state is in
~/.local/share/study-buddy/private/backend.sqlite (directory mode 0700, file
mode 0600). Run exactly one instance against this file.

~~~sh
systemctl --user start study-buddy-backend.service
systemctl --user stop study-buddy-backend.service
systemctl --user restart study-buddy-backend.service
systemctl --user status study-buddy-backend.service
journalctl --user -u study-buddy-backend.service -f
curl -fsS http://127.0.0.1:8787/health
~~~

To update from the main checkout, keep the private state and env outside the
repository. Make a stopped database backup before changing backend code, then
build and update the unpacked extension in place so Vivaldi retains its path and
ID. The pre-integration extension bundle is preserved at
~/.local/share/study-buddy/private/extension-rollback-20261020-0940.tar.

~~~sh
cd ~/Projects/OCR-AI/study-buddy
systemctl --user stop study-buddy-backend.service
tar -C ~/.local/share/study-buddy/private -cf ~/.local/share/study-buddy/private/backend-backup-pre-update.tar backend.sqlite*
chmod 600 ~/.local/share/study-buddy/private/backend-backup-pre-update.tar
npm run backend:build
STUDY_BUDDY_GATEWAY_URL=http://127.0.0.1:8787 npm run build
rsync -a --delete dist/ ~/Загрузки/Study-Buddy-Local/
systemctl --user start study-buddy-backend.service
curl -fsS http://127.0.0.1:8787/health
~~~

After copying the build, reload only Study Buddy from Vivaldi’s extension page
(or run chrome.runtime.reload() in its service-worker context), then check the
extension-origin /health request before making a controlled model request. Keep
the same installed extension and profile so local conversations, attachments
and settings remain available.

The current feature enforces a $5 monthly budget per anonymous installation and
a $100 monthly aggregate across this backend's database. Each generation
reserves $0.275. These limits cover requests routed through this service, not
other use of the OpenRouter account. The next UI session should branch from the
merged main baseline at 25df309; the private gateway is available for its
integration. Public domain/tunnel/DNS work, container deployment, and store
publication remain deferred.

The primary-agent live acceptance on 2026-10-20 reloaded the existing extension
in place with the same ID and confirmed localhost host permission plus an
extension-origin /health response of HTTP 200. The baseline retained 13 conversations, 12 attachments, and
English UI/answer-language settings. One UI conversation returned 42 from 17 + 25
and saved as complete. OpenRouter reported openai/gpt-6-luna usage of 211 prompt
and 103 completion tokens at $0.0000726. The same text call returned numeric-only
42, so it did not assess answer-language compliance. The following fixed Solve
image case routed successfully but the model answered 124 for 18 × 7; see the
[private live quality note](prompts-quality/private-live-2026-10-20.md). The input
image matched the stored attachment bytes, so no capture mismatch or image-quality
fix is claimed. The hidden-target screenshot attempt failed/timed out, so there is
no visual acceptance claim.

The architecture is one Node process and one SQLite file on persistent local
disk. Startup recovery assumes no other instance owns an active generation.

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
For the approved public-host direction and selected-but-not-deployed named Cloudflare Tunnel, see
[the Stage 1 hosting record above](#public-backend-stage-1-hosting-record-2026-10-19). Container packaging and an ephemeral guard test are complete, but neither the guard nor service is installed. Ingress, public deployment, and release are later stages.

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

Anonymous installation identities are durable server-issued subjects held by
an origin-bound local credential; expiring bearer sessions can be recovered for
the same installation. Clearing extension data, creating a new profile, or
reinstalling can create a new anonymous identity. There are no accounts or
cross-device recovery. Shared NATs share the 20 new-installation issuances per
IP/hour limit.

Each anonymous installation has a $5 budget per UTC calendar month. New
requests reserve $0.275; the reservation is replaced by trusted provider usage
when available. If a generation's usage is missing, its reservation remains
held until provider metadata confirms the final cost. This conservative reserve
means an installation with less than $0.275 remaining cannot start a request,
even if its eventual actual cost might be lower. A charge that exceeds its
reservation blocks further generations for that installation pending review.
The 10-second cooldown, one in-flight request per installation, four globally,
approximate input budget and per-task output caps remain additional controls.
There is no hidden queue, cloud history, or account billing.

The current 100,000-input-token policy keeps 20,000 in reserve and estimates one text token
per four UTF-8 bytes, with a separate allowance per image. Context selection retains the current task and source image, then adds recent complete exchanges under the token and 32 MiB request limits. Older exchanges remain locally saved and can be reused.
Provider-native text/image token counts can differ. Stop requests cancellation;
already processed upstream work can still be billed, and a lost final usage
chunk means unknown usage. Explicit Retry starts a new operation. Never
silently retry an ambiguous or partial generation.

Before publication, acquire and verify the domain/hostname, configure and test the named Tunnel, confirm the store
extension ID, complete support/privacy contact and audience decisions, reconcile
host/ingress/provider retention disclosures, and refresh store assets. Public
reachability, abuse/cost posture, and the streaming path must be accepted before
release. These are release actions, not evidence that this branch is deployed.

## Private laptop Haiku update (2026-10-21)

Implementation is committed locally as 2879aeb. The primary reviewed the source and independently passed both typechecks, all 20 backend contracts, context-estimator contracts, synthetic 125k text/same-image projection checks, and a rendered 320 x 568 Russian same-image context boundary check in a fresh agent-owned Chromium. The selected inputs were 75,316 and 76,340 estimated tokens; stored history stayed unchanged, current image was deduplicated on the current request, and preview matched canonical provider preparation.

The worker also passed API, storage and prompt contracts. The full isolated verify harness passed the changed request settings, valid-PNG 32 MiB history trimming, context/reuse and narrow RU/EN UI checks. It did not complete its final native-host lifecycle section: that fixture waited for a minimized host on a page without a chat root. This is not a full-suite pass. No real model-quality or paid-provider acceptance call was made.

The private service was stopped with no active generations. Its SQLite file was backed up before the additive expected_model migration; the original backend and installed extension were also retained at ~/.local/share/study-buddy/private/rollback-haiku-20261021T162403Z. The staged source hashes matched the reviewed source. Backend SHA-256 is b808d97abeb4efcfebb3344343a6a16ddaa081093c8a1e03660d5cca6210076d. The service restarted successfully and /health returned {"ok":true}. The single existing installation and all 25 charge records were retained.

The 71 installed extension files at ~/Загрузки/Study-Buddy-Local exactly match the staged release for http://127.0.0.1:8787. The user manually reloaded Study Buddy. Primary verified the existing live Vivaldi iframe loads chat-DAEyufdt.js from this release, sees 20 saved conversations and 20 attachments, and receives HTTP 200 from the backend health endpoint. No generation was active and no model call was made by this verification. Evidence: /tmp/study-buddy-haiku-20261021/live-activation.json. This is a private laptop update; public hosting and store release remain deferred. Detailed non-secret primary metrics and deployment receipts are in /tmp/study-buddy-haiku-20261021.


## Private laptop outside-click update (2026-10-21)

Implementation is committed locally as 56e59be. Primary independently passed typecheck, context contracts, and the native Chromium `verify:overlay-click` scenario with a fake provider. A private localhost:8787 release was rebuilt; the only changed installed artifact is content/overlay.js (SHA-256 586b3b8afac00416e6be9f8c76ade33cf7c61283918f4fdadcc45305e47b79c4). All 71 installed extension files match staging. The preceding overlay is backed up at ~/.local/share/study-buddy/private/rollback-outside-click-20261021T172655Z/overlay.js. Backend service and database were not changed.

Evidence and file hashes: /tmp/study-buddy-outside-click-20261021. The already verified live Haiku runtime predates this overlay update. Activation of the outside-click feature is pending an extension reload and a refresh of the host page; the agent did not reload a user website or discard its state. External iframe clicks remain outside this version, as recorded in the UI direction document.


## Private laptop tab-switch update (2026-10-21)

Implementation is committed locally as 45be73e. When an open panel tab becomes hidden, the existing Minimize path publishes the shared launcher state; another web tab can restore the same conversation while the source iframe remains mounted. Capture selection is excluded.

Primary independently passed typecheck, context contracts, and all four focused native browser scenario groups on an agent-owned Xvfb display in headed Chromium 151 (1280 x 800). The exact source/test snapshot was copied from the laptop; standalone Chromium plus connectOverCDP(noDefaults:true) avoids Playwright focus emulation, so actual native tab activation produced visible/hidden transitions. The fake-provider fixture checked cross-origin A-to-B restore, a late third tab, return to the source iframe, a continuing single request, capture selection, and Close cleanup. No real provider calls or user-browser changes were made. The full monolithic verify was not rerun; its shared-panel scenario was adapted for automatic minimize.

The private localhost:8787 release differs only in content/overlay.js, SHA-256 e692e403b53b72785994398e501c58961e0f63af2967e718e52169ac7cd14713. All 71 installed files match staging. The preceding overlay is retained at ~/.local/share/study-buddy/private/rollback-tab-switch-20261021T182000Z/overlay.js. Backend and database are unchanged; backend health returned ok. Evidence, primary-final.log and deployment.json are in /tmp/study-buddy-tab-switch-20261021 on the laptop (the isolated QA checkout/logs also exist under that path on the coordinator).

Live activation is pending extension reload and refresh of the web tabs being used. The agent did not reload a user website or discard page state.


## Private laptop context-notice UI update (2026-10-22)

Implementation is committed locally as a22a643. The notice below the six actions starts at 40,000 estimated tokens and adds the saved-but-unsent explanation when olderTask exclusions actually occur; the existing muted rows and in-thread boundary remain. The conversation title is 16px/650 in the main text color with a full-title tooltip. Context selection, backend limits and stored transcripts are unchanged.

Primary independently passed typecheck, context contracts and 33 rendered checks on an exact source snapshot in an agent-owned headless Chromium 151. The synthetic fixture checked 39,999/40,000/40,001 boundaries, RU/EN omission and actual projection IDs, short selected suffix after an oversized old exchange, draft/error/New chat resets, incomplete-reply false positives, unchanged saved history, title styling and 480x568/320x324 geometry. No model calls or page errors occurred. Screenshots were viewed; the default warning is 44.4px high and leaves a 313.6px thread. At 320x324 the compact RU/EN thread is 23.3/39.4px; the composer stays accessible. The full monolithic verify was not rerun. Worker additionally passed prompt and 16 API contract groups and the production build.

The keyless release keeps the same private localhost:8787 host permissions. All 71 installed extension files match staging and the tested source hashes match the committed files. The previous installed extension is backed up at ~/.local/share/study-buddy/private/rollback-context-ui-20261022T074022Z/extension.tar. Backend and database were not changed; health returned ok. Receipts and primary metrics/logs are in /tmp/study-buddy-context-ui-20261022 on the laptop; the coordinator directory of the same name also holds the isolated fixture and intentional user-preview screenshots.

Live activation remains pending an extension reload and refresh of the web tabs being used. No user-owned browser was manipulated.


## TEMPORARY manual context test — awaiting user check (2026-10-22)

User explicitly requested a temporary 5,000-token context window and 2,500-token advisory so the actual extension can be checked without building up 80k of chat. Source-only commit e0a35f0 adds a local projection cap and lowers the UI threshold. Backend metadata stays at 100,000 inputBudget/20,000 estimateHeadroom, so the existing client/server canonical comparison stays compatible; the server and output limits were not changed. The extension selects at most 5,000 estimated tokens for real requests.

Primary independently passed 33 synthetic rendered checks with the temporary values, including 2,499/2,500/2,501 boundaries, actual sliding exclusions, RU/EN state resets and unchanged saved history. No model calls occurred. Worker passed typecheck/context contracts and a projection fixture. All 71 installed files match staging. Evidence is in /tmp/study-buddy-temporary-context-20261022. Live activation is pending extension reload and refresh of used tabs.

RESTORE AFTER USER CONFIRMS CHECK: revert the two-file source commit e0a35f0, rebuild for http://127.0.0.1:8787 and reinstall the extension. Normal values are an effective 80,000-token context window and a 40,000-token advisory; do not restore early. The preceding production extension and durable restore receipt are at ~/.local/share/study-buddy/private/rollback-test-context-20261022T074938Z/{extension.tar,temporary-state.json}. No user history or database was changed. This temporary test is not a production policy decision.


## October 22 UI/test changes rolled back after regression report

User reported capture completing without opening chat, followed by unresponsive invocation. Stop live-browser experiments; no root cause was established. The primary restored all October 22 UI and temporary limit source changes in d3c2cc0; src now matches the prior 787cf3c state. Typecheck and context contracts passed. User changes under welcome/ were left untouched.

The installed extension was restored from ~/.local/share/study-buddy/private/rollback-context-ui-20261022T074022Z/extension.tar, from before the October 22 notice/title/test changes. All 71 files match that backup exactly. The displaced test build and receipt remain at ~/.local/share/study-buddy/private/before-restore-stable-20261022T080734Z. Backend/database were not changed. Activation requires extension reload and page refresh; post-rollback user behavior has not been verified.

The 5,000/2,500 test is cancelled and must not be re-enabled automatically. Effective context is back to 80,000; the new notice/title UI is removed. Earlier sections describing the October 22 test as awaiting a manual check are superseded by this rollback.
