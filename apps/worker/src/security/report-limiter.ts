import { DurableObject } from 'cloudflare:workers';

import type { ReportLimitResult } from '../app.js';
import type { Env } from '../env.js';
import { WindowCounter, reportPolicyFromEnv } from './window-counter.js';

/** One instance per client (named by a hash of its IP): the hourly `POST /v1/reports` limit. */
export class ReportLimiter extends DurableObject<Env> {
  async hit(): Promise<ReportLimitResult> {
    const now = Date.now();
    const result = await new WindowCounter(this.ctx.storage, reportPolicyFromEnv()).hit(now);
    // Drop the stored window once it ends so idle clients leave nothing behind.
    await this.ctx.storage.setAlarm(result.resetAt);
    return result.allowed ? { allowed: true } : { allowed: false, retryAfterSeconds: result.retryAfterSeconds };
  }

  async alarm(): Promise<void> {
    await new WindowCounter(this.ctx.storage, reportPolicyFromEnv()).clearIfExpired(Date.now());
  }
}
