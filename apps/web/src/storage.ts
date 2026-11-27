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

/** When storage is blocked the id lives for this page visit only. */
export function getDeviceId(store: SafeStorage, fresh: () => string = () => crypto.randomUUID()): string {
  const existing = store.get(deviceIdKey);
  if (existing) return existing;
  const created = fresh();
  store.set(deviceIdKey, created);
  return created;
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
