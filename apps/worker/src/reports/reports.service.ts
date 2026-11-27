import { latLngToCell } from 'h3-js';

import type { IntakeOutcome } from '../consensus/cell-coordinator.js';
import { selectRows } from '../database/d1.js';
import { canonicalSubmissionHash, createVersionedDeviceToken } from '../trust/trust.service.js';
import { ReportRequestError, intakePaused, outsidePilotZone, unavailable, validateReportInput } from './report-input.js';
import { providerFor, type IntakeJob } from './report-intake.js';

interface PilotZoneRow { id: string; name: string; boundary: string }

/** Runs the write path for one cell, serialized with every other write to that cell. */
export type RunIntake = (h3Cell: string, job: IntakeJob) => Promise<IntakeOutcome>;

export class ReportsService {
  private readonly h3Resolution = configuredH3Resolution();
  private readonly deviceSecret = process.env.DEVICE_TOKEN_SECRET?.trim();

  constructor(private readonly db: D1Database, private readonly runIntake: RunIntake) {}

  async accept(value: unknown): Promise<{ submissionId: string; accepted: true }> {
    // Retention must run before data is collected: the spec purges names in 24 h and events in 48 h.
    if (process.env.INTAKE_ENABLED !== 'true' || process.env.RETENTION_WORKER_ENABLED !== 'true') throw intakePaused();
    const input = validateReportInput(value);
    const resolution = this.h3Resolution;
    const secret = this.deviceSecret;
    // Configuration is settled before any query: an absent secret must never
    // fall back to a shared default that makes pseudonyms guessable.
    if (resolution === undefined || !secret) throw unavailable();
    const zone = await this.findPilotZone(input.latitude, input.longitude);
    if (!zone) throw outsidePilotZone();
    const h3Cell = latLngToCell(input.latitude, input.longitude, resolution);
    const deviceToken = createVersionedDeviceToken(input.deviceId, secret, 'v1');
    const requestHash = canonicalSubmissionHash({
      h3Cell,
      services: input.services.map((service) => `${service}:${providerFor(input, service)}`),
      status: input.status,
    });
    const safeInput = { submissionId: input.submissionId, services: input.services, providers: input.providers, status: input.status, name: input.name };
    const outcome = await this.runIntake(h3Cell, { zoneId: zone.id, zoneName: zone.name, h3Cell, deviceToken, requestHash, input: safeInput });
    if ('rejected' in outcome) throw new ReportRequestError(outcome.status, outcome.rejected);
    return { submissionId: outcome.submissionId, accepted: true };
  }

  private async findPilotZone(latitude: number, longitude: number): Promise<PilotZoneRow | undefined> {
    const zones = await selectRows<PilotZoneRow>(this.db, 'SELECT "id", "name", "boundary" FROM "PilotZone" WHERE "approved" = 1');
    return zones.find((zone) => contains(JSON.parse(zone.boundary), latitude, longitude));
  }
}

function contains(boundary: unknown, latitude: number, longitude: number): boolean {
  if (!isBoundary(boundary)) return false;
  return latitude >= boundary.minLatitude && latitude <= boundary.maxLatitude && longitude >= boundary.minLongitude && longitude <= boundary.maxLongitude;
}

function isBoundary(value: unknown): value is { minLatitude: number; maxLatitude: number; minLongitude: number; maxLongitude: number } {
  if (typeof value !== 'object' || value === null) return false;
  const boundary = value as Record<string, unknown>;
  return ['minLatitude', 'maxLatitude', 'minLongitude', 'maxLongitude'].every((key) => typeof boundary[key] === 'number');
}

function configuredH3Resolution(): number | undefined {
  const rawResolution = process.env.H3_RESOLUTION?.trim();
  if (!rawResolution) return undefined;
  const resolution = Number(rawResolution);
  return Number.isInteger(resolution) && resolution >= 0 && resolution <= 15 ? resolution : undefined;
}
