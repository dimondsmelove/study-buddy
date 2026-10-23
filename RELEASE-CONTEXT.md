# Release implementation plan

**Дата:** 2026-10-23
**Состояние:** локальная кандидатная сборка; не готова к публикации.

Текущая сессия: сохранить этот план, затем отдельно разобрать ToDo.md/BACKLOG.md/PRODUCT.md; следующая сессия — реализация релиза по плану.

## Подтверждённое текущее состояние

- Исходники: src/. Текущая собранная кандидатная копия: /home/diamondsepticon/Projects/OCR-AI/study-buddy/dist. В ней backend URL http://127.0.0.1:8787; эта сборка не предназначена для CWS upload.
- Приватный backend service study-buddy-backend.service работает на homelab-laptop, слушает loopback. Точные разрешённые локальные origins: Vivaldi chrome-extension://hlclddpmiehffbnjknfnjcaapeoihkbf и unpacked dist chrome-extension://ldonfbgadhlcepfpgfnjoippdgickkco. Wildcard отсутствует. CORS не аутентифицирует API; серверные quotas/limits остаются обязательны.
- Origin check завершён: до изменения Vivaldi /health=200, dist=403; после изменения оба=200 с точным CORS origin; неизвестный origin=403, no-Origin=200. Секреты не записывались: [sanitized evidence](review/local-origin-check.json). Env backup owner-only сохранён рядом с private env вне repo.
- ID unpacked dist относится к текущему абсолютному пути и не является финальным CWS Item ID. Повторный build в той же папке dist не меняет ID; origins после каждого build обновлять не нужно. В manifest ещё нет CWS public key. Рекомендуемый порядок: загрузить draft ZIP без публикации, в Dashboard Package tab получить public key и сверить Item ID; затем внести key и пересобрать. Это рекомендация, не запрет на отдельный dev key. [Chrome manifest key docs](https://developer.chrome.com/docs/extensions/reference/manifest/key); [Chromium ID source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/extension.cc).
- Install flow уже открывает welcome с extension ID/pin state; welcome bridge запрашивает GET_PIN_STATE, worker проверяет sender origin/path. См. src/background/service-worker.ts, src/shared/welcome-pin.ts.
- Default welcome URL https://studybuddyai.one/welcome/ — compiled placeholder. Владение/выбор домена, DNS, Cloudflare zone и публичная доступность не проверялись.
- Manifest minimum Chrome 105 из-за CSS :has(); storage.session требует Chrome 102. Smoke был на HeadlessChrome 148, Chrome 105 не проверялся: [manifest evidence](review/manifest-readiness.json).
- Typecheck, main build, welcome contracts и isolated manifest/SW/i18n/resource smoke прошли. Единственный npm run verify подтвердил системный Copy без clipboardWrite, затем timeout 30s в minimized-chat/launcher сценарии, scripts/verify.mjs:1816:14. Причина не выяснена, suite не green: [failure log](review/npm-verify-failure.log).
- Текущий backend: anthropic/claude-haiku-5.5 via OpenRouter, без fallback; output cap 8,192. Input budget 100,000 estimated, reserve 20,000 (selected context около 80,000). Backend reserve $0.275/generation, $5/anonymous installation/month и $100/service/month, UTC. Реальный AI quality этими локальными проверками не подтверждён.
- Принято: будущий backend на diamondserver в Docker через named Cloudflare Tunnel; provider/HMAC secrets только server-side; бесплатное использование без аккаунта. Tunnel ещё не создан.
- Store metadata содержит 52 manifest locales; это не означает 52 языка UI или AI answers. Текущий study-buddy-welcome.zip содержит только welcome site, не extension package.

## План следующей сессии: реализация релиза

1. **Зафиксировать production identity.** Уточнить/подтвердить домен и hostname, владение/DNS control, Cloudflare account/zone, CWS draft Item ID и key. Не считать studybuddyai.one выбранным без подтверждения. Не менять принятый named Tunnel на прямой router HTTPS/Quick Tunnel.
2. **Собрать финальный extension config.** Применить подтверждённый CWS key/ID, публичный HTTPS backend URL, exact host permission, exact ALLOWED_ORIGINS, welcome URL и sender-origin allowlist. Пересобрать dist; проверить manifest, ID, ресурсы и отсутствие dev origin/loopback URL.
3. **Развернуть публичный backend.** Подготовить server-only secrets/env и Docker на diamondserver, настроить named Tunnel, DNS/HTTPS и exact CORS только для CWS origin. Проверить health/session, quotas, concurrency, restart/recovery и rollback. Не публиковать секреты в manifest, extension ZIP или logs.
4. **Проверить ingress и welcome bridge.** Tunnel не создан. Cloudflare документирует 125s Proxy Read Timeout; backend generation может ждать до 180s и не отправляет SSE heartbeat. Проверить quiet SSE и request/body limits end-to-end. На hosted welcome проверить install URL, GET_PIN_STATE sender origin/path, pin/unpin и отсутствие локальных endpoints.
5. **Закрыть acceptance.** Разобраться с зафиксированным verify timeout; выполнить полный verify, typecheck/build и clean Chrome acceptance: welcome открывается только при fresh install, не при update/restart; при pinned иконке показан usage-guide без шагов puzzle/pin; при unpinned показан pin-guide 1→2→3, manual mode selection имеет приоритет. Затем проверить capture, panel, minimize/restore и Copy. Mock/private checks можно выполнять в рамках этой работы. В следующей сессии выполнить короткий real-answer smoke в рамках согласованной проверки после quota reset; mock не является quality evidence.
6. **Подготовить CWS пакет.** После подтверждения актуальных product claims и store fields обновить listing/privacy/locales/screenshots; выбрать name, support/contact, privacy URL и audience. Создать ZIP только из deployable dist, проверить список файлов и clean install/update. Не включать review/, backend source/config, env, logs, базы, credentials. Перед submit показать готовый пакет и открыть отдельный review пользователю.

## Открытые входы, которые нужно получить до зависимых шагов

- Домен/hostname и подтверждение контроля над DNS; подтверждение Cloudflare account/zone.
- CWS draft/package Item ID и public key по рекомендуемому draft workflow.
- Финальные значения Store listing/privacy/contact/audience, подтверждённые по фактической реализации.
- Причина minimized-chat/launcher timeout из имеющегося verify failure.

Evidence: [origin CORS](review/local-origin-check.json), [manifest smoke](review/manifest-readiness.json), [verify timeout](review/npm-verify-failure.log). Production deploy, domain setup, store upload и real-provider check в этой сессии не выполнялись.
