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
| API | NestJS | Intake, publication, trust, notices, and workers |
| Contracts | TypeScript + Zod | Shared domain contracts |
| Data | PostgreSQL 17 + H3 | Pilot zones, aggregate cells, and operational records |
| Quality | Vitest + Playwright | Unit, integration, and browser verification |

```text
apps/api/           NestJS API, migrations, workers, seed, integration tests
apps/web/           Astro public-map client
packages/contracts/ shared types and validation schemas
docker/              local PostgreSQL initialization
```

## Quick start

1. Use Node.js 22.22.3 or later and install locked dependencies:

   ```sh
   npm ci
   ```

2. Start PostgreSQL 17. The container creates **two** databases: `mis_servicios` for development and `mis_servicios_test` for the integration suite.

   ```sh
   docker compose up -d --wait postgres
   ```

3. Create a local `.env` from the example, set at least `DEVICE_TOKEN_SECRET`, then seed and run:

   ```sh
   cp .env.example .env
   npm run build --workspace @mis-servicios/api
   npm run db:seed --workspace @mis-servicios/api
   npm run start --workspace @mis-servicios/api
   ```

   `.env` is gitignored and read natively through Node's `--env-file-if-exists`. Nothing loads it in production, where the platform supplies the environment.

4. Prove the checkout. These are the same commands CI runs:

   ```sh
   npm run check
   npm run test:integration
   npm run test:e2e
   npm run build
   ```

The integration suite resets the local test schema and applies every committed SQL migration. For a deployment, `npm run db:migrate:deploy --workspace @mis-servicios/api` applies those same committed files to the database named by `DATABASE_URL`: it takes an advisory lock so two deploys cannot run at once, records each migration with a checksum, and refuses to continue when a file changed after it was applied. Build first, because it runs the compiled runner and the copied migration files. Run it before enabling any product gate.

## Development data

The pilot only works with real data in place, and a half-seeded database is indistinguishable from a broken one: intake refuses every report when no approved zone contains the coordinates, and the public map publishes nothing unless at least two zones are approved.

```sh
npm run db:seed --workspace @mis-servicios/api
```

The seed applies migrations when the schema is absent, then upserts ten approved Lima districts: Breña, Cercado de Lima, Jesús María, Lince, Magdalena del Mar, Rímac, San Borja, San Isidro, San Juan de Lurigancho, and San Martín de Porres. It refuses to run against a database whose name ends in `_test`.

**The integration suite drops and recreates its schema on every run.** It reads `TEST_DATABASE_URL` and never falls back to `DATABASE_URL`, so a test run cannot reach development data no matter what the shell exports.

## Environment and secrets

Do not commit `.env` or secret values. Supply values through the process environment or your deployment secret manager.

