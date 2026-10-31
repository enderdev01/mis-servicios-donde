import { DatabasePool } from '../database/database.pool.js';

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
  constructor(private readonly database: DatabasePool) {}

  async forApprovedZone(slug: string): Promise<PrintableNotice> {
    const zone = await this.database.query<ZoneRow>('SELECT "name" FROM "PilotZone" WHERE "slug" = $1 AND "approved" = true', [slug]);
    if (!zone.rows[0]) throw new ZoneNotFoundError();
    return printableNotice(zone.rows[0]);
  }

  /** The approved districts, with their bounds, so the map can centre on one. */
  async listApprovedZones(): Promise<ZoneSummary[]> {
    const zones = await this.database.query<{ slug: string; name: string; boundary: ZoneBoundary }>(
      'SELECT "slug", "name", "boundary" FROM "PilotZone" WHERE "approved" = true ORDER BY "slug"',
    );
    return zones.rows;
  }
}
