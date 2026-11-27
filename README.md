# Mis Servicios

**Mis Servicios** is a privacy-first pilot for community-reported outages of water, electricity, and internet. It helps neighbours see whether a disruption is affecting an approved pilot zone—without presenting community reports as provider-confirmed information.

> **Unofficial data.** Publish only approved pilot zones, never imply provider confirmation, and never promise exactly-once alert delivery.

## Product value

An isolated report is hard to interpret. The pilot groups short-lived, pseudonymous reports by H3 cell and service so that the public map can reveal corroborated local patterns while keeping exact locations, device tokens, names, and report timestamps out of the published data.

## Main capabilities

- Community intake for water, electricity, and internet disruptions.
- Public map that only exposes approved pilot zones and aggregate H3 cells.
- Corroboration flow that distinguishes pending reports from confirmed outage episodes.
- Optional Telegram alert dispatch through a durable outbox with bounded retries.
- Privacy and retention workers for expiry and deletion.
- Product gates that independently control intake, public publication, alerting, and retention.

## User flow

1. A resident submits an outage report while intake is enabled and their location falls inside an approved pilot zone.
2. The API derives an H3 cell; it does not persist or publish the precise coordinates.
3. Corroborating reports can form an outage episode.
4. The browser map shows permitted aggregate cells, and the alert worker may notify Telegram when dispatch is enabled.

## Architecture and stack

| Layer | Technology | Responsibility |
|---|---|---|
| Web | Astro + Leaflet | Map and browser reporting experience |
| API | Hono on a Cloudflare Worker | Intake, publication, trust, notices, and workers |
| Contracts | TypeScript + Zod | Shared domain contracts |
| Data | Cloudflare D1 (SQLite) + H3 | Pilot zones, aggregate cells, and operational records |
| Quality | Vitest + Playwright | Unit, D1 integration, and browser verification |

```text
apps/worker/        Worker API, D1 migrations, Durable Object workers, tests
apps/web/           Astro public-map client
packages/contracts/ shared types and validation schemas
```

## Quick start

1. Use Node.js 22.22.3 or later and install locked dependencies:

   ```sh
   npm ci
   ```

2. Apply the D1 migrations to the local database (the schema and the ten pilot zones) and run the Worker:

   ```sh
   npm run db:migrate:local -w @mis-servicios/worker
   npm run dev -w @mis-servicios/worker -- --var INTAKE_ENABLED:true --var RETENTION_WORKER_ENABLED:true --var PUBLIC_MAP_ENABLED:true --var DEVICE_TOKEN_SECRET:local-only
   ```

   The Worker listens on `http://127.0.0.1:8787`. See [apps/worker/README.md](apps/worker/README.md).

3. Prove the checkout. These are the same commands CI runs:

   ```sh
   npm run check
   npm run test:e2e
   npm run build
   ```

   `npm run check` includes the Worker's D1 integration tests, which run on workerd and need no database service.

## Pilot data

The pilot only works with real data in place: intake refuses every report when no approved zone contains the coordinates, and the public map publishes nothing unless at least two zones are approved.

Migration `0002_pilot_zones.sql` inserts ten approved Lima districts: Breña, Cercado de Lima, Jesús María, Lince, Magdalena del Mar, Rímac, San Borja, San Isidro, San Juan de Lurigancho, and San Martín de Porres. Applying the migrations is the whole seed. Never edit an applied migration; add a new one.

## Environment and secrets

Do not commit `.env` or secret values. Locally, pass values with `--var` or a `.dev.vars` file; in production use `vars` in `apps/worker/wrangler.jsonc` and `wrangler secret put`.

