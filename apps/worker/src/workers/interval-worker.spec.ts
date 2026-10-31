import { afterEach, describe, expect, it } from 'vitest';

import { configuredIntervalMs } from './interval-worker.js';

describe('cycle delay decision', () => {
  it('clamps a requested delay to the configured bounds', async () => {
    const { clampCycleDelayMs } = await import('./interval-worker.js');

    expect(clampCycleDelayMs(90_000, 30_000, 1_800_000)).toBe(90_000);
    expect(clampCycleDelayMs(5_000, 30_000, 1_800_000)).toBe(30_000);
    expect(clampCycleDelayMs(7_200_000, 30_000, 1_800_000)).toBe(1_800_000);
  });

  it('falls back to the interval when a cycle does not resolve to a number', async () => {
    const { nextCycleDelayMs } = await import('./interval-worker.js');

    expect(nextCycleDelayMs(undefined, 1000)).toBe(1000);
    expect(nextCycleDelayMs({ claimedWork: false }, 1000)).toBe(1000);
    expect(nextCycleDelayMs(Number.NaN, 1000)).toBe(1000);
  });

  it('never re-arms sooner than the interval even when a cycle requests less', async () => {
    const { nextCycleDelayMs } = await import('./interval-worker.js');

    expect(nextCycleDelayMs(10, 1000)).toBe(1000);
  });
});

describe('interval configuration', () => {
  afterEach(() => { delete process.env.TEST_INTERVAL_SECONDS; });

  it('reads a positive integer of seconds as milliseconds', () => {
    process.env.TEST_INTERVAL_SECONDS = '45';

    expect(configuredIntervalMs('TEST_INTERVAL_SECONDS', 30)).toBe(45000);
  });

  it('falls back when the value is absent, zero, negative, or not a number', () => {
    expect(configuredIntervalMs('TEST_INTERVAL_SECONDS', 30)).toBe(30000);
    for (const value of ['0', '-5', 'soon', '1.5']) {
      process.env.TEST_INTERVAL_SECONDS = value;
      expect(configuredIntervalMs('TEST_INTERVAL_SECONDS', 30)).toBe(30000);
    }
  });
});
