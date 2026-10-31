import { describe, expect, it, vi } from 'vitest';

import { createApp, type RequestContext } from './app.js';
import { ZoneNotFoundError } from './notices/notices.service.js';
import type { PublicCell } from './public-map/public-cells.service.js';
import { ReportRequestError } from './reports/report-input.js';

const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    reports: { accept: vi.fn(async () => ({ submissionId: 's-1', accepted: true as const })) },
    cells: { listCells: vi.fn(async () => []) },
    notices: {
      listApprovedZones: vi.fn(async () => []),
      forApprovedZone: vi.fn(async () => ({ title: 't', zone: 'z', instructions: 'i', mapUrl: '/', notice: 'n' })),
    },
    limits: {
      global: vi.fn(async () => true),
      report: vi.fn(async () => ({ allowed: true as const })),
    },
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

function call(ctx: RequestContext, path: string, init?: RequestInit, env: Record<string, unknown> = {}) {
  return createApp(() => ctx).request(path, init, env, executionCtx);
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('worker app', () => {
  it('answers health without touching limits that need a database', async () => {
    const response = await call(context(), '/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('accepts a report with 201 like the Nest controller and passes the parsed body through', async () => {
    const ctx = context();

    const response = await call(ctx, '/v1/reports', post({ submissionId: 'abc' }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ submissionId: 's-1', accepted: true });
    expect(ctx.reports.accept).toHaveBeenCalledWith({ submissionId: 'abc' });
  });

  it('maps a rejected report to its status and body, and hides unexpected failures', async () => {
    const rejected = context({
      reports: { accept: vi.fn(async () => { throw new ReportRequestError(409, { code: 'already_reported', message: 'This device already reported a cut.' }); }) },
    });
    const conflict = await call(rejected, '/v1/reports', post({}));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: 'already_reported', message: 'This device already reported a cut.' });

    const broken = context({ reports: { accept: vi.fn(async () => { throw new Error('connection reset'); }) } });
    const failure = await call(broken, '/v1/reports', post({}));
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({ code: 'report_unavailable', message: 'Unable to process report.' });
  });

  it('treats an unparseable body as an empty report so the generic refusal applies', async () => {
    const ctx = context();

    await call(ctx, '/v1/reports', post('not json'));

    expect(ctx.reports.accept).toHaveBeenCalledWith(undefined);
  });

  it('rejects bodies over 10 kB before any service runs', async () => {
    const ctx = context();

    const response = await call(ctx, '/v1/reports', post({ padding: 'x'.repeat(11_000) }));

    expect(response.status).toBe(413);
    expect(ctx.reports.accept).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After when the global limit is exhausted', async () => {
    const ctx = context({ limits: { global: vi.fn(async () => false), report: vi.fn(async () => ({ allowed: true as const })) } });

    const response = await call(ctx, '/v1/cells');

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({ code: 'rate_limited', message: 'Too many requests.' });
    expect(ctx.cells.listCells).not.toHaveBeenCalled();
  });

  it('applies the per-IP report limit to POST /v1/reports only and reports the wait', async () => {
    const ctx = context({ limits: { global: vi.fn(async () => true), report: vi.fn(async () => ({ allowed: false as const, retryAfterSeconds: 1800 })) } });

    const blocked = await call(ctx, '/v1/reports', post({}));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('1800');
    expect(ctx.reports.accept).not.toHaveBeenCalled();
    expect(ctx.limits.report).toHaveBeenCalledWith('203.0.113.7');

    const read = await call(ctx, '/v1/cells');
    expect(read.status).toBe(200);
  });

  it('forwards the cell filters and returns the cells', async () => {
    const cells: PublicCell[] = [{ h3Cell: '8928', service: 'water', provider: 'sedapal', confirmed: true, reports: 3 }];
    const ctx = context({ cells: { listCells: vi.fn(async () => cells) } });

    const response = await call(ctx, '/v1/cells?service=water&provider=sedapal');

    expect(await response.json()).toEqual(cells);
    expect(ctx.cells.listCells).toHaveBeenCalledWith('water', 'sedapal');
  });

  it('lists approved zones and serves a printable notice, with 404 for an unknown slug', async () => {
    const ctx = context({
      notices: {
        listApprovedZones: vi.fn(async () => [{ slug: 'lince', name: 'Lince', boundary: { minLatitude: 0, maxLatitude: 1, minLongitude: 0, maxLongitude: 1 } }]),
        forApprovedZone: vi.fn(async (slug: string) => {
          if (slug !== 'lince') throw new ZoneNotFoundError();
          return { title: 'Aviso', zone: 'Lince', instructions: 'i', mapUrl: '/', notice: 'n' };
        }),
      },
    });

    expect(await (await call(ctx, '/v1/zones')).json()).toHaveLength(1);
    expect((await call(ctx, '/v1/zones/lince/notice')).status).toBe(200);
    const missing = await call(ctx, '/v1/zones/nowhere/notice');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ statusCode: 404, message: 'Not Found' });
  });

  it('sets security headers and releases database connections after the response', async () => {
    const ctx = context();

    const response = await call(ctx, '/health');

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(executionCtx.waitUntil).toHaveBeenCalled();
    expect(ctx.dispose).toHaveBeenCalled();
  });

  it('allows only the configured web origin through CORS', async () => {
    const allowed = await call(context(), '/health', { headers: { origin: 'https://web.example' } }, { WEB_ORIGIN: 'https://web.example' });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://web.example');

    const unset = await call(context(), '/health', { headers: { origin: 'https://web.example' } });
    expect(unset.headers.get('access-control-allow-origin')).toBeNull();
  });
});
