import { describe, expect, it, vi } from 'vitest';

import { runDueJobs, type SchedulerConfig, type SchedulerHandlers } from './scheduler-core.js';

const NOW = Date.UTC(2026, 10, 1, 15, 0, 0);
const config: SchedulerConfig = { dispatchIntervalMs: 30_000, expiryIntervalMs: 300_000, retentionEnabled: false };

function handlers(overrides: Partial<SchedulerHandlers> = {}): SchedulerHandlers {
  return {
    dispatch: vi.fn(async () => 30_000),
    expiry: vi.fn(async () => undefined),
    retention: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('scheduler core', () => {
  it('runs dispatch and expiry on the first alarm and wakes at the earliest next run', async () => {
    const h = handlers();

    const result = await runDueJobs(NOW, { next: {} }, h, config);

    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.expiry).toHaveBeenCalledOnce();
    expect(h.retention).not.toHaveBeenCalled();
    expect(result.state.next).toEqual({ dispatch: NOW + 30_000, expiry: NOW + 300_000 });
    expect(result.nextAlarmAt).toBe(NOW + 30_000);
  });

  it('lets the dispatch cycle choose its own wait, never below the dispatch interval', async () => {
    const longWait = await runDueJobs(NOW, { next: {} }, handlers({ dispatch: async () => 1_800_000 }), config);
    expect(longWait.state.next.dispatch).toBe(NOW + 1_800_000);

    const tooShort = await runDueJobs(NOW, { next: {} }, handlers({ dispatch: async () => 1 }), config);
    expect(tooShort.state.next.dispatch).toBe(NOW + 30_000);

    const noAnswer = await runDueJobs(NOW, { next: {} }, handlers({ dispatch: async () => undefined }), config);
    expect(noAnswer.state.next.dispatch).toBe(NOW + 30_000);
  });

  it('does not run jobs that are not due yet', async () => {
    const h = handlers();
    const state = { next: { dispatch: NOW + 10_000, expiry: NOW + 200_000 } };

    const result = await runDueJobs(NOW, state, h, config);

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.expiry).not.toHaveBeenCalled();
    expect(result.state).toEqual(state);
    expect(result.nextAlarmAt).toBe(NOW + 10_000);
  });

  it('keeps going when a job fails and retries it at its base interval', async () => {
    const h = handlers({
      dispatch: vi.fn(async () => { throw new Error('database asleep'); }),
    });

    const result = await runDueJobs(NOW, { next: {} }, h, config);

    expect(h.expiry).toHaveBeenCalledOnce();
    expect(result.state.next.dispatch).toBe(NOW + 30_000);
  });

  it('schedules retention at the next Lima midnight and runs it daily once due', async () => {
    const enabled = { ...config, retentionEnabled: true };
    const h = handlers();

    const first = await runDueJobs(NOW, { next: {} }, h, enabled);
    // 15:00 UTC is 10:00 in Lima, so the next Lima midnight (05:00 UTC) is 14 hours away.
    expect(first.state.next.retention).toBe(NOW + 14 * 60 * 60 * 1000);
    expect(h.retention).not.toHaveBeenCalled();

    const due = first.state.next.retention as number;
    const second = await runDueJobs(due, first.state, h, enabled);
    expect(h.retention).toHaveBeenCalledOnce();
    expect(second.state.next.retention).toBe(due + 24 * 60 * 60 * 1000);
  });

  it('drops a stale retention schedule when retention is disabled', async () => {
    const result = await runDueJobs(NOW, { next: { retention: NOW + 1000 } }, handlers(), config);

    expect(result.state.next.retention).toBeUndefined();
  });
});
