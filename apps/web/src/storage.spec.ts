import { describe, expect, it, vi } from 'vitest';

import { addOwnCell, cellsCacheMaxAgeMs, createDeviceIdentity, createSafeStorage, readCells, readOwnCells, saveCells, type StorageLike } from './storage.js';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

const blocked = (): StorageLike => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
const cell = { h3Cell: '8999999999fffff', service: 'water' as const, provider: 'sedapal' as const, confirmed: true };

describe('own reports', () => {
  it('remembers the cells reported this visit without duplicates', () => {
    const backing = memory();
    const store = createSafeStorage(() => backing);
    expect([...readOwnCells(store)]).toEqual([]);
    addOwnCell(store, 'a');
    addOwnCell(store, 'b');
    addOwnCell(store, 'a');
    expect([...readOwnCells(store)]).toEqual(['a', 'b']);
  });

  it('reads as empty when the stored value is garbage or the store is blocked', () => {
    const backing = memory();
    backing.setItem('mis-servicios:own-reports', '{oops');
    expect(readOwnCells(createSafeStorage(() => backing)).size).toBe(0);
    expect(readOwnCells(createSafeStorage(blocked)).size).toBe(0);
  });
});

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

describe('device identity', () => {
  const signed = (letter: string) => `uuid-${letter}.${'a'.repeat(64)}`;
  const issued = (id: string) => () => Promise.resolve(Response.json({ deviceId: id }, { status: 201 }));
  const invalid = () => Response.json({ code: 'device_invalid' }, { status: 401 });
  const ok = () => Response.json({ accepted: true }, { status: 201 });

  it('asks the server for an id on the first report and reuses the stored one afterwards', async () => {
    const backing = memory();
    const issue = vi.fn(issued(signed('1')));
    const withDevice = createDeviceIdentity(createSafeStorage(() => backing), issue);
    const sent: string[] = [];
    const send = (id: string) => { sent.push(id); return Promise.resolve(ok()); };

    await withDevice(send);
    await withDevice(send);

    expect(sent).toEqual([signed('1'), signed('1')]);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(backing.data.get('mis-servicios:device-id')).toBe(signed('1'));
  });

  it('treats an old unsigned UUID as absent and replaces it', async () => {
    const backing = memory();
    backing.data.set('mis-servicios:device-id', '3f2b8c1e-0000-4000-8000-000000000000');
    const sent: string[] = [];

    await createDeviceIdentity(createSafeStorage(() => backing), issued(signed('1')))((id) => { sent.push(id); return Promise.resolve(ok()); });

    expect(sent).toEqual([signed('1')]);
    expect(backing.data.get('mis-servicios:device-id')).toBe(signed('1'));
  });

  it('drops the id on 401 device_invalid and retries once with a new one', async () => {
    const backing = memory();
    backing.data.set('mis-servicios:device-id', signed('old'));
    const sent: string[] = [];
    const response = await createDeviceIdentity(createSafeStorage(() => backing), issued(signed('new')))((id) => {
      sent.push(id);
      return Promise.resolve(id === signed('old') ? invalid() : ok());
    });

    expect(response.status).toBe(201);
    expect(sent).toEqual([signed('old'), signed('new')]);
    expect(backing.data.get('mis-servicios:device-id')).toBe(signed('new'));
  });

  it('retries only once and leaves any other 401 alone', async () => {
    const stillInvalid = vi.fn(() => Promise.resolve(invalid()));
    const twice = await createDeviceIdentity(createSafeStorage(() => memory()), issued(signed('1')))(stillInvalid);
    expect(twice.status).toBe(401);
    expect(stillInvalid).toHaveBeenCalledTimes(2);

    const other = vi.fn(() => Promise.resolve(Response.json({ code: 'nope' }, { status: 401 })));
    await createDeviceIdentity(createSafeStorage(() => memory()), issued(signed('1')))(other);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('returns the issue failure without sending the report', async () => {
    const send = vi.fn();
    const limited = () => Promise.resolve(Response.json({ code: 'rate_limited', retryAfterSeconds: 60 }, { status: 429 }));

    const response = await createDeviceIdentity(createSafeStorage(() => memory()), limited)(send);

    expect(response.status).toBe(429);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the id for this visit when storage is blocked', async () => {
    const issue = vi.fn(issued(signed('1')));
    const withDevice = createDeviceIdentity(createSafeStorage(blocked), issue);

    await withDevice(() => Promise.resolve(ok()));
    await withDevice(() => Promise.resolve(ok()));

    expect(issue).toHaveBeenCalledTimes(1);
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
