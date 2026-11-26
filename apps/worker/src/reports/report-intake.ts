import { type Provider, type Service } from '@mis-servicios/contracts';

import { ConsensusService } from '../consensus/consensus.service.js';
import { offsetSql, selectRows } from '../database/d1.js';
import { submissionRateWindowHours, toPublicTrustOutcome } from '../trust/trust.service.js';
import { alreadyReported, conflict, type ReportInput } from './report-input.js';

export type IntakeInput = Omit<ReportInput, 'deviceId' | 'latitude' | 'longitude'>;

/** Everything the write path needs, already validated and pseudonymised by `ReportsService`. */
export interface IntakeJob {
  zoneId: string;
  zoneName: string;
  h3Cell: string;
  deviceToken: string;
  requestHash: string;
  input: IntakeInput;
}

interface SubmissionRow { requestHash: string }

/**
 * The write path of a report. It must run one job at a time per H3 cell (see `CellCoordinator`), because the
 * consensus read-decide-write has no row locks on D1. The rules that must also hold across cells live in
 * single atomic statements: the unique (deviceToken, submissionId) pair and the conditional rate-limit insert.
 */
export class ReportIntake {
  constructor(private readonly consensus: ConsensusService, private readonly db: D1Database) {}

  async persist(job: IntakeJob): Promise<{ submissionId: string; accepted: true }> {
    const { input, deviceToken, requestHash, h3Cell } = job;
    const done = { submissionId: input.submissionId, ...toPublicTrustOutcome({ eligible: true }) };
    if (await this.isReplay(deviceToken, input.submissionId, requestHash)) return done;

    const submissionId = crypto.randomUUID();
    const votes = input.services.map((service) => ({ service, provider: providerFor(input, service), eventId: crypto.randomUUID() }));
    const services = input.services.map(() => '?').join(', ');
    // Rows after the first only insert if the submission row did, so a rate-limited report leaves nothing behind.
    const statements = [
      this.db.prepare(
        `INSERT INTO "SubmissionRecord" ("id", "deviceToken", "submissionId", "requestHash", "trustDecision", "expiresAt")
        SELECT ?, ?, ?, ?, 'eligible', ${offsetSql('+30 days')}
        WHERE NOT EXISTS (
          SELECT 1 FROM "ReportEvent" WHERE "deviceToken" = ? AND "service" IN (${services}) AND "status" = ? AND "createdAt" > ${offsetSql(`-${submissionRateWindowHours} hours`)}
        ) ON CONFLICT ("deviceToken", "submissionId") DO NOTHING`,
      ).bind(submissionId, deviceToken, input.submissionId, requestHash, deviceToken, ...input.services, input.status),
    ];
    for (const vote of votes) {
      statements.push(this.db.prepare(
        `INSERT INTO "ReportEvent" ("id", "submissionId", "h3Cell", "service", "provider", "status", "deviceToken", "expiresAt")
        SELECT ?, ?, ?, ?, ?, ?, ?, ${offsetSql('+48 hours')} WHERE EXISTS (SELECT 1 FROM "SubmissionRecord" WHERE "id" = ?)`,
      ).bind(vote.eventId, submissionId, h3Cell, vote.service, vote.provider, input.status, deviceToken, submissionId));
      if (input.name) {
        statements.push(this.db.prepare(
          `INSERT INTO "ReportDisplayName" ("reportEventId", "value", "expiresAt") SELECT ?, ?, ${offsetSql('+24 hours')} WHERE EXISTS (SELECT 1 FROM "ReportEvent" WHERE "id" = ?)`,
        ).bind(vote.eventId, input.name, vote.eventId));
      }
    }
    const [inserted] = await this.db.batch(statements);
    if (!inserted?.meta.changes) {
      // Either a concurrent replay of this submission won the unique pair, or the device already reported.
      if (await this.isReplay(deviceToken, input.submissionId, requestHash)) return done;
      throw alreadyReported();
    }
    await this.consensus.evaluate(job.zoneId, job.zoneName, h3Cell, input.status, votes);
    return done;
  }

  /** True for the same submission and payload again; a changed payload under the same id is a conflict. */
  private async isReplay(deviceToken: string, submissionId: string, requestHash: string): Promise<boolean> {
    const [existing] = await selectRows<SubmissionRow>(this.db, 'SELECT "requestHash" FROM "SubmissionRecord" WHERE "deviceToken" = ? AND "submissionId" = ?', [deviceToken, submissionId]);
    if (!existing) return false;
    if (existing.requestHash !== requestHash) throw conflict();
    return true;
  }
}

export function providerFor(input: Pick<ReportInput, 'providers'>, service: Service): Provider {
  const provider = input.providers[service];
  if (!provider) throw new Error('Report is missing a provider for a service.');
  return provider;
}
