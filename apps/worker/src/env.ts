import type { ReportLimiter } from './security/report-limiter.js';
import type { Scheduler } from './scheduler/scheduler.js';

/** Bindings only. Product gates and secrets are plain text vars read through `process.env` (nodejs_compat). */
export interface Env {
  HYPERDRIVE: Hyperdrive;
  SCHEDULER: DurableObjectNamespace<Scheduler>;
  REPORT_LIMITER: DurableObjectNamespace<ReportLimiter>;
  GLOBAL_LIMITER?: RateLimit;
  WEB_ORIGIN?: string;
}
