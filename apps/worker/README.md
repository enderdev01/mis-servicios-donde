# Cloudflare Worker API

The production API for mis-servicios. It serves the same routes and runs the same SQL as `apps/api`
(`/health`, `/v1/reports`, `/v1/cells`, `/v1/zones`, `/v1/zones/:slug/notice`), but as a Cloudflare Worker.
`apps/api` stays as the Node reference implementation, the migration runner (`db:migrate:deploy`), the seed and the
purge CLI.

| Node API | Worker |
|---|---|
| NestJS + Express | Hono |
| `pg.Pool` | `pg.Client` through Hyperdrive, one per request |
| three `setTimeout` workers | one `Scheduler` Durable Object alarm (dispatch, expiry, retention) |
| in-memory rate limiter | Workers Rate Limiting binding (global) + `ReportLimiter` Durable Object (5 reports per hour per IP) |
| helmet | Hono `secureHeaders` |
| `process.env` | `process.env` (populated from vars and secrets by `nodejs_compat`) |

## Local development

```sh
docker compose up -d postgres
DATABASE_URL=postgresql://mis_servicios:mis_servicios@127.0.0.1:54329/mis_servicios npm run db:seed -w @mis-servicios/api
npm run dev -w @mis-servicios/worker -- --var INTAKE_ENABLED:true --var PUBLIC_MAP_ENABLED:true --var DEVICE_TOKEN_SECRET:local-only
```

`wrangler dev` runs the Worker on workerd and reaches Postgres through the `localConnectionString` in
`wrangler.jsonc`. Checks: `npm run typecheck`, `npm run test:unit` and `npm run build` (bundle dry run) in this workspace.

## Deploy to production

1. **Production database.** Use a database that is not the preview one. Take its **pooled** connection string and apply
   the schema and the pilot zones from your machine:
   ```sh
   DATABASE_URL='<pooled-connection-string>' npm run db:migrate:deploy -w @mis-servicios/api
   DATABASE_URL='<pooled-connection-string>' npm run db:seed -w @mis-servicios/api
   ```
2. **Hyperdrive.** Create the config and paste its id into `hyperdrive[0].id` in `wrangler.jsonc`:
   ```sh
   npx wrangler hyperdrive create mis-servicios-db --connection-string='<pooled-connection-string>'
   ```
3. **Secrets.** Generate a new `DEVICE_TOKEN_SECRET` (`openssl rand -hex 32`); never reuse a value that was ever committed.
   ```sh
   npx wrangler secret put DEVICE_TOKEN_SECRET
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```
4. **Deploy.** `npm run deploy -w @mis-servicios/worker`. All product gates start `false`.
5. **Verify** with gates off: `GET /health` is 200, `GET /v1/zones` lists the zones, `GET /v1/cells` is `[]`.
6. **Point the web at it.** Change the `destination` of both rewrites in `apps/web/vercel.json` to the Worker URL.
7. **Enable the gates in order**, editing `vars` in `wrangler.jsonc` and redeploying: `PUBLIC_MAP_ENABLED`, then
   `INTAKE_ENABLED`, then `ALERT_DISPATCH_ENABLED` (see "Gates and workers" in the root README), then
   `RETENTION_WORKER_ENABLED` once data collection starts.

## Differences to know

- **Database wake budget.** The scheduler keeps the same adaptive dispatch delay (`ALERT_DISPATCH_INTERVAL_SECONDS` to
  `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS`), but the expiry job still queries every `EPISODE_EXPIRY_INTERVAL_SECONDS`
  (default 300). On a provider that suspends after five idle minutes that default keeps the database awake: set it above the
  suspend window in `vars`. The hourly cron only re-arms a missing alarm and never queries the database.
- **Rate limits.** `RATE_LIMIT_*` and `RATE_LIMIT_MAX_KEYS` no longer apply: the global limit is 120 requests per 60 s
  per IP in `wrangler.jsonc`. `REPORT_RATE_LIMIT_MAX` and `REPORT_RATE_LIMIT_WINDOW_MS` still tune the report limit.
- **Not used here:** `PORT`, `DATABASE_URL`, `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS`.
- **Client IP** comes from `cf-connecting-ip`; limiter objects are named by a digest of it, never by the address.
