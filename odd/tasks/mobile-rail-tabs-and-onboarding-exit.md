# Mobile rail tabs and onboarding exit

Three owner-reported defects on the mobile surface, delivered together because
they all land in `apps/web/src/pages/index.astro`.

## Objective

1. Finishing the last onboarding step always reveals the map.
2. The mobile onboarding illustration reads 10% larger.
3. The mobile rail splits its two option-heavy panels behind a two-tab control
   (left `Reportar`, right `Reportes`) instead of stacking everything in one
   scroll.

## Problem and rationale

### ONB-EXIT — the finish tap is swallowed

`next`'s click handler decides between "advance" and "close" by reading
`onboardingIndex` synchronously:

```ts
next.addEventListener('click', () => {
  if (onboardingIndex === onboardingSteps.length - 1) { closeOnboarding('completed'); return; }
  moveOnboarding(1);
});
```

`moveOnboarding` does not advance that index. It pushes onto
`onboardingMoveQueue` and lets `drainOnboardingMoves` settle the step
asynchronously — fade out (`ONBOARDING_FADE_MS`), swap, await the decoded
illustration, fade in. `onboardingIndex` therefore *lags the visitor's intent*
for the whole cycle.

A visitor tapping faster than one cycle reads a stale index. The tap that should
close the flow instead calls `moveOnboarding(1)`, which clamps to the last step,
and the drain drops it (`if (target === onboardingIndex) continue;`). The tap is
swallowed: the card sits on step 4 with the button already reading
"Empezar a usar el mapa", the fixed `z-index: 800` layer stays over the map, and
the map "cannot be seen". The same staleness lets `moveOnboarding`'s own no-op
guard queue moves that the drain later discards.

Reproduced on `develop` @ `f442749`: four taps at 400 ms land on "Paso 4 de 4"
with nothing persisted and `#onboarding` still visible; the same four taps at
1500 ms close correctly and persist `{"version":1,"status":"completed"}`.

**Fix**: decide against the index the queue is *heading toward*, not the settled
one.

### ONB-FIGURE — the illustration is small on mobile

`.onboarding-figure` is `height: 34dvh`. On an iPhone 13 that is a 353x226 box,
and three of the four assets are portrait (810x1080), so `object-fit: contain`
leaves the artwork height-limited at roughly 169x226 with dead space either
side. The stage (`flex: 1 1 auto`) has visible slack above and below on every
step, including step 4 (the longest copy), so the box can grow.

The figure is deliberately one standardized size across steps — a documented
invariant, so step 3's landscape asset cannot change the footprint. Growing only
step 1 would break it and make the steps jump. The shared box grows instead, so
step 1 reads 10% larger and the no-jump contract holds. `max-height: 100%` stays
as the give for short phones.

### RAIL-TABS — one overloaded mobile sheet

Opened on an iPhone 13, `#rail-body` holds 743px of content in 489px of scroll.
Everything is stacked: framing, legend, `Cortes cerca tuyo` (three filters plus
the list) and `Reportar un corte` (the whole form). The report form is entirely
below the fold.

**Fix**: below 56rem, a two-tab control switches between the two panels. Desktop
(>=56rem) keeps both panels visible and the tablist hidden — the desktop rail is
a 25rem column with room for both, and nothing about it was reported.

## Scope

Authorized edit surfaces:

- `apps/web/src/pages/index.astro`
- `e2e/onboarding.spec.ts`, `e2e/foundation.spec.ts`, `e2e/outage-map.spec.ts`,
  `e2e/release-flow.spec.ts`, `e2e/fixtures.ts` (only as the change forces)
- `apps/web/DESIGN.md`

Out of scope: the API, the desktop rail composition, onboarding copy, the map
itself.

## Constraints

- Artifacts in English; UI copy stays Spanish, matching the page.
- Desktop (>=56rem) rail behavior must not change.
- The tab control is mobile-only; its ARIA roles must not be exposed on desktop,
  where no tablist is visible.
- `.answer` stays the sticky headline outside the tabs — it answers "is there an
  outage right now?" in both tabs.
- The document keeps exactly one `<h1>` in the accessibility tree at all times.

## Decisions

