import { providerCatalog, providerSchema, type Provider, type Service } from '@mis-servicios/contracts';
import { DatabasePool } from '../database/database.pool.js';

const publicServices = new Set(['water', 'electricity', 'internet']);

export interface PublicCell {
  h3Cell: string;
  service: Service;
  provider: Provider;
  confirmed: boolean;
  /** Distinct neighbours who reported this cell and service. */
  reports: number;
}

export class PublicCellsService {
  constructor(private readonly database: DatabasePool) {}

  async listCells(service?: unknown, provider?: unknown): Promise<PublicCell[]> {
    if (!isSupportedService(service) || !isSupportedProvider(provider, service) || !(await this.isPublicationEnabled())) return [];

    const filters = (column: string): { sql: string; values: string[] } => {
      const values: string[] = [];
      const conditions: string[] = [];
      if (service) {
        values.push(service);
        conditions.push(`${column}."service" = $${values.length}::"Service"`);
      }
      if (provider) {
        values.push(provider);
        conditions.push(`${column}."provider" = $${values.length}::"Provider"`);
      }
      return { sql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', values };
    };
    const episodeFilter = filters('episode');
    const eventFilter = filters('event');

    const confirmed = await this.database.query<PublicCell>(
      `WITH latest AS (
        SELECT DISTINCT ON (event."h3Cell", event."service", event."provider", event."deviceToken") event."h3Cell", event."service", event."provider", event."deviceToken", event."status"
        FROM "ReportEvent" AS event
        WHERE event."expiresAt" > CURRENT_TIMESTAMP
        ORDER BY event."h3Cell", event."service", event."provider", event."deviceToken", event."createdAt" DESC, event."id" DESC
      )
      SELECT episode."h3Cell", episode."service", episode."provider", true AS "confirmed", count(*)::int AS "reports"
      FROM "OutageEpisode" AS episode
      INNER JOIN "PilotZone" AS zone ON zone."id" = episode."zoneId"
      INNER JOIN latest ON latest."h3Cell" = episode."h3Cell" AND latest."service" = episode."service" AND latest."provider" = episode."provider" AND latest."status" = 'outage'
      WHERE episode."active" = true AND episode."expiresAt" > CURRENT_TIMESTAMP AND zone."approved" = true${episodeFilter.sql}
      GROUP BY episode."id", episode."h3Cell", episode."service", episode."provider"`,
      episodeFilter.values,
    );

    const pending = await this.database.query<PublicCell>(
      `WITH latest AS (
        SELECT DISTINCT ON (event."h3Cell", event."service", event."provider", event."deviceToken") event."h3Cell", event."service", event."provider", event."deviceToken", event."status"
        FROM "ReportEvent" AS event
        WHERE event."expiresAt" > CURRENT_TIMESTAMP
        ORDER BY event."h3Cell", event."service", event."provider", event."deviceToken", event."createdAt" DESC, event."id" DESC
      )
      SELECT latest."h3Cell", latest."service", latest."provider", false AS "confirmed", count(*)::int AS "reports"
      FROM latest
      WHERE latest."status" = 'outage'
        AND NOT EXISTS (SELECT 1 FROM "OutageEpisode" AS episode WHERE episode."h3Cell" = latest."h3Cell" AND episode."service" = latest."service" AND episode."provider" IS NOT DISTINCT FROM latest."provider")${eventFilter.sql.replaceAll('event.', 'latest.')}
      GROUP BY latest."h3Cell", latest."service", latest."provider"`,
      eventFilter.values,
    );

    return [...confirmed.rows, ...pending.rows];
  }

  private async isPublicationEnabled(): Promise<boolean> {
    if (process.env.PUBLIC_MAP_ENABLED !== 'true' || !hasConfiguredH3Resolution()) return false;
    const zones = await this.database.query<{ count: string }>('SELECT count(*) FROM "PilotZone" WHERE "approved" = true');
    const count = Number(zones.rows[0]?.count ?? 0);
    return count >= 2;
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
