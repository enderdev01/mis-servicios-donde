# Feature map

What the app does and how to check each part. Commands run from the project root. API commands default to `http://127.0.0.1:8787` (the Worker under wrangler dev, started with `npm run db:migrate:local -w @mis-servicios/worker && npm run dev -w @mis-servicios/worker`); pass `--base https://mis-servicios-api.onilabs-dev.workers.dev` to check production, which is read-only for every command except `report`.

| Feature | What it does | How to exercise it | Triggers | Details |
|---|---|---|---|---|
| Health | Answers `{"status":"ok"}` without querying the database | `node scripts/control.mjs health` | `apps/worker/src/app.ts` | [api.md](api.md) |
| Approved zones | Lists the approved pilot zones with their bounds | `node scripts/control.mjs zones` | `apps/worker/src/notices/*, apps/worker/migrations/0002_pilot_zones.sql` | [api.md](api.md) |
| Zone notice | Printable community notice for one approved zone, 404 otherwise | `node scripts/control.mjs notice lince` | `apps/worker/src/notices/*` | [api.md](api.md) |
| Public cells | Outage cells for the map, filtered by service and provider; empty while the map gate is off | `node scripts/control.mjs cells --service water` | `apps/worker/src/public-map/*, apps/worker/src/consensus/*` | [api.md](api.md) |
| Submit report | Accepts one outage or restoration report, applies consensus and the per-device and per-IP limits | `node scripts/control.mjs report --lat -12.082 --lng -77.045 --dry-run` | `apps/worker/src/reports/*, apps/worker/src/trust/*, apps/worker/src/security/*, packages/contracts/*` | [api.md](api.md) |
| Home and onboarding | First visit shows the four-step onboarding before the map | `node scripts/control.mjs screenshot --wait 1500` | `apps/web/src/pages/index.astro, apps/web/src/onboarding.ts, apps/web/src/content.ts, apps/web/public/*` | [screens.md](screens.md) |
| Outage map and panel | Leaflet map with soft blobs per cell, service filter, district centring, cell dialog | `node_modules/.bin/playwright test e2e/outage-map.spec.ts` | `apps/web/src/pages/index.astro, apps/web/src/map.ts, apps/web/src/content.ts` | [screens.md](screens.md) |
| Rail tabs | Mobile panel split into Reportar and Reportes tabs, two panels on desktop | `node_modules/.bin/playwright test e2e/rail-tabs.spec.ts` | `apps/web/src/pages/index.astro` | [screens.md](screens.md) |
| Report form | Submits a report from the browser and shows only the public aggregate | `node_modules/.bin/playwright test e2e/release-flow.spec.ts` | `apps/web/src/pages/index.astro, apps/worker/src/reports/*` | [screens.md](screens.md) |
| Unofficial notice | Permanent marker and the full notice one tap away, keyboard reachable | `node_modules/.bin/playwright test e2e/foundation.spec.ts` | `apps/web/src/pages/index.astro, apps/web/src/content.ts` | [screens.md](screens.md) |
| Background workers | Alert dispatch (adaptive wake), episode expiry and retention cleanup, on one Durable Object alarm in the Worker | `npm run test:unit --workspace @mis-servicios/worker` | `apps/worker/src/scheduler/*, apps/worker/src/alerts/*, apps/worker/src/retention/*` | [workers.md](workers.md) |
| D1 migrations | Create the schema and insert the ten pilot zones | `npm run db:migrate:local -w @mis-servicios/worker` | `apps/worker/migrations/*, apps/worker/src/database/*` | [workers.md](workers.md) |
