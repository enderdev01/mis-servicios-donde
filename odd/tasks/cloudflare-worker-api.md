# mis-servicios API → Cloudflare Workers

## Objective

Run the mis-servicios API (today NestJS + Express + `pg` on Railway) as a Cloudflare Worker for production,
keeping the HTTP contract, the SQL, the product gates and the privacy rules unchanged. The Postgres database
stays where it is (Neon, per repo docs); the Worker reaches it through Hyperdrive.

## Problem / why

- The user wants production on Cloudflare. The pilot is only in preview today (Vercel web proxying `/v1/*` to a
  Railway `develop` host). The Railway service in project `adorable-unity` has only `DATABASE_URL`, no public
  domain, so nothing public depends on it.
- Nest + Express do not run on workerd, and the API has three always-on timers (alert dispatch, episode expiry,
  retention). On Workers they become Durable Object alarms so the Neon wake budget logic is preserved
  (30 s while work is pending, up to 30 min idle).

## Scope (authorized)

- New workspace `apps/worker` (`@mis-servicios/worker`). `apps/api` stays as the reference implementation and
  the source of the SQL and the unit specs. Do NOT delete or edit `apps/api`, `apps/web`, Railway, Vercel.
- Routes: `GET /health`, `POST /v1/reports`, `GET /v1/cells`, `GET /v1/zones`, `GET /v1/zones/:slug/notice`.
- Workers: dispatch (adaptive), episode expiry, retention (only if `RETENTION_WORKER_ENABLED=true`).
- Production deploy needs the user for secrets and the database connection (see Constraints).

## Design decisions

- **Code reuse**: SQL and domain functions are copied verbatim from `apps/api` with Nest decorators and
  `process.env` reads removed; services receive a `Database` and a typed `Config` built from the Worker `env`.
  The API is retired after cutover, so the copy is temporary.
- **Database**: `pg.Client` through Hyperdrive. `query()` uses one lazily connected client per request;
  `connect()` opens a dedicated client (transactions, advisory xact locks, `FOR UPDATE SKIP LOCKED` keep working
  because Hyperdrive pools in transaction mode). Session advisory locks are only used by the migration CLI,
  which stays a Node script and is not part of the Worker.
- **Scheduling**: one `Scheduler` Durable Object (singleton) holds the next run of each job in storage and sets a
  single alarm to the earliest. An hourly Cron Trigger only re-arms a missing alarm (no database query).
- **Rate limits**: global 120 requests per 60 s per IP with the Workers Rate Limiting binding; the report limit
  (5 per hour per IP) needs a window longer than the binding allows, so it is a per-IP Durable Object counter.
- **HTTP hardening**: `secureHeaders` instead of helmet, 10 kB body limit, optional CORS from `WEB_ORIGIN`.
- **Config (revised)**: `nodejs_compat` populates `process.env` from vars and secrets, so the copied services and their specs
  keep reading `process.env` unchanged. Anything that must not depend on module-load order (scheduler intervals) is read at
  alarm time. Verified on workerd: gates, `DEVICE_TOKEN_SECRET` and the quorum constants all resolve.

## Constraints

- Strict TDD (`openspec/config.yaml`): RED before GREEN for new behavior. Copied specs keep passing as they are moved.
- Delivery strategy `ask-on-risk`: no commit, push or PR without explicit authorization.
- Coordinates are never persisted or logged; product gates stay `false` until the user enables them in order:
  public map, intake, dispatch (README "Enable dispatch before intake").
- Secrets (`DATABASE_URL`, `DEVICE_TOKEN_SECRET`, `TELEGRAM_BOT_TOKEN`) are set by the user, never read or printed.
- Runner: `npm run test:unit --workspace @mis-servicios/worker` (Vitest). Integration against the repo's Postgres 17
  fixture (`docker compose up -d postgres`, port 54329) for the end-to-end check.

## Tasks

