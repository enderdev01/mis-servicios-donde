import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { verifyDeviceId } from '../src/trust/trust.service.js';
import { lima, request, resetDatabase, submit } from './helpers.js';

beforeEach(resetDatabase);

const body = (deviceId: string) => ({ submissionId: crypto.randomUUID(), services: ['water'], providers: { water: 'sedapal' }, status: 'outage', ...lima, deviceId });

/** One fixed client IP, so the per-IP windows are exercised. */
function from(ip: string, path: string, payload: unknown = {}): Promise<Response> {
  return SELF.fetch(new Request(`http://worker.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(payload) }));
}

async function issue(): Promise<string> {
  const { deviceId } = await (await request('/v1/device', {})).json<{ deviceId: string }>();
  return deviceId;
}

describe('POST /v1/device', () => {
  it('issues a signed id the server accepts, then caps the IP at 60 an hour', async () => {
    const first = await from('198.51.100.1', '/v1/device');
    expect(first.status).toBe(201);
    const { deviceId } = await first.json<{ deviceId: string }>();
    expect(verifyDeviceId(deviceId, 'test-device-secret')).toBeTruthy();

    for (let issued = 1; issued < 60; issued += 1) expect((await from('198.51.100.1', '/v1/device')).status).toBe(201);
    const capped = await from('198.51.100.1', '/v1/device');
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await capped.json()).toMatchObject({ code: 'rate_limited', message: 'Too many requests.' });
  });
});

describe('device identity on POST /v1/reports', () => {
  it('refuses a bare UUID and a tampered signature with 401 device_invalid', async () => {
    const issued = await issue();
    const tampered = `${issued.slice(0, -1)}${issued.endsWith('0') ? '1' : '0'}`;

    for (const deviceId of [crypto.randomUUID(), tampered]) {
      const response = await request('/v1/reports', body(deviceId));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: 'device_invalid', message: 'Device identifier is not valid.' });
    }
  });

  it('stops the sixth report of one signed device in the hour while another device from the same IP still gets through', async () => {
    const ip = '198.51.100.2';
    const [busy, other] = [await issue(), await issue()];
    // Repeats of one device are 201 then 409 already_reported; the device limiter runs first, so only the sixth is 429.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) statuses.push((await from(ip, '/v1/reports', body(busy))).status);

    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);
    const limited = await from(ip, '/v1/reports', body(busy));
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    const rejection = await limited.json<{ code: string; retryAfterSeconds: number }>();
    expect(rejection.code).toBe('rate_limited');
    expect(rejection.retryAfterSeconds).toBeGreaterThan(0);

    expect((await from(ip, '/v1/reports', body(other))).status).toBe(201);
    expect((await submit({ deviceId: 'helper-signed', submissionId: 'helper-1' })).status).toBe(201);
  });
});
