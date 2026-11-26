# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Residents of two or three pilot neighbourhoods in Lima Metropolitana, on a phone, in the street or at home, during or just after a service cut. They are not registered, not logged in, and often on mobile data with a partly drained battery because the power is out. A secondary audience reads the same data indirectly: neighbours without a smartphone, reached through printed one-page notices distributed by community leaders and pilot corner shops.

The job is immediate and selfish in the healthiest way: *is this only my house, or is it the whole block?* Answering that decides whether someone spends the next hour on hold with a utility or waits it out. Reporting that a service came back matters exactly as much as reporting it went down.

## Product Purpose

A live layer of neighbour-reported outages for water, electricity and internet, aggregated by area.

Official sources (Sedapal, Luz del Sur) and existing aggregators publish only **scheduled** cuts, announced in advance. The outages that actually hurt are the unplanned ones — a burst main, a substation fault — which never appear in any bulletin because the utilities do not publish them and sometimes do not acknowledge them.

Success is a neighbour opening the page during a cut and knowing, within seconds, whether the problem is theirs alone or shared, without creating an account or handing over an address.

## Positioning

The data comes from neighbours, not from scraping what utilities already published. That inverts the usual mechanism: adding a fourth service would be one more field, not one more integration.

A single report shows as **unconfirmed**, so the person who sent it sees it land. A condition only becomes **confirmed** after three distinct devices report the same area and service inside the confirmation window. The page draws both, but never treats an unconfirmed claim as fact, and never exposes how many neighbours reported it.

## Operating Context

- **Report:** the browser reads the precise location once, the server derives an H3 cell, and the raw latitude/longitude is discarded before anything is written. No address is ever typed or stored.
- **Consensus:** three distinct devices in the same cell, same service, inside the window open an episode. Episodes expire on their own after roughly six hours without fresh reports, so stale information does not present itself as current.
- **Alert:** crossing the threshold queues one durable Telegram notice per episode. Delivery is at-least-once, never exactly-once.
- **Physical bridge:** an auto-generated one-page printable notice per approved zone, for neighbours who are not reachable by phone.
- **Rollout:** every surface sits behind an independent gate (intake, public map, dispatch, retention) that can be turned off without touching the others.

## Capabilities and Constraints

- Astro static frontend, NestJS API, PostgreSQL. Leaflet + h3-js render the hexagons; the raw H3 index is never shown as text.
- **`GET /v1/cells` returns only `{h3Cell, service, provider, confirmed}`.** No timestamps, no counts, no device data, no coordinates. This is a specified and verified privacy decision, not an oversight — so the public surface cannot order or label anything by recency.
- Proximity is therefore computed **entirely in the browser**: `cellToLatLng` gives a cell centre, the visitor's own position never leaves the device and is never sent to the API.
- The visitor's location is requested on page load. **Denial is a first-class state, not an error** — the map must remain fully useful centred on the pilot zone.
- Three services: water, electricity, internet. Wire values stay `water` / `electricity` / `internet`; visible labels are Spanish (Agua / Luz / Internet).
- Publication requires two or more approved pilot zones and a valid H3 resolution. Outside an approved zone, nothing publishes.
- Report statuses are binary: service is out, or service is back.
- Only three services and two or more zones exist. The interface must look deliberate when it is nearly empty, because most of the time it will be.

## Brand Commitments

- Name: **Mis Servicios**.
- Every surface must state, permanently and unmissably, that the information is community-generated and **not** an official channel of Sedapal, Luz del Sur / Pluz Energía, or any provider. This is a legal and trust obligation, not a footnote, and it may never be reduced to a dismissible toast.
- All visitor-facing copy is neutral Spanish with tuteo, written for Lima. Never voseo.
- The product never claims provider confirmation and never presents delivery as guaranteed.

## Evidence on Hand

- A working pilot: real API, real PostgreSQL schema, real migrations, gated rollout.
- Real Lima geography — the pilot area sits around −12.0464, −77.0428 (Breña / Cercado).
- No testimonials, no user counts, no press, no partnerships, no utility endorsement. None of these may be invented anywhere in the interface.
- No logo asset exists yet; the wordmark is text.

## Product Principles

1. **Answer "does this affect me?" before anything else.** Every other panel is secondary to that one question.
2. **Consensus is the product.** Never render a single unconfirmed report as if it were fact.
3. **Privacy is structural, not a setting.** If a datum is not needed to answer the question, it is never collected, stored, or transmitted — and the interface must not create pressure to loosen that.
4. **Unofficial is permanent.** The disclaimer travels with the data everywhere the data goes.
5. **Design for the empty case.** Two zones and no active outages is the normal state, not a failure to illustrate.

## Accessibility & Inclusion

The map is a canvas and is invisible to a screen reader, so every confirmed condition must also exist as text with the same information. That text list is the accessible equivalent, not a fallback to be dropped once the map looks good. Colour alone never encodes which service is affected.

Realistic conditions include one-handed phone use, direct sunlight, a dying battery, and mobile data during a power cut.
