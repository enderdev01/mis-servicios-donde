import { Injectable } from '@nestjs/common';
import pg from 'pg';

import { clampCycleDelayMs, configuredIntervalMs, type ScheduledWorker, startIntervalWorker } from '../workers/interval-worker.js';
import { DatabasePool } from '../database/database.pool.js';

type Service = 'water' | 'electricity' | 'internet';
interface ClaimedIntent { id: string; content: string; attempts: number; leaseToken: string }

/** What one dispatch cycle observed in the outbox, so the worker can sleep accordingly. */
export interface DispatchCycleSummary {
  claimedWork: boolean;
  nextDueInSeconds: number | null;
}

const unofficialLabel = 'Información sobre cortes generada por la comunidad, no oficial.';
const serviceLabels: Record<Service, string> = { water: 'agua', electricity: 'luz', internet: 'internet' };

export function openingAlertContent(input: { service: Service; zoneName: string }): string {
  return `Corte de ${serviceLabels[input.service]} en ${input.zoneName}. ${unofficialLabel}`;
}

export function retryDelaySeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(attempts - 1, 0), 3600);
}

/**
 * Conditions under which an outbox row is claimable right now. Shared verbatim
 * by `claimPending` and the due report so a claimable row can never be
 * invisible to both the claim and the wake calculation: if the two predicates
 * diverged, a permanently-matching row would pin the worker to the dispatch
 * interval instead of letting it idle.
 */
const claimableNowPredicate = `"status" IN ('pending', 'retryable') AND "nextAttemptAt" <= CURRENT_TIMESTAMP AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < CURRENT_TIMESTAMP)`;

@Injectable()
export class AlertsService {
  constructor(private readonly database: DatabasePool) {}

  async queueOpening(client: pg.PoolClient, episodeId: string, zoneName: string, service: Service): Promise<void> {
    await client.query(
      `INSERT INTO "AlertIntent" ("episodeId", "kind", "content") VALUES ($1::uuid, 'OPENED', $2) ON CONFLICT ("episodeId", "kind") DO NOTHING`,
      [episodeId, openingAlertContent({ zoneName, service })],
    );
  }

  async cancelPendingForEpisode(client: pg.PoolClient, episodeId: string): Promise<void> {
    await client.query(
      `UPDATE "AlertIntent" SET "status" = 'cancelled', "cancelledAt" = CURRENT_TIMESTAMP, "leaseToken" = NULL, "leaseExpiresAt" = NULL WHERE "episodeId" = $1::uuid AND "status" IN ('pending', 'retryable')`,
      [episodeId],
    );
  }

  async dispatchPending(): Promise<DispatchCycleSummary> {
    if (process.env.ALERT_DISPATCH_ENABLED !== 'true') {
      await this.database.query(`UPDATE "AlertIntent" SET "status" = 'cancelled', "cancelledAt" = CURRENT_TIMESTAMP WHERE "status" IN ('pending', 'retryable')`);
      return { claimedWork: false, nextDueInSeconds: null };
    }
    const intents = await this.claimPending();
    if (intents.length === 0) return { claimedWork: false, nextDueInSeconds: await this.nextDueInSeconds() };
    for (const intent of intents) await this.deliver(intent);
    return { claimedWork: true, nextDueInSeconds: null };
  }

  /**
   * Earliest moment the outbox becomes claimable again: either a retry backoff
   * elapses, an abandoned lease expires after a crashed cycle, or a row is
   * claimable now but was skipped by `FOR UPDATE SKIP LOCKED` because another
   * session held its lock.
   */
  private async nextDueInSeconds(): Promise<number | null> {
    const result = await this.database.query<{ seconds: string | null }>(
      `SELECT MIN("seconds") AS "seconds" FROM (
        SELECT CEIL(EXTRACT(EPOCH FROM ("nextAttemptAt" - CURRENT_TIMESTAMP))) AS "seconds"
          FROM "AlertIntent" WHERE "status" IN ('pending', 'retryable') AND "nextAttemptAt" > CURRENT_TIMESTAMP
        UNION ALL
        SELECT CEIL(EXTRACT(EPOCH FROM ("leaseExpiresAt" - CURRENT_TIMESTAMP))) AS "seconds"
          FROM "AlertIntent" WHERE "status" IN ('pending', 'retryable') AND "leaseExpiresAt" >= CURRENT_TIMESTAMP
        UNION ALL
        SELECT 0 AS "seconds" FROM "AlertIntent" WHERE ${claimableNowPredicate}
      ) due`,
    );
    const seconds = result.rows[0]?.seconds;
    return seconds == null ? null : Math.max(Number(seconds), 1);
  }

