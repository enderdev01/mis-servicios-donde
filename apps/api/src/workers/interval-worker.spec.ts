import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configuredIntervalMs, startIntervalWorker } from './interval-worker.js';

describe('interval worker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a first cycle immediately', async () => {
    const run = vi.fn().mockResolvedValue(undefined);

    const worker = startIntervalWorker(run, 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it('never overlaps a cycle slower than the interval', async () => {
    let settle = (): void => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));

    const worker = startIntervalWorker(run, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);

    settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it('keeps running after a failing cycle', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('provider down')).mockResolvedValue(undefined);

    const worker = startIntervalWorker(run, 1000);
    await vi.advanceTimersByTimeAsync(2500);

    expect(run).toHaveBeenCalledTimes(3);
    worker.stop();
  });

  it('schedules the longer delay a cycle requests when it resolves to a number', async () => {
    const run = vi.fn().mockResolvedValue(50_000);

    const worker = startIntervalWorker(run, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it('retries a failing cycle on the next tick at the base interval', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('outbox unreachable')).mockResolvedValue(50_000);

    const worker = startIntervalWorker(run, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it('stops re-arming once stopped', async () => {
    const run = vi.fn().mockResolvedValue(undefined);

    const worker = startIntervalWorker(run, 1000);
    await vi.advanceTimersByTimeAsync(0);
    worker.stop();
    await vi.advanceTimersByTimeAsync(10000);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

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