| Variable | Required when | Purpose |
|---|---|---|
| `INTAKE_ENABLED` | accepting reports | Must be exactly `true`, together with `RETENTION_WORKER_ENABLED`, before `POST /v1/reports` accepts data. |
| `PUBLIC_MAP_ENABLED` | publishing map cells | Must be exactly `true`; publication also requires a valid H3 resolution and two or more approved database zones. |
| `ALERT_DISPATCH_ENABLED` | delivering alerts | Must be exactly `true` to attempt Telegram delivery. Disabling it pauses delivery and leaves pending and retryable intents untouched; they are sent once it is `true` again, unless retention (30 days) removes them first. |
| `RETENTION_WORKER_ENABLED` | scheduled retention | Must be exactly `true` to run cleanup at the next midnight in Lima and then daily. |
| `H3_RESOLUTION` | intake and public map | Integer from `0` through `15`. There is no code default: while it is missing or invalid, intake refuses every report and the public map publishes nothing. |
| `ALERT_DISPATCH_INTERVAL_SECONDS` | optional | Shortest wait between dispatch cycles; the scheduler may wait longer when the outbox has nothing due. Positive integer, defaults to `30`. |
| `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS` | optional | Longest wait between dispatch cycles when the outbox has nothing due. Positive integer, defaults to `1800`. |
| `EPISODE_EXPIRY_INTERVAL_SECONDS` | optional | How often the expiry job closes elapsed episodes. Positive integer, defaults to `300`; `wrangler.jsonc` sets `3600`. |
| `WEB_ORIGIN` | optional | Explicit browser origin allowed by API CORS. Leave empty when Vercel proxies the API same-origin. |
| `REPORT_RATE_LIMIT_MAX` | optional | `POST /v1/reports` requests per client IP window; defaults to `60`, so a household or shared mobile network is not locked out. |
| `REPORT_RATE_LIMIT_WINDOW_MS` | optional | Per-IP report window; defaults to `3600000`. |
| `DEVICE_REPORT_RATE_LIMIT_MAX` | optional | `POST /v1/reports` requests per signed device id window; defaults to `5`. |
| `DEVICE_REPORT_RATE_LIMIT_WINDOW_MS` | optional | Per-device report window; defaults to `3600000`. |
| `DEVICE_ISSUE_RATE_LIMIT_MAX` | optional | `POST /v1/device` requests per client IP window; defaults to `60`. |
| `DEVICE_ISSUE_RATE_LIMIT_WINDOW_MS` | optional | Device-id issuing window; defaults to `3600000`. |
| `DEVICE_TOKEN_SECRET` | intake | HMAC secret that signs the device ids the Worker issues and derives the pseudonymous device tokens. There is no code default: while it is missing or blank, intake refuses every report. Rotate only with a planned token-version migration. |
| `TELEGRAM_BOT_TOKEN` | alert dispatch | Telegram bot credential. |
| `TELEGRAM_CHAT_ID` | alert dispatch | Destination channel or chat identifier. |

The global per-IP limit (120 requests per 60 s) is a Workers Rate Limiting binding in `wrangler.jsonc`, not an environment variable.

Zone approval comes from `PilotZone` rows in D1, never from configuration. Every approved zone must carry an explicit bounding-box `boundary`; a zone without one matches no report. Bounding boxes are intentionally coarse operational coverage, not administrative polygons: the first-wave boxes have 18 positive-area intersections between neighbouring districts, so they must not be used to make precise district-attribution claims. Replace them with validated polygons before relying on border-level classification.

## Gates and workers

Keep every product gate `false` until the release checks and privacy review are complete.

The API also rejects oversized JSON bodies, applies security headers, and returns `429` after the configured limits.

Device identity: the browser does not choose its own device id. `POST /v1/device` answers `201 { "deviceId": "<uuid>.<signature>" }`, signed with `DEVICE_TOKEN_SECRET` (HMAC-SHA256, stateless, never expires; it works even while intake is paused, and answers `503 device_unavailable` when the secret is missing). `POST /v1/reports` must carry that id: a missing, bare or tampered one answers `401 device_invalid` and the web app then fetches a new id and retries once. Limits per hour, all answering `429 rate_limited` with `Retry-After` and `retryAfterSeconds`: 60 reports per client IP, 5 reports per signed device, 60 issued ids per client IP.

| Surface | Enable condition | Disable / rollback effect |
|---|---|---|
| Intake | `INTAKE_ENABLED=true` and `RETENTION_WORKER_ENABLED=true` | New reports receive the generic unavailable response and are not persisted. |
| Public map | `PUBLIC_MAP_ENABLED=true`, valid H3 resolution, 2–3 approved zones | `GET /v1/cells` returns an empty list. |
| Telegram dispatch | `ALERT_DISPATCH_ENABLED=true` plus both Telegram secrets | Pending and retryable intents wait untouched; accepted reports remain independent of provider delivery. |
| Retention | `RETENTION_WORKER_ENABLED=true` | Cleanup runs at the next midnight in Lima, then daily; keep it enabled after data collection begins. |

