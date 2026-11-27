# Cloudflare Worker API

The API for mis-servicios, and the only backend in this repo. A Hono app on Cloudflare Workers with a D1 database
(`/health`, `/v1/device`, `/v1/reports`, `/v1/cells`, `/v1/zones`, `/v1/zones/:slug/notice`).

## How it works

- **Database:** D1 through the `DB` binding. The schema and the ten pilot zones are the migrations in `migrations/`.
- **Background jobs:** one `Scheduler` Durable Object alarm runs alert dispatch, episode expiry and retention. An hourly cron only re-arms a missing alarm.
- **Report intake:** a `CellCoordinator` Durable Object per H3 cell serializes the read-decide-write of a report.
- **Rate limits:** a Workers Rate Limiting binding (120 requests per 60 s per IP) and a `ReportLimiter` Durable Object (per hour: 60 reports per IP, 5 reports per signed device id, 60 issued ids per IP). A `429 rate_limited` carries a `Retry-After` header and `retryAfterSeconds` in the body. If the binding or the secret is missing the Worker answers `503 service_unavailable` instead of letting traffic through.
- **Report errors:** `POST /v1/reports` answers `503 intake_paused` (intake gates off), `422 outside_pilot_zone` (point outside every approved zone), `400 report_unavailable` (invalid body or missing server configuration), `409 already_reported` / `submission_conflict`, `413 payload_too_large` and `429 rate_limited`.
- **Config:** `process.env`, filled from `vars` and secrets by `nodejs_compat`.

## Local development

```sh
npm run db:migrate:local -w @mis-servicios/worker
npm run dev -w @mis-servicios/worker -- --var INTAKE_ENABLED:true --var RETENTION_WORKER_ENABLED:true --var PUBLIC_MAP_ENABLED:true --var DEVICE_TOKEN_SECRET:local-only
```

`wrangler dev` serves the Worker on `http://127.0.0.1:8787` with a local D1 database. Checks, in this workspace:
`npm run typecheck`, `npm run test:unit` (unit tests plus the D1 integration tests, run on workerd) and `npm run build` (bundle dry run).

## Deploy to production

After the one-time setup below, every push to `master` deploys the Worker: the `deploy-worker` job in
`.github/workflows/ci.yml` runs after `verify` passes, applies the remote D1 migrations, then runs `wrangler deploy`.
It needs two secrets in the repository's `production` environment (Settings → Environments):

- `CLOUDFLARE_API_TOKEN`: an API token with **Workers Scripts: Edit** and **D1: Edit** on the account (the
  "Edit Cloudflare Workers" template plus D1: Edit also works if the first run asks for more).
- `CLOUDFLARE_ACCOUNT_ID`: the account id shown in the Cloudflare dashboard.

Migrations run before the deploy, so a migration must keep the running Worker working (add, do not rename or drop,
in the same release). The steps below are the first deploy, or a manual one:

1. **D1 database.** Create it and paste the printed id into `d1_databases[0].database_id` in `wrangler.jsonc`:
   ```sh
   npx wrangler d1 create mis-servicios
   ```
2. **Schema and pilot zones.** Apply the migrations (0002 inserts the ten zones):
   ```sh
   npm run db:migrate:remote -w @mis-servicios/worker
   ```
3. **Secrets.** Generate a new `DEVICE_TOKEN_SECRET` (`openssl rand -hex 32`); never reuse a value that was ever committed.
   ```sh
   npx wrangler secret put DEVICE_TOKEN_SECRET
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```
4. **Deploy.** `npm run deploy -w @mis-servicios/worker`. Intake, dispatch and retention start `false`.
5. **Verify** with those gates off: `GET /health` is 200, `GET /v1/zones` lists the zones, `GET /v1/cells` is `[]`.
6. **Point the web at it.** Change the `destination` of both rewrites in `apps/web/vercel.json` to the Worker URL.
7. **Enable the gates in order**, editing `vars` in `wrangler.jsonc` and redeploying: `PUBLIC_MAP_ENABLED`, then
   `ALERT_DISPATCH_ENABLED` (see "Gates and workers" in the root README), then `RETENTION_WORKER_ENABLED`, then
   `INTAKE_ENABLED`. Intake is refused while retention is off.

## Notes

- **Expiry interval.** The expiry job runs every `EPISODE_EXPIRY_INTERVAL_SECONDS` (3600 in `vars`); raise it to wake the Worker less often.
- **Rate limits.** The global limit lives in `wrangler.jsonc`. `REPORT_RATE_LIMIT_MAX` and `REPORT_RATE_LIMIT_WINDOW_MS` tune the report limit.
- **Client IP** comes from `cf-connecting-ip`; limiter objects are named by an HMAC-SHA256 of it keyed with `DEVICE_TOKEN_SECRET` (label `limit:`), never by the address or a plain hash of it. The stored `requestHash` in `SubmissionRecord` is keyed the same way (label `request:`). Rotating the secret resets the limiter windows and makes older stored request hashes unmatchable.
- **Fail closed.** A missing `GLOBAL_LIMITER` binding makes every route (including `/health`) answer `503 service_unavailable`; a missing `DEVICE_TOKEN_SECRET` does the same for `POST /v1/device` and `POST /v1/reports` only. Each refusal logs one `console.error` with no client data.
