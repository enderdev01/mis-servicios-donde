# Notice info control

Tracks GitHub issue #16.

## Objective

Give the map back its top band by collapsing the permanent unofficial plate
(`#site-identity`) behind a compact control, on mobile **and** desktop, while the
non-official framing stays permanently present and one tap away.

## Problem and rationale

`.plate` is fixed over the map on every viewport and carries two lines of prose —
the "Mis Servicios" wordmark plus `siteNotice` + `unofficialNotice`. The visitor
reads it once; the surface pays for it forever:

- on mobile it occupies the top band and pushes the Leaflet zoom/locate strip
  down by its measured height (`--notice-clearance`, set by
  `watchNoticeClearance()` through a `ResizeObserver`), so the controls start
  ~4rem below their default position;
- on desktop it floats at `left: 26.5rem` and covers the map beside the rail.

It never collapses and is never dismissible.

## Product decision recorded

The owner asked for the component to be removed and replaced by an SVG icon that
reveals the information on demand. `apps/web/DESIGN.md` carries a non-negotiable:
"The unofficial notice names Sedapal and Luz del Sur and is present in every
state" — the notice is the product's legal framing for a community map that names
real utilities, so a bare icon would drop the standing disclaimer entirely.

Resolution shipped: the collapsed control is an **icon plus the two words
"No oficial"** — roughly 90px wide against the ~340px two-line block, a ~90%
reduction that still keeps a permanent non-official marker on screen. The full
copy (wordmark, `siteNotice`, `unofficialNotice`, `role="note"`) lives inside the
panel the control expands. Flagged to the owner; drop the two words to a pure
icon on request.

## Scope

- `apps/web/src/pages/index.astro`: markup, CSS and the toggle behaviour.
- `watchNoticeClearance()` measures the identity wrapper, so the clearance
  follows whichever state is showing.
- e2e specs that assert the notice: `foundation`, `outage-map`, `release-flow`,
  `onboarding`.
- `apps/web/DESIGN.md`.

## Out of scope

- The notice wording in `apps/web/src/content.ts`.
- The onboarding's own integrated `.onboarding-legal` line.

## Authorized scope

Explicit owner instruction: "quitalo en mobile ponme un svg icon mejor para
desplegar esa informacion si el usuario quiere, pero quitalo … ocupa espacio
tanto mobile como desktop."

## TDD and routing

- TDD: **on**. Source: `openspec/config.yaml` (`strict_tdd: true`).
- Runners: `npm run test:unit` (vitest), `npm run test:e2e` (Playwright).
  The behaviour here is DOM/geometry, so Playwright carries the RED evidence.
- Route: **delegated direct** is not required — the change is one understood
  surface file plus test/doc updates the same author must keep in lockstep, so
  it runs inline on one branch.
- Branch `feat/notice-info-control` off `develop`; PR closes #16.

## Acceptance criteria

- The expanded plate is not the default state on any viewport.
- The control is a labelled `<button>` with `aria-expanded` / `aria-controls`,
  keyboard reachable, and toggles the panel.
- Escape and a pointer outside collapse the panel.
- The expanded panel keeps `role="note"` naming Sedapal and Luz del Sur.
- While collapsed, the Leaflet zoom/locate strip sits at its default top offset
  and is hit-test reachable; while expanded it clears the panel.
- `npm run check` and `npm run test:e2e` green.

## Tasks

- [x] **NIC-1 — RED: the collapsed-by-default contract fails first**
  - Rewrite the identity assertions in `e2e/foundation.spec.ts` to the new
    contract (collapsed badge visible, full note only after expanding, Escape and
    outside-pointer collapse, control keyboard reachable).
  - Point `outage-map`, `release-flow` and `onboarding` notice assertions at the
    new contract.
  - Checks: `npm run test:e2e -- e2e/foundation.spec.ts` must FAIL for the right
    reason (recorded).

- [x] **NIC-2 — GREEN: ship the control**
  - Markup: `#identity` wrapper, `#identity-toggle` button with an inline SVG
    info glyph, `#site-identity` panel hidden by default.
  - CSS: collapsed pill, expanded panel, desktop offset moved to the wrapper,
    `.leaflet-top` default offset restored.
  - Script: toggle, Escape, outside pointer, and `watchNoticeClearance()`
    observing the wrapper.
  - Checks: `npm run check`, `npm run test:e2e`.

- [x] **NIC-3 — Record the design contract**
  - Update `apps/web/DESIGN.md` (Composition section and the non-negotiable).
  - Checks: `npm run lint`.

- [x] **NIC-4 — Visual verification in a real browser**
  - Mobile and desktop, collapsed and expanded, controls reachable.

## Progress

All four tasks done on `feat/notice-info-control`.

**NIC-1 (RED)** — `npx playwright test e2e/foundation.spec.ts`: 5 failures, every one
`element(s) not found` waiting for `getByRole('button', { name: 'Aviso: información no
oficial' })`. Failing for the intended reason: the control did not exist yet.

**NIC-2 (GREEN)** — `npx playwright test`: **40 passed, 0 failed**. One real defect was
caught on the way: the first GREEN run failed
`zoom and locate stay targetable while expanded` at 390x844, because the clearance was
only recomputed by the `ResizeObserver` and the controls spent a frame under the panel.
Fixed in the source, not in the test — `updateNoticeClearance()` was split out and is
now called synchronously from `setIdentityExpanded`.

**NIC-3** — `apps/web/DESIGN.md`: Composition rewritten (identity, three ways to
collapse, clearance contract), the non-negotiable reworded, and the two stale
onboarding references to the standing plate corrected.

**NIC-4** — Chromium at 390x844 and 1440x900, collapsed and expanded. Measured: the
collapsed badge is **93.1 x 28.5** against the old plate's ~366x94. `--notice-clearance`
is unset while collapsed on both viewports (controls keep Leaflet's `.625rem` inset) and
`150px` when expanded on mobile.

### Checks

| Check | Result |
|---|---|
| `npx playwright test` (all specs) | 40 passed, 0 failed |
| `npm run typecheck` | 0 errors (`astro check` 10 files, `tsc --noEmit`) |
| `npm run test:unit` | all workspaces passed |
| `npx eslint ./apps ./e2e` | clean |
| `npm run lint` (whole repo) | **10 errors, all in the untracked `videos/` directory** |

Known environmental failure: `npm run lint` fails only on `videos/`
(`lima-map-data.js`, `lima-night-map.js`, `night-block.js`, `bake-lima-map.mjs` —
`no-undef` on `window`/`document` and one unused import). That directory is untracked
local content, present identically before this branch; stashing it makes `npx eslint .`
report "No issues found". Not caused by, and not in scope for, this change.

## Next step

Open the PR for #16, then start MOF-1 on `fix/mobile-onboarding-fullscreen`.
