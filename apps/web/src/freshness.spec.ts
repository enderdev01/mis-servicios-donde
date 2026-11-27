import { describe, expect, it } from 'vitest';

import { formatFreshness } from './freshness.js';

describe('freshness label', () => {
  it('says a moment for under a minute, and never a negative time', () => {
    expect(formatFreshness(1_000, 1_000)).toBe('Actualizado hace un momento');
    expect(formatFreshness(1_000, 59_000)).toBe('Actualizado hace un momento');
    expect(formatFreshness(5_000, 1_000)).toBe('Actualizado hace un momento');
  });

  it('counts whole minutes under an hour', () => {
    expect(formatFreshness(0, 60_000)).toBe('Actualizado hace 1 min');
    expect(formatFreshness(0, 12 * 60_000 + 59_000)).toBe('Actualizado hace 12 min');
  });

  it('counts whole hours after that', () => {
    expect(formatFreshness(0, 60 * 60_000)).toBe('Actualizado hace 1 h');
    expect(formatFreshness(0, 5 * 3_600_000 + 1)).toBe('Actualizado hace 5 h');
  });
});
