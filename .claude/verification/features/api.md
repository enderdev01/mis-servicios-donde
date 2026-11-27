# API features

Commands below were run against production (`--base https://mis-servicios-api.onilabs-dev.workers.dev`) on 2026-11-23, with the Worker's gates `PUBLIC_MAP_ENABLED=true`, the others `false`. Without `--base` they call `http://127.0.0.1:8787` (wrangler dev); if nothing listens there the command exits 1 with `did not answer (ECONNREFUSED)  ->  start the Worker (...)`.

## Health

| Input | Observed output | Exit |
|---|---|---|
| `node scripts/control.mjs health --base <prod>` | `ok  health <prod> -> 200 {"status":"ok"}` | 0 |
| `node scripts/control.mjs health` with no Worker on 8787 | `FAIL http://127.0.0.1:8787 did not answer (ECONNREFUSED)  ->  start the Worker (npm run db:migrate:local -w @mis-servicios/worker && npm run dev -w @mis-servicios/worker) or pass --base <url>` | 1 |

Health never queries the database, so it stays green when both data routes fail. Always check `zones` too.

## Approved zones

| Input | Observed output | Exit |
|---|---|---|
| `node scripts/control.mjs zones --base <prod>` | `ok  zones <prod>: 10 approved (brena, cercado-de-lima, jesus-maria, lince, magdalena-del-mar, rimac, san-borja, san-isidro, san-juan-de-lurigancho, san-martin-de-porres)` | 0 |
| `... zones --json` | JSON with `ok`, `base`, `status`, `count: 10`, `slugs` | 0 |

Edge cases: an empty list means the D1 migrations did not run (`npm run db:migrate:local -w @mis-servicios/worker`; migration 0002 inserts the zones); a 500 means the Worker cannot reach D1.

## Zone notice

| Input | Observed output | Exit |
|---|---|---|
| `notice lince --base <prod>` | `ok  notice lince: Aviso comunitario de cortes — Lince` | 0 |
| `notice nowhere --base <prod>` | `FAIL notice nowhere -> HTTP 404  ->  404 means the zone is unknown or not approved: list the slugs with: zones` | 1 |
| `notice` (no slug) | `FAIL no zone slug  ->  pass one, e.g. notice lince (list them with: zones)` | 1 |

## Public cells

| Input | Observed output | Exit |
|---|---|---|
| `cells --service water --base <prod>` | `ok  cells <prod>: 0 cell(s) (empty: map gate off, no zones, or nobody reported)` (nobody has reported yet in production) | 0 |
| `cells --service water --provider claro --base <prod>` | same, 0 cells | 0 |
| `cells --service gas --base <prod>` | same, 0 cells (an unsupported service gives an empty list, not an error) | 0 |

To see a non-empty list, run `npm run dev -w @mis-servicios/worker -- --var INTAKE_ENABLED:true --var RETENTION_WORKER_ENABLED:true --var PUBLIC_MAP_ENABLED:true --var DEVICE_TOKEN_SECRET:<anything>` (`H3_RESOLUTION` is 9 in `wrangler.jsonc`) and have three different `--device` ids report an outage in the same zone (episode quorum is 3 devices in 60 minutes).

## Submit report (writes)

`report` is the only command that writes. Run it with `--dry-run` first.

| Input | Observed output | Exit |
|---|---|---|
| `report --lat -12.082 --lng -77.045 --dry-run --base <prod>` | `ok  dry run: would POST <prod>/v1/reports` followed by the JSON body (`submissionId`, `deviceId`, `services: ["water"]`, `providers: {"water":"sedapal"}`, `status: "outage"`, coordinates) | 0 |
| `report --dry-run` (no coordinates) | `FAIL --lat and --lng are required numbers  ->  e.g. report --lat -12.082 --lng -77.045 --dry-run (a point inside an approved zone)` | 1 |
| `report --lat 1 --lng 1 --status nope --dry-run` | `FAIL --status must be outage or restored, got "nope"  ->  pass --status outage\|restored` | 1 |

Real sends (not run against production, which has intake off): 201 `accepted` on success; `400 report_unavailable` is the generic refusal (intake off, point outside every approved zone, or invalid body); `409 already_reported` when the same device reports the same service and status within one hour; `429 rate_limited` after five reports per hour from one IP; `413` above 10 kB.
Every service needs a provider from its catalog (water `sedapal`, electricity `luz_del_sur` or `pluz`, internet `movistar`, `claro`, `win`, `wow`, `mifibra`, or `other`).
