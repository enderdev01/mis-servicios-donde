import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createRequestContext } from './context.js';
import type { Env } from './env.js';

const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

function fakeEnv(overrides: Partial<Env> = {}) {
  const names: string[] = [];
  const env = {
    DB: {},
    REPORT_LIMITER: { idFromName: (name: string) => (names.push(name), name), get: () => ({ hit: async () => ({ allowed: true }) }) },
    GLOBAL_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  } as unknown as Env;
  return { env, names };
}

async function limiterNameFor(secret: string): Promise<string> {
  vi.stubEnv('DEVICE_TOKEN_SECRET', secret);
  const { env, names } = fakeEnv();
  await createRequestContext(env).limits.hit('report-ip', '203.0.113.7');
  return names[0] ?? '';
}

afterEach(() => vi.unstubAllEnvs());

describe('request context limits', () => {
  it('names the limiter with a keyed hash of the client key', async () => {
    const one = await limiterNameFor('secret-one');

    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(one).not.toBe(await limiterNameFor('secret-two'));
    expect(one).not.toBe(createHash('sha256').update('report-ip-limit:203.0.113.7').digest('hex'));
  });

  it('refuses to name a limiter without the secret', async () => {
    vi.stubEnv('DEVICE_TOKEN_SECRET', '');
    const { env, names } = fakeEnv();

    await expect(createRequestContext(env).limits.hit('report-ip', '203.0.113.7')).rejects.toThrow();
    expect(names).toEqual([]);
  });

  it('answers 503 and logs once when the GLOBAL_LIMITER binding is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { env } = fakeEnv({ GLOBAL_LIMITER: undefined as unknown as Env['GLOBAL_LIMITER'] });

    const response = await createApp(createRequestContext).request('/v1/zones', { headers: { 'cf-connecting-ip': '203.0.113.7' } }, env, executionCtx);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'service_unavailable', message: 'Service unavailable.' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain('203.0.113.7');
    error.mockRestore();
  });
});