| Variable | Required when | Purpose |
|---|---|---|
| `DATABASE_URL` | API, workers, seed | PostgreSQL connection for the running application. The Docker development default is in `.env.example`. |
| `TEST_DATABASE_URL` | integration tests only | Connection the integration suite drops and recreates. Defaults to `mis_servicios_test`; never falls back to `DATABASE_URL`. |
| `PORT` | API process | HTTP listening port; defaults to `3000`. |
| `INTAKE_ENABLED` | accepting reports | Must be exactly `true` before `POST /v1/reports` accepts data. |
| `PUBLIC_MAP_ENABLED` | publishing map cells | Must be exactly `true`; publication also requires a valid H3 resolution and two or more approved database zones. |
| `ALERT_DISPATCH_ENABLED` | delivering alerts | Must be exactly `true` to attempt Telegram delivery. Disabling it cancels pending and retryable intents. |
| `RETENTION_WORKER_ENABLED` | scheduled retention | Must be exactly `true` to run cleanup at the next midnight in Lima and then daily. |
| `H3_RESOLUTION` | intake and public map | Integer from `0` through `15`. There is no code default: while it is missing or invalid, intake refuses every report and the public map publishes nothing. |
| `ALERT_DISPATCH_INTERVAL_SECONDS` | optional | Shortest wait between dispatch cycles; the worker may wait longer when the outbox has nothing due. Positive integer, defaults to `30`. See [Database wake pattern](#database-wake-pattern) before deploying this default. |
| `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS` | optional | Longest wait between dispatch cycles when the outbox has nothing due; set it above the provider's idle-suspend window. Positive integer, defaults to `1800`. See [Database wake pattern](#database-wake-pattern). |
| `EPISODE_EXPIRY_INTERVAL_SECONDS` | optional | How often the expiry worker closes elapsed episodes. Positive integer, defaults to `300`. See [Database wake pattern](#database-wake-pattern). |
| `DB_POOL_MAX` | optional | Maximum PostgreSQL connections per API instance; defaults to `10`. |
| `DB_IDLE_TIMEOUT_MS` | optional | Time before an idle PostgreSQL connection closes; defaults to `30000`. |
| `DB_CONNECTION_TIMEOUT_MS` | optional | Maximum time to establish a PostgreSQL connection; defaults to `5000`. |
| `WEB_ORIGIN` | optional | Explicit browser origin allowed by API CORS. Leave empty when Vercel proxies the API same-origin. |
| `RATE_LIMIT_MAX` | optional | Global requests per IP window; defaults to `120`. In-memory and single-instance. |
| `RATE_LIMIT_WINDOW_MS` | optional | Global rate-limit window; defaults to `60000`. |
| `REPORT_RATE_LIMIT_MAX` | optional | `POST /v1/reports` requests per IP window; defaults to `5`. |
| `REPORT_RATE_LIMIT_WINDOW_MS` | optional | Report submission rate-limit window; defaults to `3600000`. |
| `RATE_LIMIT_MAX_KEYS` | optional | Maximum in-memory rate-limit keys; defaults to `10000`. |
| `DEVICE_TOKEN_SECRET` | intake | HMAC secret used to derive pseudonymous device tokens. There is no code default: while it is missing or blank, intake refuses every report. Rotate only with a planned token-version migration. |
| `TELEGRAM_BOT_TOKEN` | alert dispatch | Telegram bot credential. |
| `TELEGRAM_CHAT_ID` | alert dispatch | Destination channel or chat identifier. |

Zone approval comes from `PilotZone` rows in PostgreSQL, never from configuration. The development seed is only a reproducible source for those rows. Every approved zone must carry an explicit bounding-box `boundary`; a zone without one matches no report. Bounding boxes are intentionally coarse operational coverage, not administrative polygons: the first-wave boxes have 18 positive-area intersections between neighbouring districts, so they must not be used to make precise district-attribution claims. Replace them with validated polygons before relying on border-level classification.

## Gates and workers

Keep every product gate `false` until the release checks and privacy review are complete.

The API also rejects oversized JSON bodies, applies security headers, enforces a 15-second request timeout, and returns `429` after the configured per-IP limits. The limiter is intentionally bounded but local to one instance; migrate it to Redis/Upstash before horizontal scaling.

| Surface | Enable condition | Disable / rollback effect |
|---|---|---|
| Intake | `INTAKE_ENABLED=true` | New reports receive the generic unavailable response and are not persisted. |
| Public map | `PUBLIC_MAP_ENABLED=true`, valid H3 resolution, 2–3 approved zones | `GET /v1/cells` returns an empty list. |
| Telegram dispatch | `ALERT_DISPATCH_ENABLED=true` plus both Telegram secrets | Pending and retryable intents are cancelled; accepted reports remain independent of provider delivery. |
| Retention | `RETENTION_WORKER_ENABLED=true` | Cleanup runs at the next midnight in Lima, then daily; keep it enabled after data collection begins. |

The outbox creates one durable opening intent per episode transition and retries Telegram failures with bounded exponential backoff. Delivery is **at least once**; an external provider can still receive a duplicate, so do not claim exactly-once delivery.

### Background workers

The API process starts three workers. Each re-arms only after its previous cycle settles, so a slow cycle never overlaps itself, and a failed cycle is retried on the next tick instead of ending the worker.

| Worker | Starts when | Cycle |
|---|---|---|
| Alert dispatch | always | Claims due intents and delivers them while `ALERT_DISPATCH_ENABLED=true`; cancels pending and retryable intents while it is not. Sleeps between the dispatch interval and the idle interval depending on what the outbox needs (see [Database wake pattern](#database-wake-pattern)). |
| Episode expiry | always | Closes episodes whose lifetime elapsed. Public reads already hide them by expiry, so this only materialises that closure. |
| Retention cleanup | `RETENTION_WORKER_ENABLED=true` | Deletes records past their retention window. |

> **Enable dispatch before intake.** The dispatch worker runs continuously and its disabled branch cancels pending intents. If intake is enabled first, every episode that opens before dispatch is enabled has its alert cancelled at the worker's next wake — at most one idle interval later, 30 minutes with the defaults — and that alert is not recoverable.

#### Database wake pattern

Both always-on workers query the database on a timer, and the API process is long-running. A short interval keeps the database awake: with the original default `ALERT_DISPATCH_INTERVAL_SECONDS=30` the dispatch worker queried the outbox twice a minute, so a managed provider that suspends an idle compute after a few minutes of inactivity never reached that window.

The dispatch worker no longer polls on one fixed interval. Each cycle reports what the outbox needs, and the worker schedules its next wake between two bounds, `ALERT_DISPATCH_INTERVAL_SECONDS` (default `30`) and `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS` (default `1800`, 30 minutes):

- The cycle claimed work: wake again after the dispatch interval, so an in-progress incident keeps its dispatch latency.
- Intents exist but none is due yet (a retry backoff or an abandoned lease): wake when the earliest one becomes due.
- Nothing is due: wake after the idle interval.

The wait is never shorter than the dispatch interval, and the dispatch interval wins unconditionally: when `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS` is configured below `ALERT_DISPATCH_INTERVAL_SECONDS`, the effective idle ceiling is the dispatch interval for every cycle (with a one-time warning naming both variables) rather than the shorter configured value being allowed to shorten the wait. A retry can never be lost to an unbounded wait. An outbox that stays empty therefore wakes once per idle interval — or once per dispatch interval when the idle interval is configured below it — instead of twice a minute, and the database can finally reach its suspend window.

That cost was real and it hides well. A provider that suspends after five minutes and meters a monthly compute-hour allowance will exhaust it while the application looks idle. On providers that also expose database branching, the deployment step that creates a branch per preview then fails, which surfaces to a reader as a generic `500` from every database-backed endpoint — not as a deployment error anyone would connect to the database.

Keep `ALERT_DISPATCH_INTERVAL_SECONDS` short for incident latency; the wake budget belongs to the idle interval. Set `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS` above the suspend window and never equal to it: five minutes against a five-minute window still keeps the compute awake. Set both in the deployment environment, not in the repository: the suspend window is a property of the provider you deploy to, and a value committed to the repository would silently govern every environment, including ones that suspend differently.

The remaining trade-off is bounded: an opening alert created while the worker sleeps waits until the next wake, so an alert can be delayed by up to one idle interval (30 minutes with the default) instead of one dispatch interval. That is minor next to the episode time scales already in force (`OUTAGE_QUORUM_WINDOW_MINUTES` defaults to 60 minutes and `OUTAGE_EPISODE_LIFETIME_HOURS` to 6); lower `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS` when alert latency matters more than compute, keeping it above the suspend window. Retention cleanup is unaffected because it is gated and runs daily.

On the free plan, also stop preview deployments from creating their own database branch. Point previews at the shared development branch; otherwise every preview holds compute active against the same allowance as the deployed environment. Delete the branches that accumulated before the change, then verify the fix with one preview deployment by checking two things: the database branch count no longer grows by one per deployment, and the deployment log no longer contains a branch-creation step.

## Database provider

The API needs one PostgreSQL instance reachable from the API host. The schema uses no provider-specific extension, so any managed PostgreSQL fits. What differs between providers is how they meter an always-on application: a provider that suspends an idle compute and budgets monthly compute hours behaves very differently from one that suspends a project only after a long inactivity window. Read [Database wake pattern](#database-wake-pattern) before choosing, and keep the interval variables above whichever suspend window applies.

### Moving to another provider

1. Create the database, then copy its **pooled** connection string. A provider whose direct endpoint is IPv6-only, Supabase among them, needs its pooler to be reachable from an IPv4 host.
2. Set `DATABASE_URL` to that string in the deployment environment. Never commit it.
3. Build, apply the schema, then load the pilot zones:

```sh
npm run build --workspace @mis-servicios/api
DATABASE_URL="<pooled-connection-string>" npm run db:migrate:deploy --workspace @mis-servicios/api
DATABASE_URL="<pooled-connection-string>" npm run db:seed --workspace @mis-servicios/api
```

4. Verify all three endpoints before re-enabling any gate:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$API/health"    # 200
curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/cells"  # 200, empty list or data — never 500
curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/zones"  # 200
```

A `500` from either data endpoint means the API cannot reach the database, not that the schema is wrong: the health route answers without a query, so it stays green while both data routes fail. An empty `/v1/zones` means the seed did not run, and publication stays at zero without approved zones.

### Notes that save time

- The migration runner **baselines** a database that already carries the schema but records no migration history, instead of reapplying every file. That is what makes a restored dump or a copied database safe to point at.
- It fails on a checksum mismatch by design. Never edit a migration that has already been applied; add a new one.
- Moving providers does not change the product gates. Keep them disabled until the three checks above return `200`.

## Privacy and retention

- Coordinates are used to derive an H3 cell and must never be persisted or logged.
- Optional display names are erased after 24 hours.
- Immutable report events stop contributing to the public map after 48 hours and are physically deleted by the next midnight cleanup.
- Abuse, idempotency, and alert records are deleted after 30 days.
- Public cells expose only H3 cell and service, never device tokens, display names, coordinates, or event timestamps.

### Irreversible pilot purge

Use this only for an approved rollback or privacy incident. It deletes display names, report events, submission/idempotency records, abuse records, outage episodes, and cascaded alert intents. It preserves pilot-zone configuration and cannot restore deleted data.

```sh
npm run build --workspace @mis-servicios/api
CONFIRM_PILOT_PURGE=ERASE_PILOT_DATA npm run retention:purge --workspace @mis-servicios/api
```

The confirmation value is intentionally exact. Do not run this command in a shell history that records secrets or operational approvals.

## Rollout and rollback

### Rollout checklist

1. Apply reviewed SQL migrations through the deployment platform.
2. Create and approve two or more pilot zones, set a valid H3 resolution, and provide `DEVICE_TOKEN_SECRET` plus Telegram secrets.
3. Deploy with every product gate disabled; run the commands in [Release evidence](#release-evidence).
4. Enable the public map, then intake, then dispatch. Monitor retryable alerts and retention cleanup.

### Independent rollback boundaries

1. **Dispatch:** set `ALERT_DISPATCH_ENABLED=false`; this cancels pending/retryable intents without rejecting reports.
2. **Intake:** set `INTAKE_ENABLED=false`; this blocks new reports without removing existing data.
3. **Publication:** set `PUBLIC_MAP_ENABLED=false`; this returns an empty map while reports and retention remain available.
4. **Privacy rollback:** run the guarded purge only when irreversible deletion is approved; leave retention enabled afterward.

The static web preview and API are independently tested in this repository. A production reverse proxy or API-origin configuration is not included here; provide one before deploying the browser client.

## Release evidence

The following commands are the repository's CI-equivalent checks:

```sh
npm run check
npm run test:integration
npm run test:e2e
npm run build
docker compose config --quiet
npm audit --omit=dev
```

Expected evidence is lint and workspace type checks, unit tests, PostgreSQL/Supertest integration flows, Playwright browser flows, production builds, valid Compose configuration, and no production dependency vulnerabilities. Run them after any gate, worker, migration, or operational change.
