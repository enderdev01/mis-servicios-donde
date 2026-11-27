import { DurableObject } from 'cloudflare:workers';

import type { ReportLimitResult } from '../app.js';
import type { Env } from '../env.js';
import { WindowCounter, policyFromEnv, type LimitKind } from './window-counter.js';

/** One instance per limited key (named by a hash of an IP or device id and the kind): the hourly limits of the public write endpoints. */
export class ReportLimiter extends DurableObject<Env> {
  async hit(kind: LimitKind): Promise<ReportLimitResult> {
    const now = Date.now();
    const result = await new WindowCounter(this.ctx.storage, policyFromEnv(kind)).hit(now);
    // Drop the stored window once it ends so idle clients leave nothing behind.
    await this.ctx.storage.setAlarm(result.resetAt);
    return result.allowed ? { allowed: true } : { allowed: false, retryAfterSeconds: result.retryAfterSeconds };
  }

  async alarm(): Promise<void> {
    await new WindowCounter(this.ctx.storage, policyFromEnv('report-ip')).clearIfExpired(Date.now());
  }
}
