import { providerCatalog, providerSchema, type Provider, type Service } from '@mis-servicios/contracts';

import { nowSql, selectRows } from '../database/d1.js';

const publicServices = new Set(['water', 'electricity', 'internet']);

export interface PublicCell {
  h3Cell: string;
  service: Service;
  provider: Provider;
  confirmed: boolean;
  /** Distinct neighbours who reported this cell and service. */
  reports: number;
}

/** The latest event of each device per cell, service and provider (SQLite has no DISTINCT ON). */
const latestEvents = `latest AS (
  SELECT "h3Cell", "service", "provider", "status" FROM (
    SELECT event."h3Cell", event."service", event."provider", event."status",
      ROW_NUMBER() OVER (PARTITION BY event."h3Cell", event."service", event."provider", event."deviceToken" ORDER BY event."createdAt" DESC, event."id" DESC) AS "rank"
    FROM "ReportEvent" AS event
    WHERE event."expiresAt" > ${nowSql}
  ) WHERE "rank" = 1
)`;

export class PublicCellsService {
  constructor(private readonly db: D1Database) {}

  async listCells(service?: unknown, provider?: unknown): Promise<PublicCell[]> {
    if (!isSupportedService(service) || !isSupportedProvider(provider, service) || !(await this.isPublicationEnabled())) return [];

    const filters = (column: string): { sql: string; values: string[] } => {
      const values: string[] = [];
      const conditions: string[] = [];
      if (service) {
        values.push(service);
        conditions.push(`${column}."service" = ?`);
      }
      if (provider) {
        values.push(provider);
        conditions.push(`${column}."provider" = ?`);
      }
      return { sql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', values };
    };
    const episodeFilter = filters('episode');
    const eventFilter = filters('latest');

    const confirmed = await selectRows<{ h3Cell: string; service: Service; provider: Provider; confirmed: number; reports: number }>(
      this.db,
      `WITH ${latestEvents}
      SELECT episode."h3Cell", episode."service", episode."provider", 1 AS "confirmed", count(*) AS "reports"
      FROM "OutageEpisode" AS episode
      INNER JOIN "PilotZone" AS zone ON zone."id" = episode."zoneId"
      INNER JOIN latest ON latest."h3Cell" = episode."h3Cell" AND latest."service" = episode."service" AND latest."provider" = episode."provider" AND latest."status" = 'outage'
      WHERE episode."active" = 1 AND episode."expiresAt" > ${nowSql} AND zone."approved" = 1${episodeFilter.sql}
      GROUP BY episode."id", episode."h3Cell", episode."service", episode."provider"`,
      episodeFilter.values,
    );

    const pending = await selectRows<{ h3Cell: string; service: Service; provider: Provider; confirmed: number; reports: number }>(
      this.db,
      `WITH ${latestEvents}
      SELECT latest."h3Cell", latest."service", latest."provider", 0 AS "confirmed", count(*) AS "reports"
      FROM latest
      WHERE latest."status" = 'outage'
        AND NOT EXISTS (SELECT 1 FROM "OutageEpisode" AS episode WHERE episode."h3Cell" = latest."h3Cell" AND episode."service" = latest."service" AND episode."provider" IS latest."provider")${eventFilter.sql}
      GROUP BY latest."h3Cell", latest."service", latest."provider"`,
      eventFilter.values,
    );

    return [...confirmed, ...pending].map((cell) => ({ ...cell, confirmed: cell.confirmed === 1 }));
  }

  private async isPublicationEnabled(): Promise<boolean> {
    if (process.env.PUBLIC_MAP_ENABLED !== 'true' || !hasConfiguredH3Resolution()) return false;
    const [zones] = await selectRows<{ count: number }>(this.db, 'SELECT count(*) AS "count" FROM "PilotZone" WHERE "approved" = 1');
    return Number(zones?.count ?? 0) >= 2;
  }
}

function isSupportedService(service: unknown): service is PublicCell['service'] | undefined {
  return service === undefined || (typeof service === 'string' && publicServices.has(service));
}

function isSupportedProvider(provider: unknown, service: unknown): provider is Provider | undefined {
  if (provider === undefined) return true;
  const parsed = providerSchema.safeParse(provider);
  if (!parsed.success) return false;
  if (service === undefined) return true;
  return (providerCatalog[service as Service] as readonly string[]).includes(parsed.data);
}

function hasConfiguredH3Resolution(): boolean {
  const rawResolution = process.env.H3_RESOLUTION?.trim();
  if (!rawResolution) return false;
  const resolution = Number(rawResolution);
  return Number.isInteger(resolution) && resolution >= 0 && resolution <= 15;
}
