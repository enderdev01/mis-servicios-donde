import { DurableObject } from 'cloudflare:workers';

import { AlertsService, dispatchCycleDelayMs, idleIntervalNormalizationWarning } from '../alerts/alerts.service.js';
import { ConsensusService } from '../consensus/consensus.service.js';
import { DatabasePool } from '../database/database.pool.js';
import type { Env } from '../env.js';
import { RetentionService } from '../retention/retention.service.js';
import { configuredIntervalMs } from '../workers/interval-worker.js';
import { runDueJobs, type SchedulerState } from './scheduler-core.js';

/** Singleton ("main"): the alarm that replaces the always-on dispatch, expiry and retention timers. */
export class Scheduler extends DurableObject<Env> {
  /** Arms the first alarm when none is pending; called by the hourly cron and the first request of an isolate. */
  async ensure(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    // Read at alarm time, never at import: configuration arrives with the request, not the module load.
    const dispatchIntervalMs = configuredIntervalMs('ALERT_DISPATCH_INTERVAL_SECONDS', 30);
    const idleIntervalMs = configuredIntervalMs('ALERT_DISPATCH_IDLE_INTERVAL_SECONDS', 1800);
    const expiryIntervalMs = configuredIntervalMs('EPISODE_EXPIRY_INTERVAL_SECONDS', 300);
    const warning = idleIntervalNormalizationWarning(idleIntervalMs, dispatchIntervalMs);
    if (warning) console.warn(warning);

    const database = new DatabasePool(this.env.HYPERDRIVE.connectionString);
    try {
      const alerts = new AlertsService(database);
      const consensus = new ConsensusService(alerts, database);
      const retention = new RetentionService(database);
      const state = (await this.ctx.storage.get<SchedulerState>('state')) ?? { next: {} };
      const result = await runDueJobs(
        Date.now(),
        state,
        {
          dispatch: async () => dispatchCycleDelayMs(await alerts.dispatchPending(), dispatchIntervalMs, idleIntervalMs),
          expiry: () => consensus.expireStaleEpisodes(),
          retention: () => retention.cleanup(),
        },
        { dispatchIntervalMs, expiryIntervalMs, retentionEnabled: process.env.RETENTION_WORKER_ENABLED === 'true' },
      );
      await this.ctx.storage.put('state', result.state);
      await this.ctx.storage.setAlarm(result.nextAlarmAt);
    } finally {
      await database.close();
    }
  }
}
