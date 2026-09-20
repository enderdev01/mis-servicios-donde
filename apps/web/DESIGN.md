# Design

Recorded from the built surface at `src/pages/index.astro`. Product truth lives in `../../PRODUCT.md`.

## World

**A quiet district map.** A full-bleed map is the ground; confirmed cuts surface as soft coloured blobs, pending reports as faint dashed rings. H3 is internal plumbing only — a cell index becomes a compact privacy-safe visual area, never a drawn hexagon — so the public surface never teaches the visitor what a "resolution-9 index" is. Adjacent cells reporting the same service merge into one growing area; isolated reports stay local.

The difference between *one neighbour reporting* and *a quorum agreeing* is a matter of firmness, not of geography: both states use the same compact base footprint, while a pending area is dashed and translucent and a confirmed area is solid and stronger. The map is a heat map in spirit — intensity as confidence — without pretending to have a density field it does not collect.

## Palette

**Daylight, not dusk.** The first build rendered the garden at night, reasoning from a power cut. The owner rejected it: water cuts happen in daylight, Lima is bright, and a dark map reads as unfamiliar next to the maps people already use.

| Token | Value | Role |
|---|---|---|
| `--ground` | `#EFF2EC` | Ground — a pale garden green-gray, never plain white |
| `--surface` | `#FBFCF9` | Rail, plate, list rows |
| `--ink` | `#16201A` | Body, headings, primary-button fill |
| `--muted` | `#54655B` | Secondary prose, tinted from the ground hue, never gray |
| `--line` | `#D3DCD3` | Hairlines, control borders |
| `--agua` | `#0A6C9C` ink / `#2C9FDA` fill | Water |
| `--luz` | `#8A5A00` ink / `#F0A81E` fill | Electricity |
| `--net` | `#68399F` ink / `#9760D8` fill | Internet |

Each service carries two values: an `ink` darkened to clear 4.5:1 on the pale ground (measured, not eyeballed: 5.11, 5.24, 6.95) and a brighter `fill` for the outage blob. Colour is always paired with a written label and a drawn icon; colour alone never encodes a service.

The OSM raster basemap is **muted, not restyled**: `filter: saturate(.35) brightness(1.06) contrast(.95)` on `.leaflet-tile-pane` only.

The reason is cartographic, not cosmetic. OSM's standard style is a *mapper's reference render*: it colour-codes road classes and draws every shop, pharmacy and bus stop so contributors can verify the database. A product basemap does the opposite — it suppresses everything that is not the visitor's content. Muting the tile pane, and never the overlay pane, leaves the outage blobs at full strength over a quiet ground.

A purpose-built light basemap (CARTO Positron and its peers) is the real fix and looks like the maps people already know, but every such service now requires an API key. The no-key decision still holds; this filter is what it costs.

## Type

- **Comfortaa 600/700** — wordmark and `h1` only. Rounded, hand-adjacent, carries the map's character.
- **Nunito 400/600/800** — everything else. Rounded to match, but with the weight the scene demands (sunlight, one hand, small type).
- Distances and counts use `font-variant-numeric: tabular-nums` so the column does not jitter as it re-sorts.

## Composition

