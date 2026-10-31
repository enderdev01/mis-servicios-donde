import { type Provider, type Service } from '@mis-servicios/contracts';
import pg from 'pg';

import { AlertsService } from '../alerts/alerts.service.js';
import { configuredIntervalMs } from '../workers/interval-worker.js';
import { episodeLifetimeHours, isQuorumThresholdCrossing, orderedLockKeys, quorumWindowMinutes, shouldRestoreEpisode } from './consensus-policy.js';
import { DatabasePool } from '../database/database.pool.js';

type Status = 'outage' | 'restored';
interface Vote { service: Service; provider: Provider; eventId: string }
interface Episode { id: string; openedAt: Date; active: boolean }
interface Closure { closedAt: Date }

export class ConsensusService {

  constructor(private readonly alerts: AlertsService, private readonly database: DatabasePool) {}

  async evaluate(client: pg.PoolClient, zoneId: string, zoneName: string, h3Cell: string, status: Status, votes: Vote[]): Promise<void> {
    for (const key of orderedLockKeys(votes.map((vote) => [h3Cell, `${vote.service}:${vote.provider}`]))) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    }
    for (const vote of votes) await this.evaluateVote(client, zoneId, zoneName, h3Cell, status, vote);
  }

  async listPublicEpisodes(): Promise<{ h3Cell: string; service: Service; provider: Provider }[]> {
    const result = await this.database.query<{ h3Cell: string; service: Service; provider: Provider }>(
      'SELECT "h3Cell", "service", "provider" FROM "OutageEpisode" WHERE "active" = true AND "expiresAt" > CURRENT_TIMESTAMP',
    );
    return result.rows;
  }

  async expireStaleEpisodes(): Promise<void> {
    const candidates = await this.database.query<{ h3Cell: string; service: Service; provider: Provider }>(
      'SELECT "h3Cell", "service", "provider" FROM "OutageEpisode" WHERE "active" = true AND "expiresAt" <= CURRENT_TIMESTAMP',
    );
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      for (const key of orderedLockKeys(candidates.rows.map((episode) => [episode.h3Cell, `${episode.service}:${episode.provider}`]))) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      }
      await client.query('UPDATE "OutageEpisode" SET "active" = false, "closedAt" = "expiresAt", "closureReason" = \'expired\'::"EpisodeClosureReason" WHERE "active" = true AND "expiresAt" <= CURRENT_TIMESTAMP');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async evaluateVote(client: pg.PoolClient, zoneId: string, zoneName: string, h3Cell: string, status: Status, vote: Vote): Promise<void> {
    await client.query('UPDATE "OutageEpisode" SET "active" = false, "closedAt" = "expiresAt", "closureReason" = \'expired\'::"EpisodeClosureReason" WHERE "h3Cell" = $1 AND "service" = $2::"Service" AND "provider" = $3::"Provider" AND "active" = true AND "expiresAt" <= CURRENT_TIMESTAMP', [h3Cell, vote.service, vote.provider]);
    const active = await client.query<Episode>(
      'SELECT "id", "openedAt", "active" FROM "OutageEpisode" WHERE "h3Cell" = $1 AND "service" = $2::"Service" AND "provider" = $3::"Provider" AND "active" = true FOR UPDATE',
      [h3Cell, vote.service, vote.provider],
    );
    const episode = active.rows[0];
    const closure = !episode && status === 'outage' ? await client.query<Closure>(
      'SELECT "closedAt" FROM "OutageEpisode" WHERE "h3Cell" = $1 AND "service" = $2::"Service" AND "provider" = $3::"Provider" AND "closedAt" IS NOT NULL ORDER BY "closedAt" DESC LIMIT 1',
      [h3Cell, vote.service, vote.provider],
    ) : undefined;
    const voteWindowStart = status === 'restored' ? episode?.openedAt : closure?.rows[0]?.closedAt;
    const afterOpening = voteWindowStart ? ' AND "createdAt" > $6' : '';
    const parameters = voteWindowStart ? [h3Cell, vote.service, vote.provider, status, vote.eventId, voteWindowStart] : [h3Cell, vote.service, vote.provider, status, vote.eventId];
    const votes = await client.query<{ previous: string; current: string; activeOutageSignals: string; restoredVotesAfterOpening: string }>(
      `WITH latest AS (
        SELECT DISTINCT ON ("deviceToken") "id", "deviceToken", "status", "createdAt"
        FROM "ReportEvent"
        WHERE "h3Cell" = $1 AND "service" = $2::"Service" AND "provider" = $3::"Provider" AND "expiresAt" > CURRENT_TIMESTAMP
        ORDER BY "deviceToken", "createdAt" DESC, "id" DESC
      ), quorum AS (
        SELECT * FROM latest WHERE "createdAt" > CURRENT_TIMESTAMP - INTERVAL '${quorumWindowMinutes} minutes'${afterOpening}
      )
      SELECT count(*) FILTER (WHERE "status" = $4::"ReportStatus" AND "id" <> $5) AS previous,
        count(*) FILTER (WHERE "status" = $4::"ReportStatus") AS current,
        (SELECT count(*) FROM latest WHERE "status" = 'outage'::"ReportStatus") AS "activeOutageSignals",
        count(*) FILTER (WHERE "status" = 'restored'::"ReportStatus") AS "restoredVotesAfterOpening"
      FROM quorum`,
      parameters,
    );
    const counts = votes.rows[0];
    if (!counts || !isQuorumThresholdCrossing(Number(counts.previous), Number(counts.current))) return;
    if (status === 'restored') {
      if (episode && shouldRestoreEpisode({
        active: episode.active,
        restoredVotesAfterOpening: Number(counts.restoredVotesAfterOpening),
        activeOutageSignals: Number(counts.activeOutageSignals),
      })) {
        await client.query('UPDATE "OutageEpisode" SET "active" = false, "closedAt" = CURRENT_TIMESTAMP, "closureReason" = \'restored\'::"EpisodeClosureReason" WHERE "id" = $1', [episode.id]);
        await this.alerts.cancelPendingForEpisode(client, episode.id);
      }
      return;
    }
    if (episode) {
    await client.query(`UPDATE "OutageEpisode" SET "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '${episodeLifetimeHours} hours', "lastQuorumAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [episode.id]);
      return;
    }
    const created = await client.query<{ id: string }>(`INSERT INTO "OutageEpisode" ("zoneId", "h3Cell", "service", "provider", "expiresAt", "openedAt", "lastQuorumAt") VALUES ($1::uuid, $2, $3::"Service", $4::"Provider", CURRENT_TIMESTAMP + INTERVAL '${episodeLifetimeHours} hours', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING "id"`, [zoneId, h3Cell, vote.service, vote.provider]);
    if (created.rows[0]?.id) await this.alerts.queueOpening(client, created.rows[0].id, zoneName, vote.service);
  }
}

export const episodeExpiryIntervalMs = configuredIntervalMs('EPISODE_EXPIRY_INTERVAL_SECONDS', 300);

