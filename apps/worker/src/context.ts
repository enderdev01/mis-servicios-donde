import { AlertsService } from './alerts/alerts.service.js';
import type { RequestContext } from './app.js';
import { ConsensusService } from './consensus/consensus.service.js';
import { DatabasePool } from './database/database.pool.js';
import type { Env } from './env.js';
import { NoticesService } from './notices/notices.service.js';
import { PublicCellsService } from './public-map/public-cells.service.js';
import { ReportsService } from './reports/reports.service.js';

/** Wires the services to one request-scoped database; nothing here outlives the request. */
export function createRequestContext(env: Env): RequestContext {
  const database = new DatabasePool(env.HYPERDRIVE.connectionString);
  const consensus = new ConsensusService(new AlertsService(database), database);
  return {
    reports: new ReportsService(consensus, database),
    cells: new PublicCellsService(database),
    notices: new NoticesService(database),
    limits: {
      global: async (ip) => (env.GLOBAL_LIMITER ? (await env.GLOBAL_LIMITER.limit({ key: ip })).success : true),
      report: async (ip) => env.REPORT_LIMITER.get(env.REPORT_LIMITER.idFromName(await hashClientKey(ip))).hit(),
    },
    dispose: () => database.close(),
  };
}

/** The limiter instance is named by a digest so a client IP is never stored as an object name. */
async function hashClientKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`report-limit:${ip}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