- **Mobile is primary.** Full-bleed map; a sheet with two states (`peek` / `open`) driven by `data-state` on `#rail`.
- **The map behaves like a map.** Wheel and trackpad zoom are on: this is a full-screen surface with no page scroll to protect. A persistent locate control sits under the zoom buttons, and the visitor's own position is a `divIcon` dot — never a vector. Geolocation is **never requested automatically**: the browser permission prompt fires only from an explicit visitor action (onboarding activation, the map's locate control, the panel's `#locate`, or a report submit).
- **Districts frame the view.** The approved pilot zones are the districts. A `#district-filter` selects which one to view; the map fits that district's bounds. When the visitor shares a position, their district is detected and selected automatically; the locate control always returns to it. "Todos" fits all reported cells instead.
- Framing rule: with a district selected, the map fits the district (and the visitor's own position when it is *their* district). With no position it opens on the pilot zone at zoom 13, never the whole metro.
- The `peek` state carries the payload, never the framing: the `#answer` line ("Lo más cerca: Agua a 190 m") sits above the fold, the headline below it.
- **Desktop ≥56rem:** the sheet becomes a fixed 25rem left rail, transform disabled, grip hidden.
- The unofficial `.plate` floats top and is permanently visible — it never auto-hides and is never dismissible; on desktop it clears the rail at `left: 26.5rem`.
- **The plate never hides the map controls.** Because the plate is fixed above the garden, any Leaflet control it overlapped would be unreachable. On small screens (`<56rem`) — and on desktop only when the plate can actually reach the top-right control strip — the top-right zoom and locate controls shift below the plate's *measured* height (`--notice-clearance`, kept current by a `ResizeObserver` on the plate, `.75rem` offset + `.5rem` gap included). Both stay visible at once; neither is weakened.

## Onboarding

**A first-run teaching layer, full-screen on desktop.** First-run visitors get four illustrated steps (`1onboard`–`4onboard`, optimized WebP under `public/onboarding/`) rendered as a `role="region"` layer (`#onboarding`). On **mobile** the layer forwards no pointer events — only the floating card catches them, so the map stays usable around the card. On **desktop (≥56rem)** the layer is a **full-screen first-load experience that owns the entire viewport from the moment the page opens**: an opaque daylight surface (the committed palette gradient, one soft `--agua` tint) with a deliberate two-column editorial composition — large illustration on the left, step content and actions in a right column — never a centered modal card and never a card docked beside the 25rem rail. The surface takes pointer events, so the map and rail behind it are unreachable until the visitor finishes or skips; navigation, skip, Escape, and the integrated legal line stay reachable. The card is still a **first-run teaching layer**, not a dialog: no `<dialog>` and no focus trap are justified; focus moves to the card on open, to each step heading on step change, to the activation-success status when activation succeeds, and back to the element that held it on close. The visible focus ring on those two script-focused elements is **gated by input modality**, not by the browser's heuristic (which wrongly matches a programmatic focus before any interaction): the last real input modality is tracked as `data-input` on the document element (`keyboard` on any keydown, `pointer` on any pointerdown), and the `.onboarding-title` / `.onboarding-success` `:focus-visible` rules paint only under `html[data-input='keyboard']` — otherwise they are explicitly `outline: none`. So a fresh load (heading focused, no input yet) and every pointer-driven step change or activation paint nothing, a real key press (Tab, Enter on "Siguiente" or "Activar ubicación") brings the indicator back on the heading and the status, and switching back to pointer input mutes it again. Real interactive controls (skip, activate, navigation) keep the normal global `:focus-visible` ring unconditionally. Escape closes the onboarding from anywhere — the key listener is global but only alive while the layer is open, so closing with focus on the map or the rail still works.

- **Copy** lives in `content.ts` (`onboardingSteps`, plus `siteNotice`/`unofficialNotice`/`locationSuccess`): community-generated, unofficial framing; honest location privacy — map proximity stays entirely in the browser, while a submitted report sends the precise coordinate once, the server converts it to a broad area, and the coordinate is discarded (never stored, never displayed); two-touch reporting ("No hay servicio" / "Ya volvió"); and the real publication rules — "sin confirmar" until three distinct neighbours agree, one report per device, service, and state per hour, and publication only inside approved pilot zones. No report counts are ever quoted as product claims.
- **Activation is a state inside the location step, never an early completion.** A successful "Activar ubicación" keeps the layer open on "Paso 2 de 4", replaces the activation control with a success status ("Ubicación activada. Los cortes cerca tuyo se ordenan por distancia. Tu posición no se guarda.") that is a **real polite live region** — `role="status"` with explicit `aria-live="polite"`, always rendered with its empty state styled to occupy no space, so the text insertion itself is announced — and focused so keyboard users continue from it. "Siguiente" advances normally. **Completion persists only when the visitor explicitly finishes step 4** ("Empezar a usar el mapa"); activation alone writes nothing — a reload replays the flow. Skipping ("Omitir") and Escape still persist `skipped`. A completed activation is remembered for the visit: returning to the location step shows the success state again without re-requesting the permission.
- **Persistence** is local and versioned (`onboarding.ts`, key `mis-servicios:onboarding`, `version` 1): completing or skipping writes `{version, status}`; a missing, corrupt, unreadable-status, or older-version record replays the onboarding, and a newer-version record is trusted so this build never replays a flow a newer one already recorded. A storage failure (quota, private mode) never blocks skip or close — the visit simply replays next time. Escape and "Omitir" both skip and persist.
- **Denial is a first-class state here too**: a denied activation shows the fallback note inside the step — also a real polite live region (`role="status"`, `aria-live="polite"`, same always-rendered contract) so the denial is announced — keeps the flow navigable, and leaves the map's locate control as the retry affordance. The onboarding never blocks map usefulness after skip or denial.
- **Desktop full-screen ownership (≥56rem)**, asserted by `e2e/onboarding.spec.ts` at 1440×900 **and** 900×844: the `#onboarding` layer's box is exactly the viewport (`x:0, y:0`, full width and height); `document.elementFromPoint` at the centres of the map, the rail, and the zoom control all land on the layer — nothing behind it answers a pointer; the composition never overflows (`scrollWidth`/`scrollHeight` ≤ viewport); "Siguiente" and the integrated `.onboarding-legal` line stay hit-test reachable. The legal copy (`siteNotice` + `unofficialNotice`) carries the permanent non-official naming on **every** step inside the full-screen experience; on mobile the plate above the card keeps the duplicate hidden (`.onboarding-legal` is desktop-only).
- **Layout (mobile)**: the card floats above the peek sheet and the lifted attribution, and reserves the map's top-right control column. Measured contract at 390×844 (asserted by `e2e/onboarding.spec.ts` on **all four steps**):
  - the card stops `4.25rem` from the right edge so the zoom-in/zoom-out/locate strip (~34px wide at the right inset) is never covered — a `document.elementFromPoint` hit-test at each control centre stays on the control;
  - the card bottom sits `2.6rem` above the `9.6rem` offset that lifts `.leaflet-bottom`, so the card and the attribution never intersect (genuine rectangle intersection, not just visibility);
  - the card's height budget starts below the measured `--notice-clearance`, so it can never slide under the permanent plate, and overflow scrolls inside the card's content column (the card shell itself never scrolls);
  - the card floats above the opened sheet as the teaching layer, with skip still one tap away;
  - the step navigation (Anterior/Siguiente) is a **real footer outside the card's scroll area** — a flex child below the scrollable content column, never a sticky overlay inside it — so it stays visible and hit-test reachable on every step and can never paint over step copy; measured at 390×844 after both a successful activation and a denial: with `scrollTop` at 0 on the card and the content column, the whole live-region box (success status and denial note) sits fully inside the card, does not intersect the nav footer, and answers `document.elementFromPoint` across a 3×3 sample of its box — including the location step before activation, where the same non-overlap holds;
  - the location step carries the activation control plus live-region copy, so its illustration yields height (`clamp(3rem, 8dvh, 5rem)` while `.onboarding-activate` is present or the note/success status has text) and the whole step fits without scrolling at the reference mobile viewport; the other steps keep the full illustration height, and the internal scroll remains for smaller screens.
- **Focus order**: the card DOM places the step heading first and `Omitir` directly after it (`order: -1` keeps the head visually on top — `order` moves paint, never focus order), so one forward Tab from the open-time focus (the step heading) reaches "Omitir" without cycling the page.
- **Narrow desktop (56–64rem)**: while the onboarding owns the screen the plate rests underneath it and the integrated legal line carries the naming; after the flow closes, `watchNoticeClearance` only sets `--notice-clearance` when the plate can actually reach the control strip horizontally (right edge + ~66px of control width/inset vs the viewport); on a wide desktop it stays unset and the controls keep Leaflet's default 10px top. On mobile the card keeps the same reserve so it never touches the strip.
- The desktop surface's entrance is a single quiet fade; both the card rise and the fade are disabled under `prefers-reduced-motion: reduce`. Step-to-step navigation uses the same quiet language: a fade out, the copy swap, and a fade in.

## Motion

Motion is navigation, not decoration. Leaflet's `fitBounds` / `setView` animate the district framing; tapping a report in the list flies the map to that cell centre. The visitor's own dot pulses (`animation: pulse`) as the one always-on signal. The onboarding reads as motion too: each step change fades the current slide out (illustration and content column together, `--onboarding-fade`, 160ms), swaps the copy, and fades the new step back in, and leaving the last step into the app dissolves the whole surface before it is removed. Step moves are queued, so rapid clicks never drop a step.

`prefers-reduced-motion: reduce` removes the pulse, the rail transition, and every onboarding fade (the card rise, the step cross-fade, and the exit fade all swap directly).

## Refresh

The cell list and map poll `/v1/cells` every 30 seconds when the tab is visible, so a neighbour's report arrives without a reload. Background refresh never re-frames the map — it updates the data in place and leaves the visitor's current view alone.

## Browser surfaces

Themed, not left to defaults: `::selection`, `:focus-visible` (`--agua`, 2px, offset 3; the script-focused onboarding heading and success status are additionally gated to keyboard input modality), scrollbars (`--line` on transparent), the select chevron (inline SVG in `--muted`), Leaflet's zoom control, attribution and tooltips.

## States

Empty, loading, denied-location, invalid-report, submitted, pending, provider-error, and first-run onboarding all exist. **Pending and confirmed are distinct states**, not just different shapes: a pending report reads "Posible corte de X reportado por un vecino" and draws dashed, translucent; a confirmed cut reads "Corte de X en una zona cercana" and draws solid. **Location denial is a first-class state**: the map stays on the pilot zone, `#locate` appears offering the permission on the visitor's terms, and the list falls back to a stable service order with no distances. The map's own locate control stays available in every state, not only after a denial. The onboarding repeats the same respect for denial — it explains, asks once on an explicit action, and continues without the permission — and treats **activation success** as its own first-class state: a visible success status inside the step, the flow still open, nothing persisted until the final step.

## Non-negotiables

- The `#cell-list` text is the accessible equivalent of the map, not a fallback to delete.
- The raw H3 index never appears as text; an invalid index is dropped rather than mapped.
- A report count is never exposed — only `confirmed` vs not. Exact per-cell counts would let a caller fingerprint neighbours.
- The unofficial notice names Sedapal and Luz del Sur and is present in every state.
- OSM attribution stays visible; on mobile `.leaflet-bottom` lifts `9.6rem` to clear the peek sheet.
