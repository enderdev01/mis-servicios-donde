import { beforeEach, describe, expect, it } from 'vitest';

import { RetentionService } from '../src/retention/retention.service.js';
import { count, db, resetDatabase } from './helpers.js';

const retention = new RetentionService(db);
const hours = (offset: number): string => new Date(Date.now() + offset * 3_600_000).toISOString();
const id = (): string => crypto.randomUUID();

async function seed(): Promise<void> {
  const zoneId = '8a5c85b9-fc13-488d-9bd2-d50b28f66796';
  const [expiredSubmission, freshSubmission, expiredEvent, freshEvent, episode] = [id(), id(), id(), id(), id()];
  const event = `INSERT INTO "ReportEvent" ("id", "submissionId", "h3Cell", "service", "provider", "status", "deviceToken", "expiresAt") VALUES (?, ?, '8999999999fffff', 'water', 'sedapal', 'outage', ?, ?)`;
  const submission = `INSERT INTO "SubmissionRecord" ("id", "deviceToken", "submissionId", "requestHash", "trustDecision", "expiresAt") VALUES (?, ?, ?, ?, 'eligible', ?)`;
  await db.batch([
    db.prepare(submission).bind(expiredSubmission, 'expired-device', 'expired-submission', 'expired', hours(-720)),
    db.prepare(submission).bind(freshSubmission, 'fresh-device', 'fresh-submission', 'fresh', hours(720)),
    db.prepare(event).bind(expiredEvent, expiredSubmission, 'expired-device', hours(-48)),
    db.prepare(event).bind(freshEvent, freshSubmission, 'fresh-device', hours(48)),
    db.prepare(`INSERT INTO "ReportDisplayName" ("reportEventId", "value", "expiresAt") VALUES (?, 'Expired Name', ?), (?, 'Fresh Name', ?)`).bind(expiredEvent, hours(-48), freshEvent, hours(48)),
    db.prepare(`INSERT INTO "AbuseRecord" ("id", "deviceToken", "decision", "expiresAt") VALUES (?, 'expired-device', 'excluded', ?), (?, 'fresh-device', 'eligible', ?)`).bind(id(), hours(-720), id(), hours(720)),
    db.prepare(`INSERT INTO "OutageEpisode" ("id", "zoneId", "h3Cell", "service", "provider", "expiresAt") VALUES (?, ?, '8999999999fffff', 'water', 'sedapal', ?)`).bind(episode, zoneId, hours(6)),
    db.prepare(`INSERT INTO "AlertIntent" ("id", "episodeId", "kind", "content", "createdAt") VALUES (?, ?, 'OPENED', 'old safe alert', ?)`).bind(id(), episode, hours(-720)),
  ]);
}

beforeEach(async () => {
  await resetDatabase();
  await seed();
});

describe('retention', () => {
  it('erases expired reports, abuse, idempotency and alert records and nothing else', async () => {
    await expect(retention.cleanup()).resolves.toEqual({ displayNames: 1, events: 1, submissions: 1, abuseRecords: 1, alertIntents: 1 });

    expect((await db.prepare('SELECT "value" FROM "ReportDisplayName"').all()).results).toEqual([{ value: 'Fresh Name' }]);
    expect((await db.prepare('SELECT "submissionId" FROM "SubmissionRecord"').all()).results).toEqual([{ submissionId: 'fresh-submission' }]);
    expect((await db.prepare('SELECT "deviceToken" FROM "ReportEvent"').all()).results).toEqual([{ deviceToken: 'fresh-device' }]);
    expect((await db.prepare('SELECT "deviceToken" FROM "AbuseRecord"').all()).results).toEqual([{ deviceToken: 'fresh-device' }]);
    expect(await count('AlertIntent')).toBe(0);
    expect(await count('OutageEpisode')).toBe(1);
    expect(await count('PilotZone')).toBe(10);
  });

  it('keeps an alert intent younger than 30 days', async () => {
    await db.prepare(`UPDATE "AlertIntent" SET "createdAt" = ?`).bind(hours(-24 * 29)).run();

    await expect(retention.cleanup()).resolves.toMatchObject({ alertIntents: 0 });
    expect(await count('AlertIntent')).toBe(1);
  });

  it('irreversibly purges pilot data for a rollback while preserving configured zones', async () => {
    await expect(retention.purgePilotData()).resolves.toEqual({ displayNames: 2, events: 2, submissions: 2, abuseRecords: 2, episodes: 1 });

    for (const table of ['ReportDisplayName', 'ReportEvent', 'SubmissionRecord', 'AbuseRecord', 'OutageEpisode', 'AlertIntent']) expect(await count(table)).toBe(0);
    expect(await count('PilotZone')).toBe(10);
  });
});
