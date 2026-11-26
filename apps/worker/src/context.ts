import type { RequestContext } from './app.js';
import { NoticesService } from './notices/notices.service.js';
import { PublicCellsService } from './public-map/public-cells.service.js';
import { ReportsService } from './reports/reports.service.js';
import type { Env } from './env.js';

/** Wires the services to the D1 binding; nothing here outlives the request. */
export function createRequestContext(env: Env): RequestContext {
  return {
    reports: new ReportsService(env.DB, (h3Cell, job) => env.CELL_COORDINATOR.get(env.CELL_COORDINATOR.idFromName(h3Cell)).intake(job)),
    cells: new PublicCellsService(env.DB),
    notices: new NoticesService(env.DB),
    limits: {
      global: async (ip) => (env.GLOBAL_LIMITER ? (await env.GLOBAL_LIMITER.limit({ key: ip })).success : true),
      report: async (ip) => env.REPORT_LIMITER.get(env.REPORT_LIMITER.idFromName(await hashClientKey(ip))).hit(),
    },
    dispose: () => Promise.resolve(),
  };
}

/** The limiter instance is named by a digest so a client IP is never stored as an object name. */
async function hashClientKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`report-limit:${ip}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