- **Default tab is `Reportar`** (the left one). The owner specified left/right
  placement but not the default; first-tab-selected is the tablist convention,
  and the sticky `.answer` plus the map already serve the passive "is there an
  outage?" read.
- **The legend moves into `Reportes`.** It explains the map's confirmation
  levels, which pairs with the outage list, and it keeps the shared header short.
- **`h1` and `.lede` stay in the shared header**, above the tabs, so the document
  outline never loses its `h1` when `Reportar` is active.

## Verification

Resolved TDD mode: **off** — no project or session configuration enables it
(`npm run check` is lint + typecheck + unit; e2e is a separate `npm run test:e2e`).
Ordinary functional checks apply, and the two existing onboarding/rail e2e suites
are extended rather than replaced.

- `npm run lint`
- `npm run typecheck`
- `npm run test:unit`
- `npm run test:e2e`
- Real Chromium mobile pass (iPhone 13) for the figure size and the tab split.

## Tasks

- [x] **T1 — ONB-EXIT**: replaced the derived pending index with
      `onboardingPendingIndex`, updated synchronously by `moveOnboarding`, and
      switched the move queue from deltas to destinations. The first attempt
      derived the pending index by folding the queued deltas over
      `onboardingIndex`; that still failed a same-tick burst, because the drain
      shifts a move off the queue *before* awaiting, so an in-flight move was
      invisible to both terms. Verified: four taps at 400 ms and four
      activations in one tick both finish and persist `completed`.
- [x] **T2 — ONB-FIGURE**: shared `.onboarding-figure` height `34dvh` ->
      `37.4dvh`. Measured 226px -> 248px at iPhone 13 (+9.7%), identical on all
      four steps, no step scrolls.
- [x] **T3 — RAIL-TABS**: `#rail-tabs` plus `watchRailTabs()`, one
      `matchMedia('(max-width: 55.99rem)')` adding and stripping the whole tab
      contract with the layout. `#rail-body` scrollHeight 743px -> 541px on the
      report tab. A first pass restored the desktop `aria-labelledby` by panel
      position and crossed the two labels (the tab order and the panel order do
      not line up); each panel's original label is now captured at startup and
      put back verbatim.
- [x] **T4**: `apps/web/DESIGN.md` updated for all three — the figure size and
      why the shared box carries it, the mobile tab split and its ARIA
      lifecycle, and the pending-vs-settled index contract.
- [x] **T5**: checks run and branch committed.

## Acceptance criteria

- [x] Tapping "Empezar a usar el mapa" always closes the onboarding and reveals
      the map, at any tap cadence.
- [x] The mobile onboarding figure box is 10% taller than `34dvh`, identical
      across all four steps, with no step scrolling.
- [x] On mobile the rail shows one panel at a time behind `Reportar` /
      `Reportes`; on desktop both panels show and no tablist exists.
- [x] `lint`, `typecheck`, `test:unit`, `test:e2e` green.

## Verification results

Observed on branch `fix/mobile-rail-tabs-and-onboarding-exit`:

| Check | Result |
| --- | --- |
| `npx eslint --ignore-pattern 'videos/**' .` | **pass** — no issues |
| `npm run lint` (whole tree) | **fails on `videos/`** — see below |
| `npm run typecheck` | **pass** — 0 errors across all three workspaces |
| `npm run test:unit` | **pass** — 104 tests (56 + 45 + 3) |
| `npm run test:e2e` | **pass** — 52 tests, up from 44 |
| Chromium iPhone 13 pass | **pass** — all three defects gone |

**Pre-existing lint failure, not from this change.** `npm run lint` reports 10
errors, all under `videos/mis-servicios-ad/` (`'window' is not defined`,
`'document' is not defined`, one unused import). That directory is **untracked**
(`?? videos/` in `git status`) and no file in it was touched here — the same 10
errors reproduce on `develop`. It will break CI lint the moment it is committed,
so it needs either an eslint browser-env entry or an ignore rule. Left alone
because it is someone's in-progress work, not part of this change.

**New tests fail without the fix**, confirmed by stashing
`apps/web/src/pages/index.astro` and re-running: the 2 onboarding exit tests, the
figure-size test and all 5 rail-tab tests fail on the old code and pass on the
new.

## Next step

Push and open a PR against `develop`.