The outbox creates one durable opening intent per episode transition and retries Telegram failures with bounded exponential backoff. Delivery is **at least once**; an external provider can still receive a duplicate, so do not claim exactly-once delivery.

### Background workers

One `Scheduler` Durable Object alarm runs three jobs. Each re-arms only after its previous cycle settles, and a failing job never stops the others. An hourly cron only re-arms a missing alarm.

| Job | Runs when | Cycle |
|---|---|---|
| Alert dispatch | always | Claims due intents and delivers them while `ALERT_DISPATCH_ENABLED=true`; leaves the outbox untouched while it is not. A failed send is retried with backoff and marked `failed` (logged with `console.error`, never claimed again) after 8 attempts. Wakes after the dispatch interval while work is pending, when the next retry is due, or after the idle interval when the outbox is empty. |
| Episode expiry | always | Closes episodes whose lifetime elapsed. Public reads already hide them by expiry, so this only materialises that closure. |
| Retention cleanup | `RETENTION_WORKER_ENABLED=true` | Deletes records past their retention window. |

> **Enable dispatch before intake.** While dispatch is disabled, alerts queue up unsent. If intake is enabled first, alerts for episodes opened in the meantime are delivered late (up to one idle interval after enabling), possibly after the outage ended.

An opening alert created while the scheduler sleeps waits until the next wake, up to one idle interval (30 minutes with the default). That is minor next to the episode time scales already in force (`OUTAGE_QUORUM_WINDOW_MINUTES` defaults to 60 minutes and `OUTAGE_EPISODE_LIFETIME_HOURS` to 6); lower `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS` when alert latency matters more.

## Deploying the Worker

Production runs `apps/worker` on Cloudflare Workers with D1. [apps/worker/README.md](apps/worker/README.md) has the steps: create the D1 database, apply the migrations with `npm run db:migrate:remote -w @mis-servicios/worker`, set the secrets, and deploy. Verify all three endpoints before enabling any gate:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$API/health"    # 200
curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/cells"  # 200, empty list or data — never 500
curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/zones"  # 200
```

A `500` from either data endpoint means the Worker cannot reach D1 (migrations not applied, or a wrong `database_id`): the health route answers without a query, so it stays green while both data routes fail. An empty `/v1/zones` means migration `0002` did not run, and publication stays at zero without approved zones.

## Privacy and retention

- Coordinates are used to derive an H3 cell and must never be persisted or logged.
- Optional display names are erased after 24 hours.
- Immutable report events stop contributing to the public map after 48 hours and are physically deleted by the next midnight cleanup.
- Abuse, idempotency, and alert records are deleted after 30 days.
- Public cells expose only H3 cell and service, never device tokens, display names, coordinates, or event timestamps.

## Rollout and rollback

### Rollout checklist

1. Apply the D1 migrations (`npm run db:migrate:remote -w @mis-servicios/worker`).
2. Confirm two or more approved pilot zones, set a valid H3 resolution, and provide `DEVICE_TOKEN_SECRET` plus Telegram secrets.
3. Deploy with every product gate disabled; run the commands in [Release evidence](#release-evidence).
4. Enable the public map, then dispatch, then intake. Monitor retryable alerts and retention cleanup.

### Independent rollback boundaries

1. **Dispatch:** set `ALERT_DISPATCH_ENABLED=false`; this pauses delivery (intents stay queued) without rejecting reports.
2. **Intake:** set `INTAKE_ENABLED=false`; this blocks new reports without removing existing data.
3. **Publication:** set `PUBLIC_MAP_ENABLED=false`; this returns an empty map while reports and retention remain available.
4. **Privacy rollback:** delete the report data in D1 (`wrangler d1 execute`) only when irreversible deletion is approved, keep the pilot-zone rows, and leave retention enabled afterward.

The static web preview and API are independently tested in this repository. A production reverse proxy or API-origin configuration is not included here; provide one before deploying the browser client.

## Release evidence

The following commands are the repository's CI-equivalent checks:

```sh
npm run check
npm run test:e2e
npm run build
npm audit --omit=dev
```

Expected evidence is lint and workspace type checks, unit and D1 integration tests, Playwright browser flows, production builds, and no production dependency vulnerabilities. Run them after any gate, worker, migration, or operational change.
