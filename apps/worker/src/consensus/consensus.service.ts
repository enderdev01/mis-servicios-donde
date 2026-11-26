import { type Provider, type Service } from '@mis-servicios/contracts';

import { AlertsService } from '../alerts/alerts.service.js';
import { nowSql, offsetSql, selectRows } from '../database/d1.js';
import { configuredIntervalMs } from '../workers/interval-worker.js';
import { episodeLifetimeHours, isQuorumThresholdCrossing, quorumWindowMinutes, shouldRestoreEpisode } from './consensus-policy.js';

type Status = 'outage' | 'restored';
interface Vote { service: Service; provider: Provider; eventId: string }
interface Episode { id: string; openedAt: string }

const expireStale = `UPDATE "OutageEpisode" SET "active" = 0, "closedAt" = "expiresAt", "closureReason" = 'expired' WHERE "active" = 1 AND "expiresAt" <= ${nowSql}`;

/**
 * `evaluate` is a read-decide-write and D1 has no row locks, so callers must run it one at a time
 * per H3 cell (the `CellCoordinator` Durable Object). The partial unique index on active episodes
 * is the backstop: a second concurrent open fails instead of duplicating the episode.
 */
export class ConsensusService {
  constructor(private readonly alerts: AlertsService, private readonly db: D1Database) {}

  async evaluate(zoneId: string, zoneName: string, h3Cell: string, status: Status, votes: Vote[]): Promise<void> {
    for (const vote of votes) await this.evaluateVote(zoneId, zoneName, h3Cell, status, vote);
  }

  async listPublicEpisodes(): Promise<{ h3Cell: string; service: Service; provider: Provider }[]> {
    return selectRows(this.db, `SELECT "h3Cell", "service", "provider" FROM "OutageEpisode" WHERE "active" = 1 AND "expiresAt" > ${nowSql}`);
  }

  async expireStaleEpisodes(): Promise<void> {
    await this.db.prepare(expireStale).run();
  }

  private async evaluateVote(zoneId: string, zoneName: string, h3Cell: string, status: Status, vote: Vote): Promise<void> {
    const key = [h3Cell, vote.service, vote.provider];
    await this.db.prepare(`${expireStale} AND "h3Cell" = ? AND "service" = ? AND "provider" = ?`).bind(...key).run();
    const [episode] = await selectRows<Episode>(this.db, 'SELECT "id", "openedAt" FROM "OutageEpisode" WHERE "h3Cell" = ? AND "service" = ? AND "provider" = ? AND "active" = 1', key);
    const [closure] = !episode && status === 'outage'
      ? await selectRows<{ closedAt: string }>(this.db, 'SELECT "closedAt" FROM "OutageEpisode" WHERE "h3Cell" = ? AND "service" = ? AND "provider" = ? AND "closedAt" IS NOT NULL ORDER BY "closedAt" DESC LIMIT 1', key)
      : [];
    const voteWindowStart = status === 'restored' ? episode?.openedAt : closure?.closedAt;
    const [counts] = await selectRows<{ previous: number; current: number; activeOutageSignals: number; restoredVotesAfterOpening: number }>(
      this.db,
      `WITH latest AS (
        SELECT "id", "status", "createdAt" FROM (
          SELECT "id", "status", "createdAt", ROW_NUMBER() OVER (PARTITION BY "deviceToken" ORDER BY "createdAt" DESC, "id" DESC) AS "rank"
          FROM "ReportEvent"
          WHERE "h3Cell" = ? AND "service" = ? AND "provider" = ? AND "expiresAt" > ${nowSql}
        ) WHERE "rank" = 1
      ), quorum AS (
        SELECT * FROM latest WHERE "createdAt" > ${offsetSql(`-${quorumWindowMinutes} minutes`)}${voteWindowStart ? ' AND "createdAt" > ?' : ''}
      )
      SELECT count(*) FILTER (WHERE "status" = ? AND "id" <> ?) AS "previous",
        count(*) FILTER (WHERE "status" = ?) AS "current",
        (SELECT count(*) FROM latest WHERE "status" = 'outage') AS "activeOutageSignals",
        count(*) FILTER (WHERE "status" = 'restored') AS "restoredVotesAfterOpening"
      FROM quorum`,
      [...key, ...(voteWindowStart ? [voteWindowStart] : []), status, vote.eventId, status],
    );
    if (!counts || !isQuorumThresholdCrossing(Number(counts.previous), Number(counts.current))) return;
    if (status === 'restored') {
      if (episode && shouldRestoreEpisode({
        active: true,
        restoredVotesAfterOpening: Number(counts.restoredVotesAfterOpening),
        activeOutageSignals: Number(counts.activeOutageSignals),
      })) {
        // One batch: the episode never closes without its pending alert being cancelled.
        await this.db.batch([
          this.db.prepare(`UPDATE "OutageEpisode" SET "active" = 0, "closedAt" = ${nowSql}, "closureReason" = 'restored' WHERE "id" = ? AND "active" = 1`).bind(episode.id),
          this.alerts.cancelPendingStatement(episode.id),
        ]);
      }
      return;
    }
    if (episode) {
      await this.db.prepare(`UPDATE "OutageEpisode" SET "expiresAt" = ${offsetSql(`+${episodeLifetimeHours} hours`)}, "lastQuorumAt" = ${nowSql} WHERE "id" = ?`).bind(episode.id).run();
      return;
    }
    const episodeId = crypto.randomUUID();
    // ON CONFLICT DO NOTHING: if an active episode already exists the unique index skips the open, and the
    // intent statement (which needs the new episode row) skips with it.
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO "OutageEpisode" ("id", "zoneId", "h3Cell", "service", "provider", "expiresAt") VALUES (?, ?, ?, ?, ?, ${offsetSql(`+${episodeLifetimeHours} hours`)}) ON CONFLICT DO NOTHING`,
      ).bind(episodeId, zoneId, h3Cell, vote.service, vote.provider),
      this.alerts.openingStatement(episodeId, zoneName, vote.service),
    ]);
  }
}

export const episodeExpiryIntervalMs = configuredIntervalMs('EPISODE_EXPIRY_INTERVAL_SECONDS', 300);
