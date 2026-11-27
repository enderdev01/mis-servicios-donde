import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AlertsService, maxDeliveryAttempts } from '../src/alerts/alerts.service.js';
import { ConsensusService } from '../src/consensus/consensus.service.js';
import { db, resetDatabase } from './helpers.js';

const alerts = new AlertsService(db);
const originalFetch = globalThis.fetch;
const zoneId = '8a5c85b9-fc13-488d-9bd2-d50b28f66796';

/** One episode with its OPENED intent per cell (the schema allows one intent per episode). */
async function seedIntent(cell: string, status = 'pending'): Promise<{ episodeId: string; intentId: string }> {
  const episodeId = crypto.randomUUID();
  const intentId = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO "OutageEpisode" ("id", "zoneId", "h3Cell", "service", "provider", "expiresAt") VALUES (?, ?, ?, 'water', 'sedapal', ?)`)
      .bind(episodeId, zoneId, cell, new Date(Date.now() + 3_600_000).toISOString()),
    db.prepare(`INSERT INTO "AlertIntent" ("id", "episodeId", "kind", "content", "status") VALUES (?, ?, 'OPENED', 'Corte de agua', ?)`).bind(intentId, episodeId, status),
  ]);
  return { episodeId, intentId };
}

async function statusOf(intentId: string): Promise<{ status: string; attempts: number; leaseToken: string | null }> {
  return (await db.prepare('SELECT "status", "attempts", "leaseToken" FROM "AlertIntent" WHERE "id" = ?').bind(intentId).first<{ status: string; attempts: number; leaseToken: string | null }>())!;
}

beforeEach(async () => {
  await resetDatabase();
  process.env.ALERT_DISPATCH_ENABLED = 'true';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = 'test-chat';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ALERT_DISPATCH_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

describe('alert outbox', () => {
  it('claims and delivers each pending intent exactly once across concurrent dispatchers', async () => {
    const intents = await Promise.all(['a', 'b', 'c'].map((suffix) => seedIntent(`cell-${suffix}`)));
    let sent = 0;
    globalThis.fetch = () => { sent += 1; return Promise.resolve(new Response('', { status: 200 })); };

    const summaries = await Promise.all([alerts.dispatchPending(), alerts.dispatchPending(), alerts.dispatchPending()]);

    expect(sent).toBe(3);
    expect(summaries.filter((summary) => summary.claimedWork)).toHaveLength(1);
    for (const { intentId } of intents) expect(await statusOf(intentId)).toEqual({ status: 'delivered', attempts: 0, leaseToken: null });
  });

  it('claims at most 10 intents per cycle and reports the rest as due', async () => {
    for (let index = 0; index < 12; index += 1) await seedIntent(`bulk-${index}`);
    let sent = 0;
    globalThis.fetch = () => { sent += 1; return Promise.resolve(new Response('', { status: 200 })); };

    await expect(alerts.dispatchPending()).resolves.toEqual({ claimedWork: true, nextDueInSeconds: null });
    expect(sent).toBe(10);
    await expect(alerts.dispatchPending()).resolves.toEqual({ claimedWork: true, nextDueInSeconds: null });
    expect(sent).toBe(12);
  });

  it('never claims or delivers an intent that was already cancelled', async () => {
    const { intentId } = await seedIntent('cancelled-cell', 'cancelled');
    let sent = 0;
    globalThis.fetch = () => { sent += 1; return Promise.resolve(new Response('', { status: 200 })); };

    await expect(alerts.dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: null });
    expect(sent).toBe(0);
    expect((await statusOf(intentId)).status).toBe('cancelled');
  });

  it('does not mark an intent delivered when consensus cancels it between the claim and the delivery update', async () => {
    const { episodeId, intentId } = await seedIntent('race-cell');
    globalThis.fetch = async () => {
      // The restore quorum lands while the message is in flight.
      await db.batch([alerts.cancelPendingStatement(episodeId)]);
      return new Response('', { status: 200 });
    };

    await alerts.dispatchPending();

    expect(await statusOf(intentId)).toEqual({ status: 'cancelled', attempts: 0, leaseToken: null });
  });

  it('does not schedule a retry for an intent cancelled while its send was failing', async () => {
    const { episodeId, intentId } = await seedIntent('race-failed-cell');
    globalThis.fetch = async () => {
      await db.batch([alerts.cancelPendingStatement(episodeId)]);
      return new Response('', { status: 500 });
    };

    await alerts.dispatchPending();

    expect(await statusOf(intentId)).toEqual({ status: 'cancelled', attempts: 0, leaseToken: null });
  });

  it('backs a failed delivery off and reports when it is due', async () => {
    const { intentId } = await seedIntent('retry-cell');
    globalThis.fetch = () => Promise.resolve(new Response('', { status: 500 }));

    await alerts.dispatchPending();
    expect(await statusOf(intentId)).toEqual({ status: 'retryable', attempts: 1, leaseToken: null });

    const next = await alerts.dispatchPending();
    expect(next.claimedWork).toBe(false);
    expect(next.nextDueInSeconds).toBeGreaterThan(50);
    expect(next.nextDueInSeconds).toBeLessThanOrEqual(60);
  });

  it('leaves pending and retryable intents untouched while dispatch is disabled', async () => {
    const pending = await seedIntent('disabled-cell');
    const retryable = await seedIntent('disabled-retry-cell', 'retryable');
    delete process.env.ALERT_DISPATCH_ENABLED;
    let sent = 0;
    globalThis.fetch = () => { sent += 1; return Promise.resolve(new Response('', { status: 200 })); };

    await expect(alerts.dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: null });

    expect(sent).toBe(0);
    expect((await statusOf(pending.intentId)).status).toBe('pending');
    expect((await statusOf(retryable.intentId)).status).toBe('retryable');
  });

  it('marks an intent failed after the last allowed attempt, logs it and never claims it again', async () => {
    const { intentId } = await seedIntent('exhausted-cell');
    await db.prepare(`UPDATE "AlertIntent" SET "status" = 'retryable', "attempts" = ? WHERE "id" = ?`).bind(maxDeliveryAttempts - 1, intentId).run();
    let sent = 0;
    globalThis.fetch = () => { sent += 1; return Promise.resolve(new Response('', { status: 502 })); };
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
    try {
      await alerts.dispatchPending();
    } finally {
      console.error = original;
    }

    expect(await statusOf(intentId)).toEqual({ status: 'failed', attempts: maxDeliveryAttempts, leaseToken: null });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(intentId);
    expect(logged[0]).toContain('502');
    expect(logged[0]).not.toContain('Corte de agua');

    await expect(alerts.dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: null });
    expect(sent).toBe(1);
  });

  it('evaluates the same quorum twice without a second episode or intent', async () => {
    const consensus = new ConsensusService(alerts, db);
    const votes = [{ service: 'water' as const, provider: 'sedapal' as const, eventId: 'unused' }];
    const quorum = await Promise.all(['a', 'b', 'c'].map(async (suffix) => {
      const submissionId = crypto.randomUUID();
      await db.prepare(`INSERT INTO "SubmissionRecord" ("id", "deviceToken", "submissionId", "requestHash", "trustDecision", "expiresAt") VALUES (?, ?, ?, 'h', 'eligible', ?)`)
        .bind(submissionId, `device-${suffix}`, suffix, new Date(Date.now() + 3_600_000).toISOString()).run();
      const eventId = crypto.randomUUID();
      await db.prepare(`INSERT INTO "ReportEvent" ("id", "submissionId", "h3Cell", "service", "provider", "status", "deviceToken", "expiresAt") VALUES (?, ?, 'twice-cell', 'water', 'sedapal', 'outage', ?, ?)`)
        .bind(eventId, submissionId, `device-${suffix}`, new Date(Date.now() + 3_600_000).toISOString()).run();
      return eventId;
    }));
    const last = quorum[2] ?? '';

    await consensus.evaluate(zoneId, 'Cercado de Lima', 'twice-cell', 'outage', votes.map((vote) => ({ ...vote, eventId: last })));
    await consensus.evaluate(zoneId, 'Cercado de Lima', 'twice-cell', 'outage', votes.map((vote) => ({ ...vote, eventId: last })));

    const total = async (table: string): Promise<number> => (await db.prepare(`SELECT count(*) AS "total" FROM "${table}"`).first<{ total: number }>())?.total ?? 0;
    expect(await total('OutageEpisode')).toBe(1);
    expect(await total('AlertIntent')).toBe(1);
  });

  it('refuses a second active episode for the same cell, service and provider at the schema level', async () => {
    await seedIntent('unique-cell');
    const duplicate = db.prepare(`INSERT INTO "OutageEpisode" ("id", "zoneId", "h3Cell", "service", "provider", "expiresAt") VALUES (?, ?, 'unique-cell', 'water', 'sedapal', ?)`)
      .bind(crypto.randomUUID(), zoneId, new Date(Date.now() + 3_600_000).toISOString());

    await expect(duplicate.run()).rejects.toThrow(/UNIQUE/);
    await db.prepare(`UPDATE "OutageEpisode" SET "active" = 0 WHERE "h3Cell" = 'unique-cell'`).run();
    await expect(duplicate.run()).resolves.toBeDefined();
  });
});
