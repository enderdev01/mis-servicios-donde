import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AlertsService, startAlertDispatchWorker } from '../alerts/alerts.service.js';
import { type ConsensusService, startEpisodeExpiryWorker } from '../consensus/consensus.service.js';
import { millisecondsUntilNextLimaMidnight, type RetentionService, startRetentionWorker } from '../retention/retention.service.js';

describe('worker wiring', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drives alert dispatch so opening intents leave the outbox', async () => {
    const dispatchPending = vi.fn().mockResolvedValue(undefined);

    const worker = startAlertDispatchWorker({ dispatchPending } as unknown as AlertsService);
    await vi.advanceTimersByTimeAsync(0);

    expect(dispatchPending).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it('drives episode expiry so elapsed outages stop being active', async () => {
    const expireStaleEpisodes = vi.fn().mockResolvedValue(undefined);

    const worker = startEpisodeExpiryWorker({ expireStaleEpisodes } as unknown as ConsensusService);
    await vi.advanceTimersByTimeAsync(0);

    expect(expireStaleEpisodes).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it('calculates the delay to the next midnight in Lima', () => {
    expect(millisecondsUntilNextLimaMidnight(new Date('2026-08-31T04:00:00.000Z'))).toBe(60 * 60 * 1000);
    expect(millisecondsUntilNextLimaMidnight(new Date('2026-08-31T05:00:00.000Z'))).toBe(24 * 60 * 60 * 1000);
  });

  it('starts retention cleanup at the next Lima midnight and repeats daily', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);

    const worker = startRetentionWorker({ cleanup } as unknown as RetentionService, new Date('2026-08-31T04:00:00.000Z'));
    await vi.advanceTimersByTimeAsync(0);

    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(cleanup).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it('keeps dispatching after a provider outage instead of dying', async () => {
    const dispatchPending = vi.fn().mockRejectedValueOnce(new Error('telegram down')).mockResolvedValue(undefined);

    const worker = startAlertDispatchWorker({ dispatchPending } as unknown as AlertsService);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(dispatchPending.mock.calls.length).toBeGreaterThan(1);
    worker.stop();
  });

  it('waits for the idle interval after an empty outbox instead of the dispatch interval', async () => {
    const dispatchPending = vi.fn().mockResolvedValue({ claimedWork: false, nextDueInSeconds: null });

    const worker = startAlertDispatchWorker({ dispatchPending } as unknown as AlertsService);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dispatchPending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_770_000);
    expect(dispatchPending).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it('keeps the dispatch interval while the outbox claimed work', async () => {
    const dispatchPending = vi.fn().mockResolvedValue({ claimedWork: true, nextDueInSeconds: null });

    const worker = startAlertDispatchWorker({ dispatchPending } as unknown as AlertsService);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(dispatchPending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatchPending).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it('warns once at startup when the idle interval sits below the dispatch interval', async () => {
    const previousInterval = process.env.ALERT_DISPATCH_INTERVAL_SECONDS;
    const previousIdle = process.env.ALERT_DISPATCH_IDLE_INTERVAL_SECONDS;
    process.env.ALERT_DISPATCH_INTERVAL_SECONDS = '3600';
    process.env.ALERT_DISPATCH_IDLE_INTERVAL_SECONDS = '1800';
    vi.resetModules();
    try {
      const { startAlertDispatchWorker } = await import('../alerts/alerts.service.js');
      const dispatchPending = vi.fn().mockResolvedValue({ claimedWork: false, nextDueInSeconds: null });
      const warn = vi.fn();

      const worker = startAlertDispatchWorker({ dispatchPending } as unknown as AlertsService, warn);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3_600_000);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('ALERT_DISPATCH_IDLE_INTERVAL_SECONDS');
      expect(warn.mock.calls[0]?.[0]).toContain('ALERT_DISPATCH_INTERVAL_SECONDS');
      expect(dispatchPending).toHaveBeenCalledTimes(2);
      worker.stop();
    } finally {
      if (previousInterval === undefined) delete process.env.ALERT_DISPATCH_INTERVAL_SECONDS; else process.env.ALERT_DISPATCH_INTERVAL_SECONDS = previousInterval;
      if (previousIdle === undefined) delete process.env.ALERT_DISPATCH_IDLE_INTERVAL_SECONDS; else process.env.ALERT_DISPATCH_IDLE_INTERVAL_SECONDS = previousIdle;
    }
  });

  it('does not warn at startup when the idle interval already honors the dispatch floor', async () => {
    const previousIdle = process.env.ALERT_DISPATCH_IDLE_INTERVAL_SECONDS;
    delete process.env.ALERT_DISPATCH_IDLE_INTERVAL_SECONDS;
    try {
      const dispatchPending = vi.fn().mockResolvedValue({ claimedWork: false, nextDueInSeconds: null });
      const warn = vi.fn();

      const worker = startAlertDispatchWorker({ dispatchPending } as unknown as AlertsService, warn);
      await vi.advanceTimersByTimeAsync(0);

      expect(warn).not.toHaveBeenCalled();
      worker.stop();
    } finally {
      if (previousIdle === undefined) delete process.env.ALERT_DISPATCH_IDLE_INTERVAL_SECONDS; else process.env.ALERT_DISPATCH_IDLE_INTERVAL_SECONDS = previousIdle;
    }
  });
});
