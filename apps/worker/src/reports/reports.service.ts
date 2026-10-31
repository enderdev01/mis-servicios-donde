import { type Provider, type Service } from '@mis-servicios/contracts';
import { latLngToCell } from 'h3-js';
import pg from 'pg';

import { ConsensusService } from '../consensus/consensus.service.js';
import { canonicalSubmissionHash, createVersionedDeviceToken, submissionRateWindowHours, toPublicTrustOutcome } from '../trust/trust.service.js';
import { conflict, type ReportInput, unavailable, alreadyReported, validateReportInput } from './report-input.js';
import { DatabasePool } from '../database/database.pool.js';

interface PilotZoneRow { id: string; name: string; boundary: unknown }
interface SubmissionRow { id: string; "requestHash": string; "trustDecision": 'eligible' | 'excluded' }
export class ReportsService {
  private readonly h3Resolution = configuredH3Resolution();
  private readonly deviceSecret = process.env.DEVICE_TOKEN_SECRET?.trim();

  constructor(private readonly consensus: ConsensusService, private readonly database: DatabasePool) {}

  async accept(value: unknown): Promise<{ submissionId: string; accepted: true }> {
    if (process.env.INTAKE_ENABLED !== 'true') throw unavailable();
    const input = validateReportInput(value);
    const resolution = this.h3Resolution;
    const secret = this.deviceSecret;
    // Configuration is settled before any query: an absent secret must never
    // fall back to a shared default that makes pseudonyms guessable.
    if (resolution === undefined || !secret) throw unavailable();
    const zone = await this.findPilotZone(input.latitude, input.longitude);
    if (!zone) throw unavailable();
    const h3Cell = latLngToCell(input.latitude, input.longitude, resolution);
    const deviceToken = createVersionedDeviceToken(input.deviceId, secret, 'v1');
    const requestHash = canonicalSubmissionHash({
      h3Cell,
      services: input.services.map((service) => `${service}:${providerFor(input, service)}`),
      status: input.status,
    });
    const safeInput = { submissionId: input.submissionId, services: input.services, providers: input.providers, status: input.status, name: input.name };
    return this.persist(zone.id, zone.name, h3Cell, deviceToken, requestHash, safeInput);
  }

  private async findPilotZone(latitude: number, longitude: number): Promise<PilotZoneRow | undefined> {
    const zones = await this.database.query<PilotZoneRow>('SELECT "id", "name", "boundary" FROM "PilotZone" WHERE "approved" = true');
    return zones.rows.find((zone) => contains(zone.boundary, latitude, longitude));
  }

  private async persist(
    zoneId: string,
    zoneName: string,
    h3Cell: string,
    deviceToken: string,
    requestHash: string,
    input: Omit<ReportInput, 'deviceId' | 'latitude' | 'longitude'>,
  ): Promise<{ submissionId: string; accepted: true }> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<SubmissionRow>(
        'SELECT "id", "requestHash", "trustDecision" FROM "SubmissionRecord" WHERE "deviceToken" = $1 AND "submissionId" = $2 FOR UPDATE',
        [deviceToken, input.submissionId],
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.requestHash !== requestHash) throw conflict();
        await client.query('COMMIT');
        return { submissionId: input.submissionId, ...toPublicTrustOutcome({ eligible: existing.rows[0]?.trustDecision === 'eligible' }) };
      }
      for (const service of input.services) {
        const prior = await client.query(
          `SELECT 1 FROM "ReportEvent" WHERE "deviceToken" = $1 AND "service" = $2::"Service" AND "status" = $3::"ReportStatus" AND "createdAt" > CURRENT_TIMESTAMP - INTERVAL '${submissionRateWindowHours} hour' LIMIT 1`,
          [deviceToken, service, input.status],
        );
        if (prior.rowCount) throw alreadyReported();
      }
      const submission = await client.query<{ id: string }>(
        'INSERT INTO "SubmissionRecord" ("deviceToken", "submissionId", "requestHash", "trustDecision", "expiresAt") VALUES ($1, $2, $3, $4::"TrustDecision", CURRENT_TIMESTAMP + INTERVAL \'30 days\') RETURNING "id"',
        [deviceToken, input.submissionId, requestHash, 'eligible'],
      );
      await this.consensus.evaluate(client, zoneId, zoneName, h3Cell, input.status, await this.insertEvents(client, submission.rows[0]?.id, h3Cell, deviceToken, input));
      await client.query('COMMIT');
      return { submissionId: input.submissionId, ...toPublicTrustOutcome({ eligible: true }) };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof Error && 'status' in error) throw error;
      throw new ReportUnavailableError();
    } finally { client.release(); }
  }

  private async insertEvents(client: pg.PoolClient, submissionId: string | undefined, h3Cell: string, deviceToken: string, input: Omit<ReportInput, 'deviceId' | 'latitude' | 'longitude'>): Promise<{ service: Service; provider: Provider; eventId: string }[]> {
    if (!submissionId) throw new ReportUnavailableError();
    const votes: { service: Service; provider: Provider; eventId: string }[] = [];
    for (const service of input.services) {
      const provider = providerFor(input, service);
      const event = await client.query<{ id: string }>(
        'INSERT INTO "ReportEvent" ("submissionId", "h3Cell", "service", "provider", "status", "deviceToken", "expiresAt") VALUES ($1::uuid, $2, $3::"Service", $4::"Provider", $5::"ReportStatus", $6, CURRENT_TIMESTAMP + INTERVAL \'48 hours\') RETURNING "id"',
        [submissionId, h3Cell, service, provider, input.status, deviceToken],
      );
      if (!event.rows[0]?.id) throw new ReportUnavailableError();
      votes.push({ service, provider, eventId: event.rows[0].id });
      if (input.name && event.rows[0]?.id) await client.query(
        'INSERT INTO "ReportDisplayName" ("reportEventId", "value", "expiresAt") VALUES ($1::uuid, $2, CURRENT_TIMESTAMP + INTERVAL \'24 hours\')',
        [event.rows[0].id, input.name],
      );
    }
    return votes;
  }
}

class ReportUnavailableError extends Error {}

function contains(boundary: unknown, latitude: number, longitude: number): boolean {
  if (!isBoundary(boundary)) return false;
  return latitude >= boundary.minLatitude && latitude <= boundary.maxLatitude && longitude >= boundary.minLongitude && longitude <= boundary.maxLongitude;
}

function isBoundary(value: unknown): value is { minLatitude: number; maxLatitude: number; minLongitude: number; maxLongitude: number } {
  if (typeof value !== 'object' || value === null) return false;
  const boundary = value as Record<string, unknown>;
  return ['minLatitude', 'maxLatitude', 'minLongitude', 'maxLongitude'].every((key) => typeof boundary[key] === 'number');
}

function providerFor(input: Pick<ReportInput, 'providers'>, service: Service): Provider {
  const provider = input.providers[service];
  if (!provider) throw new ReportUnavailableError();
  return provider;
}

function configuredH3Resolution(): number | undefined {
  const rawResolution = process.env.H3_RESOLUTION?.trim();
  if (!rawResolution) return undefined;
  const resolution = Number(rawResolution);
  return Number.isInteger(resolution) && resolution >= 0 && resolution <= 15 ? resolution : undefined;
}
