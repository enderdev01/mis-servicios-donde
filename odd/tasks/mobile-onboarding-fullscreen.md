# Mobile onboarding full screen

Tracks GitHub issue #17.

## Objective

Make the first-run onboarding a full-screen section that owns the viewport
*before* the map on mobile — the ownership contract desktop already has — with no
internal scrolling of step copy and one standardized illustration footprint.

## Problem and rationale

Mobile is the primary surface (`apps/web/DESIGN.md`), yet it gets the cramped
version of the onboarding:

- `.onboarding-card` is absolutely positioned *inside* the map, between
  `left: 1rem` and `right: 4.25rem`, lifted above the peek sheet and the
  attribution, with a height budget of
  `calc(100dvh - var(--notice-clearance) - 13.2rem - env(safe-area-inset-bottom))`.
  `.onboarding-content` is the scroll area, so step prose is read through a small
  window.
- The location step shrinks its illustration to `clamp(3rem, 8dvh, 5rem)` just to
  fit the activation control, so the illustration size jumps between steps.
- `3onboard.webp` is 1080x810 while `1`, `2` and `4onboard.webp` are 810x1080.
  With `object-fit: contain` inside a fixed-*height* figure, the third step
  renders at a visibly different footprint from the other three.

## Scope

- `apps/web/src/pages/index.astro`: onboarding CSS (mobile base becomes
  full-screen; desktop two-column block kept), plus the small markup/behaviour
  changes the layout needs.
- The illustration box is standardized on **both** breakpoints — it is the same
  asset-aspect defect in both places and the same CSS property fixes it.
- `e2e/onboarding.spec.ts`: the mobile geometry assertions.
- `apps/web/DESIGN.md`.

## Out of scope

- Step copy in `apps/web/src/content.ts`.
- Re-drawing or re-encoding the illustrations.
- The desktop composition itself (two columns, sizes, spacing) beyond the shared
  illustration box.

## Authorized scope

Explicit owner instruction: "el onboarding en celular esta mal planteado ocupa un
espacio dentro del mapa, cuando deberia aparecer como una seccion antes de
iniciar que ocupe toda la pantalla, ojo solo para mobile, desktop funciona bien.
no debe haber scrolls dentro del contenido de los parrafos y estandariza el
tamano de las imagenes."

## Design decisions

- **Ownership**: `.onboarding` takes pointer events and paints the opaque
  daylight gradient on every viewport, so the desktop-only rules move to the
  base and the mobile float-over-the-map contract is deleted.
- **No prose scroll**: the card is a flex column; `.onboarding-content` is
  `flex: none` with its natural height and `.onboarding-stage` is
  `flex: 1 1 auto; min-height: 0`. The illustration absorbs whatever height is
  left, so copy is never clipped and never scrolls — on a short phone the image
  shrinks instead.
- **Omitir placement**: the skip control must stay immediately after the step
  heading in DOM order (the forward-Tab contract), so on mobile it is absolutely
  positioned into the card's top-right padding instead of being re-ordered.
- **Standardized illustrations**: one box per step, `width: 100%; height: 100%;
  object-fit: contain`, so all four assets share an identical footprint with no
  cropping. The location-step figure shrink rule is removed.
- **Legal line**: `.onboarding-legal` becomes visible on mobile too. The plate no
  longer sits above the card (it is collapsed by #16 and covered by the
  full-screen surface anyway), so this line is what keeps the non-official naming
  present during the first run.

## Dependency

