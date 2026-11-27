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

const DEFAULT_REPORT_POLICY: WindowPolicy = { maxRequests: 60, windowMs: 3_600_000 };

/**
 * Fixed-window counter for one key (a client IP or a device id). The window lives in storage, not
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

export type LimitKind = 'report-ip' | 'report-device' | 'device-issue';

const POLICIES: Record<LimitKind, { prefix: string; defaults: WindowPolicy }> = {
  'report-ip': { prefix: 'REPORT_RATE_LIMIT', defaults: DEFAULT_REPORT_POLICY },
  'report-device': { prefix: 'DEVICE_REPORT_RATE_LIMIT', defaults: { maxRequests: 5, windowMs: 3_600_000 } },
  'device-issue': { prefix: 'DEVICE_ISSUE_RATE_LIMIT', defaults: { maxRequests: 60, windowMs: 3_600_000 } },
};

export function policyFromEnv(kind: LimitKind, environment: Record<string, string | undefined> = process.env): WindowPolicy {
  const { prefix, defaults } = POLICIES[kind];
  return {
    maxRequests: readPositiveInteger(environment[`${prefix}_MAX`], defaults.maxRequests),
    windowMs: readPositiveInteger(environment[`${prefix}_WINDOW_MS`], defaults.windowMs),
  };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
