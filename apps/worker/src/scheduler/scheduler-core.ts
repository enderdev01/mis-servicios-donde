import { millisecondsUntilNextLimaMidnight, retentionIntervalMs } from '../retention/retention.service.js';
import { nextCycleDelayMs } from '../workers/interval-worker.js';

export type JobName = 'dispatch' | 'expiry' | 'retention';

export interface SchedulerState {
  /** Epoch milliseconds of each job's next run. A missing entry means "run now". */
  next: Partial<Record<JobName, number>>;
}

export interface SchedulerConfig {
  dispatchIntervalMs: number;
  expiryIntervalMs: number;
  retentionEnabled: boolean;
}

export interface SchedulerHandlers {
  /** Resolves to the delay the outbox wants before the next cycle; anything else means "use the base interval". */
  dispatch: () => Promise<unknown>;
  expiry: () => Promise<unknown>;
  retention: () => Promise<unknown>;
}

/**
 * One alarm drives every background job, replacing the three always-on timers of
 * the Node process. Each job keeps its own next run, so a short dispatch wait never
 * drags the slower jobs along and the alarm only fires for work that is due.
 */
export async function runDueJobs(
  now: number,
  state: SchedulerState,
  handlers: SchedulerHandlers,
  config: SchedulerConfig,
): Promise<{ state: SchedulerState; nextAlarmAt: number }> {
  const next = { ...state.next };

  if (!config.retentionEnabled) delete next.retention;
  else next.retention ??= now + millisecondsUntilNextLimaMidnight(new Date(now));

  if (isDue(next.dispatch, now)) {
    next.dispatch = now + nextCycleDelayMs(await attempt(handlers.dispatch), config.dispatchIntervalMs);
  }
  if (isDue(next.expiry, now)) {
    await attempt(handlers.expiry);
    next.expiry = now + config.expiryIntervalMs;
  }
  if (config.retentionEnabled && isDue(next.retention, now)) {
    await attempt(handlers.retention);
    next.retention = now + retentionIntervalMs;
  }

  return { state: { next }, nextAlarmAt: Math.min(...Object.values(next)) };
}

function isDue(at: number | undefined, now: number): boolean {
  return at === undefined || at <= now;
}

/** A failing job is retried at its base interval instead of stopping the others. */
async function attempt(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}
