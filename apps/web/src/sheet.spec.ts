import { describe, expect, it } from 'vitest';

import { settleSheet } from './sheet.js';

describe('sheet settling', () => {
  it('springs back after a short, slow drag', () => {
    expect(settleSheet(-60, 1_000, 400, 'peek')).toBe('peek');
    expect(settleSheet(60, 1_000, 400, 'open')).toBe('open');
  });

  it('settles on the other state once 40% of the travel is covered', () => {
    expect(settleSheet(-161, 2_000, 400, 'peek')).toBe('open');
    expect(settleSheet(161, 2_000, 400, 'open')).toBe('peek');
    expect(settleSheet(-159, 2_000, 400, 'peek')).toBe('peek');
  });

  it('follows the direction of a flick, however short', () => {
    expect(settleSheet(-30, 100, 400, 'peek')).toBe('open');
    expect(settleSheet(30, 100, 400, 'open')).toBe('peek');
    // A flick against the current state keeps it: flicking down from peek stays in peek.
    expect(settleSheet(30, 100, 400, 'peek')).toBe('peek');
  });

  it('never divides by a zero duration', () => {
    expect(settleSheet(-5, 0, 400, 'peek')).toBe('open');
  });
});
