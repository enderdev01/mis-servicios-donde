import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import type { Env } from './env.js';
import { ZoneNotFoundError, type NoticesService } from './notices/notices.service.js';
import type { PublicCellsService } from './public-map/public-cells.service.js';
import { ReportRequestError } from './reports/report-input.js';
import type { ReportsService } from './reports/reports.service.js';
import type { LimitKind } from './security/window-counter.js';

const JSON_BODY_LIMIT_BYTES = 10 * 1024;

/** A server-side dependency the request cannot be served safely without (limiter binding, signing secret); answers 503. */
export class ServiceUnavailableError extends Error {}

export type ReportLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Everything one request needs; built per request so no connection outlives it. */
export interface RequestContext {
  reports: { accept: ReportsService['accept'] };
  cells: { listCells: PublicCellsService['listCells'] };
  notices: { listApprovedZones: NoticesService['listApprovedZones']; forApprovedZone: NoticesService['forApprovedZone'] };
  limits: {
    /** False once the client IP exceeded the global limit. */
    global(ip: string): Promise<boolean>;
    /** One hit on the hourly window `kind` for `key` (a client IP or a verified device id). */
    hit(kind: LimitKind, key: string): Promise<ReportLimitResult>;
  };
  devices: {
    /** A fresh signed device id, or undefined when the signing secret is missing. */
    issue(): string | undefined;
    /** The id inside a signed device id, or undefined when the signature is not genuine. */
    verify(value: unknown): string | undefined;
  };
  dispose(): Promise<void>;
}

type AppEnv = { Bindings: Env; Variables: { api: RequestContext } };

export function createApp(makeContext: (env: Env) => RequestContext) {
  const app = new Hono<AppEnv>();
  const clientIp = (header: string | undefined): string => header?.trim() || 'unknown';

  app.use('*', async (c, next) => {
    const api = makeContext(c.env);
    c.set('api', api);
    try {
      await next();
    } finally {
      c.executionCtx.waitUntil(api.dispose());
    }
  });
  app.use('*', secureHeaders());
  // Same-origin through the web proxy is the default; CORS opens only for an explicit WEB_ORIGIN.
  app.use('*', cors({ origin: (origin, c: Context<{ Bindings: Env }>) => (origin === c.env.WEB_ORIGIN?.trim() ? origin : null) }));
  app.use('*', async (c, next) => {
    if (await c.var.api.limits.global(clientIp(c.req.header('cf-connecting-ip')))) return next();
    c.header('Retry-After', '60');
    return c.json({ code: 'rate_limited', message: 'Too many requests.', retryAfterSeconds: 60 }, 429);
  });

  app.get('/health', (c) => c.json({ status: 'ok' as const }));

  /** Null when the hit is allowed; otherwise the 429 response. */
  const limited = async (c: Context<AppEnv>, kind: LimitKind, key: string) => {
    const result = await c.var.api.limits.hit(kind, key);
    if (result.allowed) return null;
    c.header('Retry-After', String(result.retryAfterSeconds));
    return c.json({ code: 'rate_limited', message: 'Too many requests.', retryAfterSeconds: result.retryAfterSeconds }, 429);
  };

  app.post('/v1/device', async (c) => {
    const blocked = await limited(c, 'device-issue', clientIp(c.req.header('cf-connecting-ip')));
    if (blocked) return blocked;
    const deviceId = c.var.api.devices.issue();
    // Never fall back to an unsigned id: it would let any browser pick its own.
    if (!deviceId) return c.json({ code: 'device_unavailable', message: 'Unable to issue device identifier.' }, 503);
    return c.json({ deviceId }, 201);
  });

  app.post(
    '/v1/reports',
    async (c, next) => (await limited(c, 'report-ip', clientIp(c.req.header('cf-connecting-ip')))) ?? next(),
    bodyLimit({
      maxSize: JSON_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ code: 'payload_too_large', message: 'Request body too large.' }, 413),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const signed = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).deviceId : undefined;
      const deviceId = c.var.api.devices.verify(signed);
      if (deviceId === undefined) return c.json({ code: 'device_invalid', message: 'Device identifier is not valid.' }, 401);
      const blocked = await limited(c, 'report-device', deviceId);
      if (blocked) return blocked;
      try {
        // The service sees the verified id, never the signed form.
        return c.json(await c.var.api.reports.accept({ ...(body as object), deviceId }), 201);
      } catch (error) {
        if (error instanceof ReportRequestError) return c.json(error.body, error.status);
        return c.json({ code: 'report_unavailable', message: 'Unable to process report.' }, 500);
      }
    },
  );

  app.get('/v1/cells', async (c) => c.json(await c.var.api.cells.listCells(c.req.query('service'), c.req.query('provider'))));

  app.get('/v1/zones', async (c) => c.json(await c.var.api.notices.listApprovedZones()));

  app.get('/v1/zones/:slug/notice', async (c) => {
    try {
      return c.json(await c.var.api.notices.forApprovedZone(c.req.param('slug')));
    } catch (error) {
      if (error instanceof ZoneNotFoundError) return c.json({ statusCode: 404, message: 'Not Found' }, 404);
      throw error;
    }
  });

  app.onError((error, c) => {
    if (error instanceof ServiceUnavailableError) {
      // One log per request, no client data.
      console.error(`service unavailable: ${error.message}`);
      return c.json({ code: 'service_unavailable', message: 'Service unavailable.' }, 503);
    }
    return c.json({ statusCode: 500, message: 'Internal server error' }, 500);
  });

  return app;
}
