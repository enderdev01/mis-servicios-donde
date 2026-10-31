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

export function configuredIntervalMs(name: string, fallbackSeconds: number): number {
  const seconds = Number(process.env[name] ?? fallbackSeconds);
  return (Number.isInteger(seconds) && seconds > 0 ? seconds : fallbackSeconds) * 1000;
}
