import { describe, expect, it } from 'vitest';

import { WindowCounter, reportPolicyFromEnv, type CounterStorage } from './window-counter.js';

function memoryStorage(): CounterStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    put: <T>(key: string, value: T) => Promise.resolve(void data.set(key, value)),
    delete: (key: string) => Promise.resolve(data.delete(key)),
  };
}

const policy = { maxRequests: 2, windowMs: 60_000 };
const T0 = 1_000_000;

describe('window counter', () => {
  it('allows requests up to the maximum and then rejects with the seconds left in the window', async () => {
    const counter = new WindowCounter(memoryStorage(), policy);

    expect(await counter.hit(T0)).toEqual({ allowed: true, resetAt: T0 + 60_000 });
    expect(await counter.hit(T0 + 1_000)).toEqual({ allowed: true, resetAt: T0 + 60_000 });
    expect(await counter.hit(T0 + 2_500)).toEqual({ allowed: false, retryAfterSeconds: 58, resetAt: T0 + 60_000 });
  });

  it('starts a new window once the previous one has elapsed', async () => {
    const counter = new WindowCounter(memoryStorage(), policy);
    await counter.hit(T0);
    await counter.hit(T0);

    expect(await counter.hit(T0 + 60_000)).toEqual({ allowed: true, resetAt: T0 + 120_000 });
  });

  it('survives losing the in-memory instance because the window lives in storage', async () => {
    const storage = memoryStorage();
    await new WindowCounter(storage, policy).hit(T0);
    await new WindowCounter(storage, policy).hit(T0);

    const result = await new WindowCounter(storage, policy).hit(T0 + 1000);

    expect(result.allowed).toBe(false);
  });

  it('never reports less than one second to wait', async () => {
    const counter = new WindowCounter(memoryStorage(), { maxRequests: 1, windowMs: 60_000 });
    await counter.hit(T0);

    expect(await counter.hit(T0 + 59_999)).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
  });

  it('clears an expired window and keeps a live one', async () => {
    const storage = memoryStorage();
    const counter = new WindowCounter(storage, policy);
    await counter.hit(T0);

    await counter.clearIfExpired(T0 + 1000);
    expect(storage.data.size).toBe(1);

    await counter.clearIfExpired(T0 + 60_000);
    expect(storage.data.size).toBe(0);
  });
});

describe('report policy', () => {
  it('defaults to five reports per hour', () => {
    expect(reportPolicyFromEnv({})).toEqual({ maxRequests: 5, windowMs: 3_600_000 });
  });

  it('reads positive integers and falls back on anything else', () => {
    expect(reportPolicyFromEnv({ REPORT_RATE_LIMIT_MAX: '3', REPORT_RATE_LIMIT_WINDOW_MS: '10000' })).toEqual({ maxRequests: 3, windowMs: 10_000 });
    expect(reportPolicyFromEnv({ REPORT_RATE_LIMIT_MAX: '0', REPORT_RATE_LIMIT_WINDOW_MS: 'soon' })).toEqual({ maxRequests: 5, windowMs: 3_600_000 });
  });
});
