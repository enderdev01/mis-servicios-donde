export interface CounterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
}

export interface WindowPolicy {
  maxRequests: number;
  windowMs: number;
}

export type WindowHit =
  | { allowed: true; resetAt: number }
  | { allowed: false; retryAfterSeconds: number; resetAt: number };

interface Bucket {
  count: number;
  resetAt: number;
}

const DEFAULT_REPORT_POLICY: WindowPolicy = { maxRequests: 5, windowMs: 3_600_000 };

/**
 * Fixed-window counter for one key (one client IP). The window lives in storage, not
 * in memory, because the hourly report limit has to outlive an evicted instance.
 */
export class WindowCounter {
  constructor(private readonly storage: CounterStorage, private readonly policy: WindowPolicy) {}

  async hit(now: number): Promise<WindowHit> {
    const stored = await this.storage.get<Bucket>('bucket');
    const bucket = stored && stored.resetAt > now ? stored : { count: 0, resetAt: now + this.policy.windowMs };
    if (bucket.count >= this.policy.maxRequests) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)), resetAt: bucket.resetAt };
    }
    await this.storage.put('bucket', { count: bucket.count + 1, resetAt: bucket.resetAt });
    return { allowed: true, resetAt: bucket.resetAt };
  }

  async clearIfExpired(now: number): Promise<void> {
    const stored = await this.storage.get<Bucket>('bucket');
    if (stored && stored.resetAt <= now) await this.storage.delete('bucket');
  }
}

export function reportPolicyFromEnv(environment: Record<string, string | undefined> = process.env): WindowPolicy {
  return {
    maxRequests: readPositiveInteger(environment.REPORT_RATE_LIMIT_MAX, DEFAULT_REPORT_POLICY.maxRequests),
    windowMs: readPositiveInteger(environment.REPORT_RATE_LIMIT_WINDOW_MS, DEFAULT_REPORT_POLICY.windowMs),
  };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
