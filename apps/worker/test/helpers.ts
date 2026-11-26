import { SELF } from 'cloudflare:test';
import { env as workerEnv } from 'cloudflare:workers';

import type { Env } from '../src/env.js';

// `wrangler types --include-env=false` leaves the global env empty, so the bindings are typed from src/env.ts.
export const env = workerEnv as unknown as Env & { TEST_MIGRATIONS: unknown[] };
export const db = env.DB;

/** Central Lima: inside the `cercado-de-lima` pilot zone; the same cell for every report below. */
export const lima = { latitude: -12.0464, longitude: -77.0428 };
export const limaCell = '898e62c0cdbffff';

let clientCounter = 0;

/** Each call comes from its own client IP so the per-IP report limit never interferes with a scenario. */
export function request(path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${(clientCounter += 1)}` };
  const init: RequestInit = body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) };
  return SELF.fetch(new Request(`http://worker.test${path}`, init));
}

export interface TestReport {
  deviceId: string;
  submissionId: string;
  services?: string[];
  providers?: Record<string, string>;
  status?: string;
  name?: string;
  latitude?: number;
  longitude?: number;
}

export function submit(report: TestReport): Promise<Response> {
  return request('/v1/reports', { services: ['water'], providers: { water: 'sedapal' }, status: 'outage', ...lima, ...report });
}

/** Wipes everything the app writes; PilotZone (migration data) stays. */
export async function resetDatabase(): Promise<void> {
  await db.batch(['AlertIntent', 'OutageEpisode', 'ReportDisplayName', 'ReportEvent', 'SubmissionRecord', 'AbuseRecord'].map((table) => db.prepare(`DELETE FROM "${table}"`)));
}

export async function count(table: string, where = '1 = 1', ...values: unknown[]): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS "total" FROM "${table}" WHERE ${where}`).bind(...values).first<{ total: number }>();
  return row?.total ?? 0;
}
