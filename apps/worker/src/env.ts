import type { CellCoordinator } from './consensus/cell-coordinator.js';
import type { ReportLimiter } from './security/report-limiter.js';
import type { Scheduler } from './scheduler/scheduler.js';

/** Bindings only. Product gates and secrets are plain text vars read through `process.env` (nodejs_compat). */
export interface Env {
  DB: D1Database;
  SCHEDULER: DurableObjectNamespace<Scheduler>;
  REPORT_LIMITER: DurableObjectNamespace<ReportLimiter>;
  CELL_COORDINATOR: DurableObjectNamespace<CellCoordinator>;
  GLOBAL_LIMITER: RateLimit;
  WEB_ORIGIN?: string;
}
