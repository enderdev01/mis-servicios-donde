export type SheetState = 'peek' | 'open';

/** A release faster than this (px per ms) is a flick, whatever the distance. */
export const FLICK_PX_PER_MS = .11;
/** A slower release settles on the other state once it has travelled this share of the way. */
export const SETTLE_RATIO = .4;

/**
 * Where the bottom sheet lands when the handle is released. `dy` is the pointer
 * travel since the press (negative is upward), `travel` the distance between
 * "peek" and "open". A short, slow drag springs back to where it started.
 */
export function settleSheet(dy: number, elapsedMs: number, travel: number, from: SheetState): SheetState {
  const flick = Math.abs(dy) / Math.max(elapsedMs, 1) > FLICK_PX_PER_MS;
  if (flick || Math.abs(dy) > travel * SETTLE_RATIO) return dy < 0 ? 'open' : 'peek';
  return from;
}