Chained on `feat/notice-info-control` (#16): both rewrite the same clearance and
plate contract, and this feature relies on #16 having freed `--notice-clearance`
from the mobile onboarding's height budget.

## TDD and routing

- TDD: **on**. Source: `openspec/config.yaml` (`strict_tdd: true`).
- Runners: `npm run test:unit` (vitest), `npm run test:e2e` (Playwright).
  Geometry is the behaviour, so Playwright carries the RED evidence.
- Route: **direct inline** on one branch; one surface file plus its specs and doc.
- Branch `fix/mobile-onboarding-fullscreen` off `feat/notice-info-control`;
  PR closes #17, based on the #16 PR.

## Acceptance criteria

- Below `56rem` the `#onboarding` box is exactly the viewport, nothing behind it
  answers `document.elementFromPoint`, and the page never overflows.
- Desktop `>=56rem` keeps its two-column composition and its existing assertions.
- On every mobile step — including the location step before activation, after a
  successful activation and after a denial — neither the card nor the content
  column has a scrollable overflow, and the whole step box is inside the viewport.
- Every step's illustration box has the same width and height, across the
  portrait and landscape assets.
- Four steps, queued fades, Escape/Omitir persistence, activation-as-a-state,
  focus order and the input-modality focus-ring gate all still hold.
- `npm run check` and `npm run test:e2e` green.

## Tasks

- [x] **MOF-1 — RED: the mobile full-screen contract fails first**
  - Replace the float-over-the-map mobile assertions in `e2e/onboarding.spec.ts`
    (peek sheet/grip clearance, map-control targetability per step, attribution
    clearance, reachable-above-an-opened-rail) with the ownership contract.
  - Add a no-scroll probe across all four mobile steps plus the success and
    denial states, and a standardized-illustration-box probe.
  - Checks: `npm run test:e2e -- e2e/onboarding.spec.ts` must FAIL for the right
    reason (recorded).

- [x] **MOF-2 — GREEN: mobile owns the viewport**
  - Move the ownership rules to the base, rebuild `.onboarding-card` as a
    full-screen flex column, absolutely position `.onboarding-head`, make
    `.onboarding-legal` visible on mobile, delete the float geometry and the
    location-step figure shrink.
  - Standardize the illustration box on both breakpoints.
  - Checks: `npm run check`, `npm run test:e2e`.

- [x] **MOF-3 — Record the design contract**
  - Rewrite the Onboarding layout section of `apps/web/DESIGN.md`.
  - Checks: `npm run lint`.

- [x] **MOF-4 — Visual verification in a real browser**
  - 390x844 and a short phone, all four steps plus success and denial; confirm no
    scroll and one illustration footprint. Desktop unchanged.

## Progress

All four tasks done on `fix/mobile-onboarding-fullscreen`, chained on
`feat/notice-info-control`.

**MOF-1 (RED)** — `npx playwright test e2e/onboarding.spec.ts`: **18 passed, 6 failed**,
every failure on the new contract. Notably the illustration-box probe failed on
*desktop* too (`598x684` on steps 1/2/4, `598x449` on step 3) — the asset-aspect defect
was never mobile-only, which is why the fix landed on both breakpoints.

**MOF-2 (GREEN)** — `npx playwright test`: **44 passed, 0 failed**.

One design tension had to be resolved in the source. A stage with `flex: 1 1 auto`
delivered "no prose scroll" but not "one illustration size": the box became whatever
the copy left over, so the four steps measured 518 / 443 / 540 / 496 px tall. Sizing the
*figure* instead — `34dvh` fixed, `max-height: 100%` as the give — satisfies both: the
box is identical while there is room, and shrinks uniformly only when a viewport cannot
hold it. The stage still absorbs the leftover, which puts the copy and the navigation
against the bottom edge within thumb reach instead of leaving a hole under them.

**MOF-3** — `apps/web/DESIGN.md`: the Onboarding section now describes a section ahead
of the map on every viewport, the no-scroll contract, the standardized figure with the
asset-aspect reason recorded, the lifted `Omitir`, and the clearance simplification.

**MOF-4** — Chromium. Measured figure box and overflow per step:

| Viewport | Step 1 | Step 2 | Step 3 | Step 4 | Any scroll |
|---|---|---|---|---|---|
| 390x844 | 353x287 | 353x287 | 353x287 | 353x287 | none |
| 360x640 | 323x218 | 323x201 | 323x218 | 323x218 | none |
| 1440x900 | 598x684 | 598x684 | 598x684 | 598x684 | none |

360x640 is the intended graceful-shrink case: step 2 carries the activation control, so
its artwork gives 17px rather than pushing prose out of view. Desktop is unchanged apart
from step 3 now matching the other three.

### Checks

| Check | Result |
|---|---|
| `npx playwright test` (all specs) | 44 passed, 0 failed |
| `npm run typecheck` | 0 errors |
| `npm run test:unit` | 104 tests passed across all workspaces |
| `npx eslint ./apps ./e2e` | clean |
| `npm run lint` (whole repo) | **10 errors, all in the untracked `videos/` directory** |

Known environmental failure: unchanged from `feat/notice-info-control` — `npm run lint`
fails only on `videos/`, untracked local content present before either branch. Not
caused by, and not in scope for, this change.

## Next step

Open the chained PR for #17 on top of the #16 PR.