- [x] T1 Scaffold `apps/worker`: package, tsconfig, `wrangler.jsonc`, dependencies
- [x] T2 Port pure/domain modules with their specs (trust, consensus policy, report input, alert helpers, retention schedule, notices)
- [x] T3 `DatabasePool` over Hyperdrive; configuration stays on `process.env` (see decision below)
- [x] T4 Port services (reports, consensus, alerts, public cells, notices, retention) with SQL unchanged
- [x] T5 Hono app: routes, error mapping, security headers, body limit, CORS, rate limits (tests first)
- [x] T6 `Scheduler` Durable Object: adaptive dispatch, expiry, retention (tests first)
- [x] T7 Verify: typecheck, lint, unit tests, bundle dry run, local workerd against the Postgres fixture
- [x] T8 Deploy `mis-servicios-api` to Cloudflare; Hyperdrive on a new Neon project; live smoke with gates off
- [x] T9 Cutover prep: `apps/web/vercel.json` rewrites point at the Worker (uncommitted, web not redeployed); gate order documented; Railway left untouched

## Acceptance criteria

- Typecheck and unit tests pass for the worker.
- Against the local Postgres fixture: `/health` 200; `/v1/zones` lists approved zones; with gates on, three devices
  reporting an outage in one zone open an episode and `/v1/cells` returns it; the same device within an hour gets
  `already_reported`; gates off → generic 400 and empty cells.
- The scheduler alarm runs dispatch/expiry and re-arms with the same delays as `dispatchCycleDelayMs`.
- Live: `/health` 200 and `/v1/cells` empty array with gates off.

## Progress

- 2026-10-31: Explored the API (about 1,500 non-spec lines) and Railway config. Plan written.
- 2026-10-31: T1-T7 done on branch `feat/cloudflare-worker-api`. Worker README documents the production deploy (T9 partial).

## Verification evidence

- `npm run test:unit -w @mis-servicios/worker` → 55 passed (10 files): 31 copied from `apps/api` (moved, still green), 24 new written RED first
  (scheduler core, window counter, app routes). `npm run typecheck` and `npx eslint apps/worker` clean. `npm run build` (wrangler dry run): 1.58 MiB, 266 KiB gzip.
- Local workerd (`wrangler dev`) against the repo Postgres 17 fixture with 10 seeded zones, gates on: 3 devices reporting an outage in Lince → episode opens →
  `/v1/cells?service=water` returns `confirmed: true, reports: 3`; same device again → 409 `already_reported`; replay of the same submission → 201; outside every
  zone and invalid body → generic 400; unknown zone notice → 404; 6th report from one IP → 429; security headers present; `/v1/zones` lists 10 zones.
- Scheduler alarm on workerd: with dispatch off, a pending `AlertIntent` created by the quorum was `cancelled` by the alarm within the configured 5 s interval.
- Production (2026-10-31): the old Neon database (endpoint of the Railway DATABASE_URL) no longer exists in the account (password auth failed; no project holds the `PilotZone` table).
  New Neon project `mis-servicios-db` (id sweet-tree-02655556, aws-us-east-1, 0.25 CU) created through the Vercel integration because the Neon org is Vercel-managed;
  8 migrations applied and 10 zones seeded with the apps/api CLI over the direct connection. Hyperdrive config `mis-servicios-db` (direct string, id 3403ac486e5943ad9d548019ecdcc873).
  Worker https://mis-servicios-api.onilabs-dev.workers.dev (versions b30ce903, then 636de197 with EPISODE_EXPIRY_INTERVAL_SECONDS=3600). `DEVICE_TOKEN_SECRET` was generated and uploaded without being displayed.
  Live, gates off: `/health` 200, `/v1/zones` 10 zones through Hyperdrive, `/v1/cells` `[]`, notice 200, `POST /v1/reports` generic 400, security headers present.
- Not verified live: Hyperdrive (local fixture only), the Workers Rate Limiting binding on Cloudflare (simulated locally), Telegram delivery,
  retention at the real Lima midnight, behaviour under a Neon-suspended database.

## Next step

Enable the gates in order (map, intake, dispatch, retention) once Telegram secrets exist; commit and push so Vercel redeploys the web; retire the Railway service.
