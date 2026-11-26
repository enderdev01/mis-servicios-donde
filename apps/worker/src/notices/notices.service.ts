import { selectRows } from '../database/d1.js';

export class ZoneNotFoundError extends Error {}

interface ZoneRow { name: string }

export interface ZoneBoundary {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}

export interface ZoneSummary {
  slug: string;
  name: string;
  boundary: ZoneBoundary;
}

export interface PrintableNotice {
  title: string;
  zone: string;
  instructions: string;
  mapUrl: string;
  notice: string;
}

export function printableNotice(input: { name: string }): PrintableNotice {
  return {
    title: `Aviso comunitario de cortes — ${input.name}`,
    zone: input.name,
    instructions: 'Reporta cortes de agua, luz o internet en el mapa comunitario.',
    mapUrl: '/',
    notice: 'Información sobre cortes generada por la comunidad, no oficial.',
  };
}

export class NoticesService {
  constructor(private readonly db: D1Database) {}

  async forApprovedZone(slug: string): Promise<PrintableNotice> {
    const [zone] = await selectRows<ZoneRow>(this.db, 'SELECT "name" FROM "PilotZone" WHERE "slug" = ? AND "approved" = 1', [slug]);
    if (!zone) throw new ZoneNotFoundError();
    return printableNotice(zone);
  }

  /** The approved districts, with their bounds, so the map can centre on one. */
  async listApprovedZones(): Promise<ZoneSummary[]> {
    const zones = await selectRows<{ slug: string; name: string; boundary: string }>(
      this.db,
      'SELECT "slug", "name", "boundary" FROM "PilotZone" WHERE "approved" = 1 ORDER BY "slug"',
    );
    return zones.map((zone) => ({ ...zone, boundary: JSON.parse(zone.boundary) as ZoneBoundary }));
  }
}
