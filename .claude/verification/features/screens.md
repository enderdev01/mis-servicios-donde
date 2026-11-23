# Screens (apps/web, Astro + Leaflet)

The web app is one page, `/`. Title: `Mis Servicios | Mapa comunitario de cortes`. There is no WebGL: the map is Leaflet over OpenStreetMap tiles, so a screenshot shows what the visitor sees.

## Home and onboarding

| Input | Observed output | Exit |
|---|---|---|
| `node scripts/control.mjs screenshot --wait 1500` | Starts `astro dev` on `127.0.0.1:4321` when nothing answers, captures, stops the server it started. `ok screenshot http://127.0.0.1:4321/ -> <tmp>/mis-servicios-screenshot.png` | 0 |

What must be visible in a first-visit capture: the onboarding surface owning the viewport, headline «Un mapa hecho por vecinos», the illustration, «Paso 1 de 4», the unofficial-information line, and the buttons «Anterior» (disabled), «Siguiente» and «Omitir». The map is behind it: to see it, complete or skip the onboarding (the `e2e` specs set the stored decision first).

Edge cases: the dev server proxies `/v1` and `/health` to `127.0.0.1:3000`; with no API running the page still renders but its data calls fail, so for a populated map start the API first or use the e2e specs, which stub the API.

## Playwright specs (the repo's own behaviour checks)

`node_modules/.bin/playwright test` builds the web app, serves it with `vite preview` on `127.0.0.1:4331` (never reusing a running server) and runs the five specs. Observed on 2026-11-23: **54 passed (35.2s)**, exit 0. Run one spec by naming it.

| Spec | What it proves |
|---|---|
| `e2e/outage-map.spec.ts` | One soft blob per reported cell, adjacent reports merge, pending reports dashed, geographic scaling on zoom, visitor repositioning, malformed cells listed but not mapped, empty map keeps the notice, service colours legend, district centring and filter, stacked-report modal |
| `e2e/rail-tabs.spec.ts` | Mobile panel split into Reportar and Reportes tabs, whole report form fits without scrolling, arrow-key tab navigation, desktop shows both panels with no tabs, semantics follow a resize |
| `e2e/onboarding.spec.ts` | Four illustrated steps, fades and rapid clicks, no geolocation before the visitor asks, denied location falls back to a usable map, stays closed after completion, Escape closes, mobile first load owns the viewport |
| `e2e/release-flow.spec.ts` | Submitting a report renders only the public aggregate; the browser stays private and actionable when rollout APIs are disabled |
| `e2e/foundation.spec.ts` | Static public foundation, filtered map and accessible report validation, permanent unofficial marker, notice reachable by keyboard, control offsets when collapsed |
