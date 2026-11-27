import { describe, expect, it } from 'vitest';

import { cellsCacheMaxAgeMs, createSafeStorage, getDeviceId, readCells, saveCells, type StorageLike } from './storage.js';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

const blocked = (): StorageLike => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
const cell = { h3Cell: '8999999999fffff', service: 'water' as const, provider: 'sedapal' as const, confirmed: true };

describe('safe storage', () => {
  it('reads and writes through a working store', () => {
    const backing = memory();
    const store = createSafeStorage(() => backing);
    expect(store.get('a')).toBeNull();
    expect(store.set('a', '1')).toBe(true);
    expect(store.get('a')).toBe('1');
  });

  it('reads as empty and swallows writes when opening the store throws', () => {
    const store = createSafeStorage(blocked);
    expect(store.get('a')).toBeNull();
    expect(store.set('a', '1')).toBe(false);
  });

  it('swallows a full store', () => {
    const full: StorageLike = { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    expect(createSafeStorage(() => full).set('a', '1')).toBe(false);
  });
});

describe('device id', () => {
  it('is created once and then reused', () => {
    const backing = memory();
    const store = createSafeStorage(() => backing);
    expect(getDeviceId(store, () => 'first')).toBe('first');
    expect(getDeviceId(store, () => 'second')).toBe('first');
  });

  it('still answers an id for this visit when storage is blocked', () => {
    expect(getDeviceId(createSafeStorage(blocked), () => 'session-only')).toBe('session-only');
  });
});

describe('cells cache', () => {
  it('round-trips the last good response with its time', () => {
    const backing = memory();
    const store = createSafeStorage(() => backing);
    saveCells(store, [cell], 1_000);
    expect(readCells(store, 5_000)).toEqual({ at: 1_000, cells: [cell] });
  });

  it('ignores a copy older than the report lifetime', () => {
    const backing = memory();
    const store = createSafeStorage(() => backing);
    saveCells(store, [cell], 1_000);
    expect(readCells(store, 1_000 + cellsCacheMaxAgeMs + 1)).toBeUndefined();
  });

  it('ignores corrupt records and drops malformed cells', () => {
    const backing = memory();
    const store = createSafeStorage(() => backing);
    backing.setItem('mis-servicios:cells', '{nope');
    expect(readCells(store, 10)).toBeUndefined();
    backing.setItem('mis-servicios:cells', JSON.stringify({ at: 'yesterday', cells: [cell] }));
    expect(readCells(store, 10)).toBeUndefined();
    backing.setItem('mis-servicios:cells', JSON.stringify({ at: 5, cells: [cell, { service: 'gas' }] }));
    expect(readCells(store, 10)?.cells).toEqual([cell]);
  });

  it('reads as nothing when storage is blocked', () => {
    const store = createSafeStorage(blocked);
    saveCells(store, [cell], 1);
    expect(readCells(store, 2)).toBeUndefined();
  });
});