  private async claimPending(): Promise<ClaimedIntent[]> {
    const leaseToken = crypto.randomUUID();
    const result = await this.database.query<ClaimedIntent>(
      `WITH candidates AS (
        SELECT "id" FROM "AlertIntent" WHERE ${claimableNowPredicate} ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 10
      ) UPDATE "AlertIntent" intent SET "leaseToken" = $1, "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
      FROM candidates WHERE intent."id" = candidates."id" RETURNING intent."id", intent."content", intent."attempts", intent."leaseToken"`, [leaseToken],
    );
    return result.rows.filter((intent): intent is ClaimedIntent => intent.leaseToken !== null);
  }

  private async deliver(intent: ClaimedIntent): Promise<void> {
    try {
      await this.sendTelegram(intent.content);
      await this.database.query(`UPDATE "AlertIntent" SET "status" = 'delivered', "deliveredAt" = CURRENT_TIMESTAMP, "leaseToken" = NULL, "leaseExpiresAt" = NULL WHERE "id" = $1::uuid AND "leaseToken" = $2`, [intent.id, intent.leaseToken]);
    } catch {
      const attempts = intent.attempts + 1;
      await this.database.query(`UPDATE "AlertIntent" SET "status" = 'retryable', "attempts" = $3, "nextAttemptAt" = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second'), "leaseToken" = NULL, "leaseExpiresAt" = NULL WHERE "id" = $1::uuid AND "leaseToken" = $2`, [intent.id, intent.leaseToken, attempts, retryDelaySeconds(attempts)]);
    }
  }

  private async sendTelegram(content: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) throw new Error('Telegram is not configured.');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: content }) });
    if (!response.ok) throw new Error('Telegram rejected the alert.');
  }
}

export const alertDispatchIntervalMs = configuredIntervalMs('ALERT_DISPATCH_INTERVAL_SECONDS', 30);
export const alertDispatchIdleIntervalMs = configuredIntervalMs('ALERT_DISPATCH_IDLE_INTERVAL_SECONDS', 1800);

/**
 * Wake delay for one dispatch cycle, in milliseconds: claimed work keeps the
 * dispatch interval, a scheduled retry waits until it is due, and an empty
 * outbox sleeps up to the idle interval. The dispatch interval is the
 * unconditional floor: it encodes the operator's polling cadence and this
 * feature's objective, so an idle interval below it is raised to the floor
 * rather than allowed to shorten the wait.
 */
export function dispatchCycleDelayMs(summary: DispatchCycleSummary | undefined, intervalMs: number, idleMaxMs: number): number {
  // Precedence rule: the dispatch interval wins unconditionally. The idle
  // interval is a target that is raised to the dispatch floor, never a ceiling
  // that can lower it, so a contradictory pair cannot make the worker poll
  // faster than the configured dispatch interval.
  const effectiveIdleMaxMs = Math.max(idleMaxMs, intervalMs);
  if (summary?.claimedWork === true) return intervalMs;
  const nextDue = summary?.nextDueInSeconds;
  const requestedMs = typeof nextDue === 'number' && Number.isFinite(nextDue) ? nextDue * 1000 : effectiveIdleMaxMs;
  return clampCycleDelayMs(requestedMs, intervalMs, effectiveIdleMaxMs);
}

/**
 * One-line operator warning for a contradictory configuration, or null when
 * the idle interval already honors the dispatch floor. Built once and emitted
 * at worker startup by `startAlertDispatchWorker`, never per cycle.
 */
export function idleIntervalNormalizationWarning(idleMaxMs: number, intervalMs: number): string | null {
  if (idleMaxMs >= intervalMs) return null;
  return `ALERT_DISPATCH_IDLE_INTERVAL_SECONDS (${idleMaxMs / 1000}s) is below ALERT_DISPATCH_INTERVAL_SECONDS (${intervalMs / 1000}s); the configured value is left as is, so the effective idle ceiling is the dispatch interval for every cycle, which wins unconditionally as the polling cadence.`;
}

/**
 * Runs unconditionally: `dispatchPending` gates itself on ALERT_DISPATCH_ENABLED
 * and its disabled branch is the documented rollback that cancels pending and
 * retryable intents, so the worker must keep polling while dispatch is off.
 * Each cycle reports what the outbox needs and the worker sleeps between the
 * dispatch interval and the idle interval accordingly, with the dispatch
 * interval as the unconditional floor. A contradictory idle interval is warned
 * about exactly once at startup, never in the per-cycle hot path.
 */
export function startAlertDispatchWorker(alerts: AlertsService, warn: (message: string) => void = console.warn): ScheduledWorker {
  const warning = idleIntervalNormalizationWarning(alertDispatchIdleIntervalMs, alertDispatchIntervalMs);
  if (warning) warn(warning);
  return startIntervalWorker(async () => {
    const summary = await alerts.dispatchPending();
    return dispatchCycleDelayMs(summary, alertDispatchIntervalMs, alertDispatchIdleIntervalMs);
  }, alertDispatchIntervalMs);
}
