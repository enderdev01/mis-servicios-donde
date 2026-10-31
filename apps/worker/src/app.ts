import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import type { Env } from './env.js';
import { ZoneNotFoundError, type NoticesService } from './notices/notices.service.js';
import type { PublicCellsService } from './public-map/public-cells.service.js';
import { ReportRequestError } from './reports/report-input.js';
import type { ReportsService } from './reports/reports.service.js';

const JSON_BODY_LIMIT_BYTES = 10 * 1024;

export type ReportLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Everything one request needs; built per request so no connection outlives it. */
export interface RequestContext {
  reports: { accept: ReportsService['accept'] };
  cells: { listCells: PublicCellsService['listCells'] };
  notices: { listApprovedZones: NoticesService['listApprovedZones']; forApprovedZone: NoticesService['forApprovedZone'] };
  limits: {
    /** False once the client IP exceeded the global limit. */
    global(ip: string): Promise<boolean>;
    report(ip: string): Promise<ReportLimitResult>;
  };
  dispose(): Promise<void>;
}

export function createApp(makeContext: (env: Env) => RequestContext) {
  const app = new Hono<{ Bindings: Env; Variables: { api: RequestContext } }>();
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
    return c.json({ code: 'rate_limited', message: 'Too many requests.' }, 429);
  });

  app.get('/health', (c) => c.json({ status: 'ok' as const }));

  app.post(
    '/v1/reports',
    async (c, next) => {
      const result = await c.var.api.limits.report(clientIp(c.req.header('cf-connecting-ip')));
      if (result.allowed) return next();
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json({ code: 'rate_limited', message: 'Too many requests.' }, 429);
    },
    bodyLimit({
      maxSize: JSON_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ code: 'payload_too_large', message: 'Request body too large.' }, 413),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      try {
        return c.json(await c.var.api.reports.accept(body), 201);
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

  app.onError((_error, c) => c.json({ statusCode: 500, message: 'Internal server error' }, 500));

  return app;
}
