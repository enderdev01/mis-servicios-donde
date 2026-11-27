import { toPublicCells, type PublicCell } from './map.js';

/** Minimal storage surface so the behaviour stays testable outside the browser. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Opening `localStorage` itself throws when storage is blocked (cookie blocking,
 * some WebViews), so the lookup happens inside the guard. A blocked store reads
 * as empty and swallows writes: the app must run without persistence.
 */
export function createSafeStorage(open: () => StorageLike = () => localStorage) {
  return {
    get(key: string): string | null {
      try { return open().getItem(key); } catch { return null; }
    },
    set(key: string, value: string): boolean {
      try { open().setItem(key, value); return true; } catch { return false; }
    },
  };
}

export type SafeStorage = ReturnType<typeof createSafeStorage>;

const deviceIdKey = 'mis-servicios:device-id';

/** The server signs the id (`<uuid>.<hmac>`); an old browser-made UUID has no signature and counts as absent. */
const signedDeviceId = /^[\w-]+\.[0-9a-f]{64}$/;

/**
 * Runs `send` with the signed device id, asking the server for one only when the
 * visitor reports. A 401 `device_invalid` drops the stored id and retries once with
 * a fresh one. When storage is blocked the id lives for this page visit only.
 * An `issue` that does not answer 201 is returned as the outcome, so the caller shows its message.
 */
export function createDeviceIdentity(store: SafeStorage, issue: () => Promise<Response>) {
  let memory: string | undefined;
  const stored = (): string | undefined => {
    const value = store.get(deviceIdKey);
    return value && signedDeviceId.test(value) ? value : memory;
  };
  const obtain = async (): Promise<{ id: string } | { failure: Response }> => {
    const existing = stored();
    if (existing) return { id: existing };
    const response = await issue();
    const body = response.ok ? await response.json().catch(() => undefined) as { deviceId?: unknown } | undefined : undefined;
    if (typeof body?.deviceId !== 'string' || !signedDeviceId.test(body.deviceId)) return { failure: response.ok ? new Response(null, { status: 502 }) : response };
    memory = body.deviceId;
    store.set(deviceIdKey, body.deviceId);
    return { id: body.deviceId };
  };
  const rejectedAsInvalid = async (response: Response): Promise<boolean> =>
    response.status === 401 && (await response.clone().json().catch(() => undefined) as { code?: unknown } | undefined)?.code === 'device_invalid';

  return async function withDevice(send: (deviceId: string) => Promise<Response>): Promise<Response> {
    const first = await obtain();
    if ('failure' in first) return first.failure;
    const response = await send(first.id);
    if (!(await rejectedAsInvalid(response))) return response;
    memory = undefined;
    store.set(deviceIdKey, '');
    const second = await obtain();
    return 'failure' in second ? second.failure : send(second.id);
  };
}

const cellsKey = 'mis-servicios:cells';
/** Reports expire after about six hours, so a copy older than that says nothing true. */
export const cellsCacheMaxAgeMs = 6 * 60 * 60 * 1000;

export interface CachedCells {
  at: number;
  cells: PublicCell[];
}

/** The last good `/v1/cells` response, kept so a dead connection still has something honest to show. */
export function saveCells(store: SafeStorage, cells: PublicCell[], at: number): void {
  store.set(cellsKey, JSON.stringify({ at, cells }));
}

const ownReportsKey = 'mis-servicios:own-reports';

/** The H3 cells this visit reported an outage in. Per-tab storage: it never outlives the visit. */
export function readOwnCells(store: SafeStorage): Set<string> {
  try {
    const parsed: unknown = JSON.parse(store.get(ownReportsKey) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((cell): cell is string => typeof cell === 'string') : []);
  } catch {
    return new Set();
  }
}

export function addOwnCell(store: SafeStorage, h3Cell: string): void {
  store.set(ownReportsKey, JSON.stringify([...readOwnCells(store), h3Cell]));
}

export function readCells(store: SafeStorage, now: number): CachedCells | undefined {
  const raw = store.get(cellsKey);
  if (!raw) return undefined;
  try {
    const record = JSON.parse(raw) as { at?: unknown; cells?: unknown };
    if (typeof record.at !== 'number' || !Number.isFinite(record.at) || now - record.at > cellsCacheMaxAgeMs) return undefined;
    return { at: Math.min(record.at, now), cells: toPublicCells(record.cells) };
  } catch {
    return undefined;
  }
}
