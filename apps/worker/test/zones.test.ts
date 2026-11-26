import { describe, expect, it } from 'vitest';

import { db, request } from './helpers.js';

const pilotZones = [
  ['747dc522-2b09-4b69-bf54-9fbed365079b', 'san-borja'],
  ['8a5c85b9-fc13-488d-9bd2-d50b28f66796', 'cercado-de-lima'],
  ['8bf160d7-fa6e-43d8-8813-0100839ca2aa', 'san-juan-de-lurigancho'],
  ['9a1039a0-75bd-449b-8740-cab383d2091b', 'jesus-maria'],
  ['a72ecf12-2bc3-45e3-a6ef-9f400ffa1f9f', 'lince'],
  ['b5ade2b8-e359-490d-91be-4e80f0f28eb6', 'brena'],
  ['bd652b8d-23bd-40f2-a741-e908396d8840', 'san-martin-de-porres'],
  ['d45cd957-de40-4c2d-a905-0ca2aef88f8e', 'san-isidro'],
  ['ebeb19c1-8a41-4063-a528-7ea9aa8f85ed', 'rimac'],
  ['fe6f9c8f-c31f-4c53-b5ca-580ae4c76397', 'magdalena-del-mar'],
] as const;

describe('pilot zones', () => {
  it('serves health', async () => {
    const response = await request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('keeps the 10 production zones with their ids', async () => {
    const stored = await db.prepare('SELECT "id", "slug" FROM "PilotZone" ORDER BY "slug"').all<{ id: string; slug: string }>();

    expect(stored.results.map((zone) => [zone.id, zone.slug])).toEqual([...pilotZones].sort((a, b) => a[1].localeCompare(b[1])));
  });

  it('lists the 10 approved districts with parsed bounds, ordered by slug', async () => {
    const response = await request('/v1/zones');
    const zones = await response.json<{ slug: string; name: string; boundary: Record<string, number> }[]>();

    expect(response.status).toBe(200);
    expect(zones.map((zone) => zone.slug)).toEqual(pilotZones.map(([, slug]) => slug).sort());
    expect(Object.keys(zones[0] ?? {}).sort()).toEqual(['boundary', 'name', 'slug']);
    expect(zones.find((zone) => zone.slug === 'san-borja')?.boundary).toEqual({ maxLatitude: -12.08, minLatitude: -12.12, maxLongitude: -76.975, minLongitude: -77.025 });
  });

  it('serves a printable notice for an approved zone and 404 for an unknown or unapproved one', async () => {
    const notice = await request('/v1/zones/san-isidro/notice');
    expect(notice.status).toBe(200);
    expect(await notice.json()).toEqual({
      title: 'Aviso comunitario de cortes — San Isidro',
      zone: 'San Isidro',
      instructions: 'Reporta cortes de agua, luz o internet en el mapa comunitario.',
      mapUrl: '/',
      notice: 'Información sobre cortes generada por la comunidad, no oficial.',
    });
    expect((await request('/v1/zones/missing/notice')).status).toBe(404);

    await db.prepare('UPDATE "PilotZone" SET "approved" = 0, "updatedAt" = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE "slug" = ?').bind('san-isidro').run();
    try {
      expect((await request('/v1/zones/san-isidro/notice')).status).toBe(404);
      expect((await (await request('/v1/zones')).json<unknown[]>()).length).toBe(9);
    } finally {
      await db.prepare('UPDATE "PilotZone" SET "approved" = 1 WHERE "slug" = ?').bind('san-isidro').run();
    }
  });
});
