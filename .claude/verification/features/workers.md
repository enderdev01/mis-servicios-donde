# Background workers and database scripts

## Background workers

In production they run in `apps/worker` as one `Scheduler` Durable Object alarm (plus an hourly cron that only re-arms a missing alarm). In `apps/api` they are three timers started by `main.ts`.

| Job | Rule | Check |
|---|---|---|
| Alert dispatch | Wakes after `ALERT_DISPATCH_INTERVAL_SECONDS` (30) while work is pending, when the next retry is due, or after `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS` (1800) when the outbox is empty. With dispatch off it cancels pending and retryable intents | `npm run test:unit --workspace @mis-servicios/worker` (observed: 55 passed) |
| Episode expiry | Every `EPISODE_EXPIRY_INTERVAL_SECONDS` (300; the Worker sets 3600) closes episodes past their lifetime | same |
| Retention | Only when `RETENTION_WORKER_ENABLED=true`; first run at the next midnight in Lima, then daily | same |

`apps/worker/src/scheduler/scheduler-core.spec.ts` covers the scheduling rules (one failing job never stops the others, the dispatch floor, retention disabled drops its schedule). The Durable Object itself and the real alarm are not covered by a unit test: check them on workerd with `npm run dev --workspace @mis-servicios/worker` against the Docker Postgres (`docker compose up -d postgres`), then watch `AlertIntent` rows change.

Edge cases: a failing cycle retries at the base interval; a contradictory idle interval below the dispatch interval is raised to it, with a startup warning.

## Database scripts (apps/api)

| Command | What it does | Observed |
|---|---|---|
| `npm run db:migrate:deploy --workspace @mis-servicios/api` | Applies the SQL migrations, baselines a database that already has the schema, fails on a checksum mismatch. Needs `npm run build` first | `Migrations complete (8 total).` |
| `npm run db:seed --workspace @mis-servicios/api` | Upserts the ten pilot zones, applies migrations when the schema is absent, refuses a database whose name ends in `_test` | `approved zones: brena, ... san-martin-de-porres` then `configuration: ready — intake accepts reports and the map publishes` |
| `npm run retention:purge --workspace @mis-servicios/api` | **Irreversible.** Deletes display names, reports, submissions, abuse records and outage episodes. Needs `CONFIRM_PILOT_PURGE=ERASE_PILOT_DATA` | Not run: never run it against data you want to keep |

All three read `DATABASE_URL`; the Docker default is `postgresql://mis_servicios:mis_servicios@127.0.0.1:54329/mis_servicios`. The integration suite (`npm run test:integration --workspace @mis-servicios/api`) uses `TEST_DATABASE_URL` and drops and recreates its own `_test` schema.
