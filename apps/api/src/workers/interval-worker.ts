export interface ScheduledWorker {
  stop: () => void;
}

/**
 * Bounds a requested delay between the shortest wait any worker should take
 * (its base interval) and a caller-provided ceiling, so a cycle can lengthen
 * its own wait without ever shortening it or growing it unbounded.
 */
export function clampCycleDelayMs(requestedMs: number, floorMs: number, ceilingMs: number): number {
  return Math.min(Math.max(requestedMs, floorMs), ceilingMs);
}

/**
 * Delay for the next re-arm: a cycle may resolve to a number of milliseconds
 * to request its own wait; anything else falls back to the base interval, and
 * a requested wait is never shorter than that interval.
 */
export function nextCycleDelayMs(requested: unknown, intervalMs: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return intervalMs;
  return clampCycleDelayMs(requested, intervalMs, Number.POSITIVE_INFINITY);
}

/**
 * Re-arms only after the previous cycle settles, so a cycle slower than the
 * interval never overlaps itself, and a failing cycle is retried on the next
 * tick instead of ending the worker. A cycle may resolve to a number of
 * milliseconds to schedule its own next delay.
 */
export function startIntervalWorker(run: () => number | Promise<unknown>, intervalMs: number): ScheduledWorker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const cycle = async (): Promise<void> => {
    let requestedDelay: unknown;
    try {
      requestedDelay = await run();
    } catch {
      // Swallowed on purpose: the next tick retries at the base interval.
      requestedDelay = undefined;
    }
    if (stopped) return;
    timer = setTimeout(() => void cycle(), nextCycleDelayMs(requestedDelay, intervalMs));
    timer.unref();
  };

  void cycle();

  return {
    stop: (): void => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function configuredIntervalMs(name: string, fallbackSeconds: number): number {
  const seconds = Number(process.env[name] ?? fallbackSeconds);
  return (Number.isInteger(seconds) && seconds > 0 ? seconds : fallbackSeconds) * 1000;
}
