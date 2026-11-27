# Background workers and D1 migrations

## Background workers

They run in `apps/worker` as one `Scheduler` Durable Object alarm (plus an hourly cron that only re-arms a missing alarm).

| Job | Rule | Check |
|---|---|---|
| Alert dispatch | Wakes after `ALERT_DISPATCH_INTERVAL_SECONDS` (30) while work is pending, when the next retry is due, or after `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS` (1800) when the outbox is empty. With dispatch off it leaves the outbox untouched; after 8 failed sends an intent becomes `failed` and is never claimed again | `npm run test:unit --workspace @mis-servicios/worker` |
| Episode expiry | Every `EPISODE_EXPIRY_INTERVAL_SECONDS` (300; the Worker sets 3600) closes episodes past their lifetime | same |
| Retention | Only when `RETENTION_WORKER_ENABLED=true`; first run at the next midnight in Lima, then daily | same |

`apps/worker/src/scheduler/scheduler-core.spec.ts` covers the scheduling rules (one failing job never stops the others, the dispatch floor, retention disabled drops its schedule). The Durable Object itself and the real alarm are not covered by a unit test: check them on workerd with `npm run dev --workspace @mis-servicios/worker` after `npm run db:migrate:local -w @mis-servicios/worker`, then watch the alert intent rows change.

Edge cases: a failing cycle retries at the base interval; a contradictory idle interval below the dispatch interval is raised to it, with a startup warning.

## D1 migrations

| Command | What it does |
|---|---|
| `npm run db:migrate:local -w @mis-servicios/worker` | Applies `apps/worker/migrations/*.sql` to the local D1 database (schema in 0001, the ten pilot zones in 0002). Already applied files are skipped |
| `npm run db:migrate:remote -w @mis-servicios/worker` | Same against the production D1 database. Needs a real `database_id` in `wrangler.jsonc` and Cloudflare credentials; do not run it without approval. The `deploy-worker` CI job runs it, then `wrangler deploy`, on every push to `master` |

The Worker's D1 integration tests (`npm run test:unit -w @mis-servicios/worker`) apply the same migration files to an isolated in-memory database on workerd, so they need no setup. Never edit an applied migration; add a new one.
