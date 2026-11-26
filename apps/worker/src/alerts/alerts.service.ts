import { nowSql, offsetSql, selectRows } from '../database/d1.js';
import { clampCycleDelayMs, configuredIntervalMs } from '../workers/interval-worker.js';

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
const claimableNowPredicate = `"status" IN ('pending', 'retryable') AND "nextAttemptAt" <= ${nowSql} AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${nowSql})`;

export class AlertsService {
  constructor(private readonly db: D1Database) {}

  /** Inserts the opening intent only if the episode row exists, so it can ride in the batch that opens the episode. */
  openingStatement(episodeId: string, zoneName: string, service: Service): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO "AlertIntent" ("id", "episodeId", "kind", "content") SELECT ?, ?, 'OPENED', ? WHERE EXISTS (SELECT 1 FROM "OutageEpisode" WHERE "id" = ?) ON CONFLICT ("episodeId", "kind") DO NOTHING`,
    ).bind(crypto.randomUUID(), episodeId, openingAlertContent({ zoneName, service }), episodeId);
  }

  /** Clearing the lease is what makes an in-flight claim unable to mark a cancelled intent delivered. */
  cancelPendingStatement(episodeId: string): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE "AlertIntent" SET "status" = 'cancelled', "cancelledAt" = ${nowSql}, "leaseToken" = NULL, "leaseExpiresAt" = NULL WHERE "episodeId" = ? AND "status" IN ('pending', 'retryable')`,
    ).bind(episodeId);
  }

  async dispatchPending(): Promise<DispatchCycleSummary> {
    if (process.env.ALERT_DISPATCH_ENABLED !== 'true') {
      await this.db.prepare(`UPDATE "AlertIntent" SET "status" = 'cancelled', "cancelledAt" = ${nowSql} WHERE "status" IN ('pending', 'retryable')`).run();
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
   * claimable now but was not claimed (the claim takes at most 10 rows).
   */
  private async nextDueInSeconds(): Promise<number | null> {
    const milliseconds = (column: string): string => `CAST(ROUND((julianday("${column}") - julianday('now')) * 86400000) AS INTEGER)`;
    const [row] = await selectRows<{ millis: number | null }>(
      this.db,
      `SELECT MIN("millis") AS "millis" FROM (
        SELECT ${milliseconds('nextAttemptAt')} AS "millis"
          FROM "AlertIntent" WHERE "status" IN ('pending', 'retryable') AND "nextAttemptAt" > ${nowSql}
        UNION ALL
        SELECT ${milliseconds('leaseExpiresAt')} AS "millis"
          FROM "AlertIntent" WHERE "status" IN ('pending', 'retryable') AND "leaseExpiresAt" >= ${nowSql}
        UNION ALL
        SELECT 0 AS "millis" FROM "AlertIntent" WHERE ${claimableNowPredicate}
      ) due`,
    );
    const millis = row?.millis;
    return millis == null ? null : Math.max(Math.ceil(Number(millis) / 1000), 1);
  }

  /** One atomic statement: the predicate is re-checked on the rows the subquery picked, so two claimers never share a row. */
  private async claimPending(): Promise<ClaimedIntent[]> {
    const leaseToken = crypto.randomUUID();
    const rows = await selectRows<Omit<ClaimedIntent, 'leaseToken'> & { leaseToken: string | null }>(
      this.db,
      `UPDATE "AlertIntent" SET "leaseToken" = ?, "leaseExpiresAt" = ${offsetSql('+5 minutes')}
      WHERE "id" IN (SELECT "id" FROM "AlertIntent" WHERE ${claimableNowPredicate} ORDER BY "createdAt" LIMIT 10) AND ${claimableNowPredicate}
      RETURNING "id", "content", "attempts", "leaseToken"`,
      [leaseToken],
    );
    return rows.filter((intent): intent is ClaimedIntent => intent.leaseToken !== null);
  }

  private async deliver(intent: ClaimedIntent): Promise<void> {
    // The status and lease guards make a cancel that landed after the claim win: it clears the lease.
    const owned = `"id" = ? AND "leaseToken" = ? AND "status" IN ('pending', 'retryable')`;
    try {
      await this.sendTelegram(intent.content);
      await this.db.prepare(`UPDATE "AlertIntent" SET "status" = 'delivered', "deliveredAt" = ${nowSql}, "leaseToken" = NULL, "leaseExpiresAt" = NULL WHERE ${owned}`).bind(intent.id, intent.leaseToken).run();
    } catch {
      const attempts = intent.attempts + 1;
      await this.db.prepare(`UPDATE "AlertIntent" SET "status" = 'retryable', "attempts" = ?, "nextAttemptAt" = ${offsetSql(`+${retryDelaySeconds(attempts)} seconds`)}, "leaseToken" = NULL, "leaseExpiresAt" = NULL WHERE ${owned}`).bind(attempts, intent.id, intent.leaseToken).run();
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
