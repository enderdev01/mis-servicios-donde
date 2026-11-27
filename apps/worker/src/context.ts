import { ServiceUnavailableError, type RequestContext } from './app.js';
import { NoticesService } from './notices/notices.service.js';
import { PublicCellsService } from './public-map/public-cells.service.js';
import { ReportsService } from './reports/reports.service.js';
import type { Env } from './env.js';
import { issueDeviceId, limiterName, verifyDeviceId } from './trust/trust.service.js';

/** Wires the services to the D1 binding; nothing here outlives the request. */
export function createRequestContext(env: Env): RequestContext {
  return {
    reports: new ReportsService(env.DB, (h3Cell, job) => env.CELL_COORDINATOR.get(env.CELL_COORDINATOR.idFromName(h3Cell)).intake(job)),
    cells: new PublicCellsService(env.DB),
    notices: new NoticesService(env.DB),
    limits: {
      global: async (ip) => {
        // Fail closed: a missing binding is a deploy mistake, never a reason to let traffic through.
        if (!env.GLOBAL_LIMITER) throw new ServiceUnavailableError('GLOBAL_LIMITER binding is missing');
        return (await env.GLOBAL_LIMITER.limit({ key: ip })).success;
      },
      hit: async (kind, key) => {
        if (!secret()) throw new ServiceUnavailableError('DEVICE_TOKEN_SECRET is missing');
        return env.REPORT_LIMITER.get(env.REPORT_LIMITER.idFromName(limiterName(kind, key, secret()))).hit(kind);
      },
    },
    devices: {
      issue: () => (secret() ? issueDeviceId(secret()) : undefined),
      verify: (value) => verifyDeviceId(value, secret()),
    },
    dispose: () => Promise.resolve(),
  };
}

const secret = (): string => process.env.DEVICE_TOKEN_SECRET?.trim() ?? '';
