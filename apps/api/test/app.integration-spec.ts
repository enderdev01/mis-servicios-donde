import { readdir, readFile } from 'node:fs/promises';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { AlertsService } from '../src/alerts/alerts.service.js';
import { ConsensusService } from '../src/consensus/consensus.service.js';

/** Never DATABASE_URL: these specs drop the schema, and development data must survive them. */
const databaseUrl = process.env.TEST_DATABASE_URL ??
  'postgresql://mis_servicios:mis_servicios@127.0.0.1:54329/mis_servicios_test';

/* eslint-disable @typescript-eslint/no-unsafe-argument */

describe('executable API foundation', () => {
  let app: INestApplication;
  let database: pg.Pool;
  let consensus: ConsensusService;
  let alerts: AlertsService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.INTAKE_ENABLED = 'true';
    process.env.DEVICE_TOKEN_SECRET = 'test-device-secret';
    process.env.H3_RESOLUTION = '9';
    database = new pg.Pool({ connectionString: databaseUrl });
    await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const migrationsDirectory = new URL('../prisma/migrations/', import.meta.url);
    for (const entry of (await readdir(migrationsDirectory)).sort()) {
      const migration = await readFile(new URL(`../prisma/migrations/${entry}/migration.sql`, import.meta.url), 'utf8');
      await database.query(migration);
    }
    await database.query('CREATE TABLE IF NOT EXISTS fixture_probe (id integer PRIMARY KEY)');
    await database.query('TRUNCATE fixture_probe');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    consensus = app.get(ConsensusService);
    alerts = app.get(AlertsService);
  });

  afterAll(async () => {
    delete process.env.H3_RESOLUTION;
    await app?.close();
    await database?.end();
  });

  it('serves health through Supertest', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.text).toBe('{"status":"ok"}');
  });

  it('applies the coordinate-free privacy migration to PostgreSQL', async () => {
    const result = await database.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'ReportEvent'",
    );
    expect(result.rows.map((row) => row.column_name)).toContain('h3Cell');
    expect(result.rows.map((row) => row.column_name)).not.toContain('latitude');
  });

  describe('report intake', () => {
  const report = {
    submissionId: 'submission-001',
    deviceId: 'device-001',
    services: ['water', 'electricity', 'internet'],
    providers: { water: 'sedapal', electricity: 'luz_del_sur', internet: 'win' },
    status: 'outage',
    latitude: -12.0464,
    longitude: -77.0428,
    name: 'Ana',
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO "PilotZone" ("slug", "name", "approved", "boundary") VALUES ('central', 'Central', true, '{"minLatitude": -12.1, "maxLatitude": -12.0, "minLongitude": -77.1, "maxLongitude": -77.0}')`,
    );
  });

  it('rejects reports outside enabled pilot boundaries without creating report events', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/reports')
      .send({ ...report, submissionId: 'outside-001', latitude: -13, longitude: -77 })
      .expect(400);

    expect(response.body).toEqual({ code: 'report_unavailable', message: 'Unable to process report.' });
    expect((await database.query('SELECT * FROM "ReportEvent"')).rowCount).toBe(0);
  });

  it('expands a valid submission atomically across selected services and keeps raw coordinates out of storage', async () => {
    const response = await request(app.getHttpServer()).post('/v1/reports').send(report).expect(201);
    expect(response.body).toEqual({ submissionId: report.submissionId, accepted: true });

    const events = await database.query<{ service: string; "h3Cell": string; "deviceToken": string }>(
      'SELECT "service", "h3Cell", "deviceToken" FROM "ReportEvent" ORDER BY "service"',
    );
    expect(events.rows.map((event) => event.service)).toEqual(['water', 'electricity', 'internet']);
    expect(new Set(events.rows.map((event) => event.h3Cell)).size).toBe(1);
    expect(JSON.stringify(events.rows)).not.toContain(String(report.latitude));
    expect(JSON.stringify(events.rows)).not.toContain(report.deviceId);
    await expect(database.query(`UPDATE "ReportEvent" SET "status" = 'restored' WHERE "submissionId" = (SELECT "id" FROM "SubmissionRecord" WHERE "submissionId" = $1)`, [report.submissionId])).rejects.toThrow();
  });

  it('returns the original outcome for an identical retry and rejects a conflicting retry without adding events', async () => {
    const retry = await request(app.getHttpServer()).post('/v1/reports').send(report).expect(201);
    expect(retry.body).toEqual({ submissionId: report.submissionId, accepted: true });

    await request(app.getHttpServer())
      .post('/v1/reports')
      .send({ ...report, services: ['water'], providers: { water: 'sedapal' }, status: 'restored' })
      .expect(409)
      .expect({ code: 'submission_conflict', message: 'Submission identifier conflicts with prior input.' });

    expect((await database.query('SELECT * FROM "ReportEvent"')).rowCount).toBe(3);
  });

  it('rolls back every event when the service expansion cannot complete', async () => {
    await database.query(`
      CREATE OR REPLACE FUNCTION fail_internet_event() RETURNS trigger AS $$
      BEGIN
        IF NEW."service" = 'internet' THEN RAISE EXCEPTION 'forced event failure'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_internet_event BEFORE INSERT ON "ReportEvent"
      FOR EACH ROW EXECUTE FUNCTION fail_internet_event();
    `);

    await request(app.getHttpServer())
      .post('/v1/reports')
      .send({ ...report, deviceId: 'atomic-device', submissionId: 'atomic-001', services: ['water', 'internet'], providers: { water: 'sedapal', internet: 'win' } })
      .expect(500)
      .expect({ code: 'report_unavailable', message: 'Unable to process report.' });

    expect((await database.query('SELECT * FROM "SubmissionRecord" WHERE "submissionId" = $1', ['atomic-001'])).rowCount).toBe(0);
    expect((await database.query('SELECT * FROM "ReportEvent"')).rowCount).toBe(3);
  });

  it('serves only a safe printable notice for an approved pilot zone', async () => {
    await request(app.getHttpServer()).get('/v1/zones/central/notice').expect(200).expect({
      title: 'Aviso comunitario de cortes — Central',
      zone: 'Central',
      instructions: 'Reporta cortes de agua, luz o internet en el mapa comunitario.',
      mapUrl: '/',
      notice: 'Información sobre cortes generada por la comunidad, no oficial.',
    });
    await request(app.getHttpServer()).get('/v1/zones/missing/notice').expect(404);
    await database.query('UPDATE "PilotZone" SET "approved" = false WHERE "slug" = \'central\'');
    await request(app.getHttpServer()).get('/v1/zones/central/notice').expect(404);
    await database.query('UPDATE "PilotZone" SET "approved" = true WHERE "slug" = \'central\'');
  });

  it('lists only approved districts with their bounds for the map to centre on', async () => {
    const zones = await request(app.getHttpServer()).get('/v1/zones').expect(200);
    expect(zones.body).toEqual([{
      slug: 'central',
      name: 'Central',
      boundary: { minLatitude: -12.1, maxLatitude: -12.0, minLongitude: -77.1, maxLongitude: -77.0 },
    }]);

    await database.query('UPDATE "PilotZone" SET "approved" = false WHERE "slug" = \'central\'');
    await request(app.getHttpServer()).get('/v1/zones').expect(200).expect([]);
    await database.query('UPDATE "PilotZone" SET "approved" = true WHERE "slug" = \'central\'');
  });

});

describe('outage consensus', () => {
  const report = {
    services: ['water'],
    providers: { water: 'sedapal' },
    status: 'outage',
    latitude: -12.0464,
    longitude: -77.0428,
  };

  async function submit(device: string, submission: string, changes: Record<string, unknown> = {}): Promise<void> {
    await request(app.getHttpServer())
      .post('/v1/reports')
      .send({ ...report, ...changes, deviceId: device, submissionId: submission })
      .expect(201);
  }

  it('serializes concurrent threshold reports into one active episode', async () => {
    await submit('consensus-a', 'consensus-a');
    await Promise.all([
      submit('consensus-b', 'consensus-b'),
      submit('consensus-c', 'consensus-c'),
    ]);

    const episodes = await database.query<{ count: string }>(
      `SELECT count(*) FROM "OutageEpisode" WHERE "h3Cell" = (SELECT "h3Cell" FROM "ReportEvent" WHERE "submissionId" = (SELECT "id" FROM "SubmissionRecord" WHERE "submissionId" = 'consensus-a')) AND "service" = 'water' AND "active" = true`,
    );
    expect(episodes.rows[0]?.count).toBe('1');
  });

  it('keeps cell, service, and status quorums isolated', async () => {
    await Promise.all(['other-a', 'other-b', 'other-c'].map((id) => submit(id, id, { providers: { water: 'other' } })));
    await Promise.all([
      submit('electric-a', 'electric-a', { services: ['electricity'], providers: { electricity: 'luz_del_sur' } }),
      submit('electric-b', 'electric-b', { services: ['electricity'], providers: { electricity: 'luz_del_sur' } }),
      submit('electric-c', 'electric-c', { services: ['electricity'], providers: { electricity: 'luz_del_sur' } }),
      submit('restored-a', 'restored-a', { providers: { water: 'other' }, status: 'restored' }),
      submit('restored-b', 'restored-b', { providers: { water: 'other' }, status: 'restored' }),
      submit('restored-c', 'restored-c', { providers: { water: 'other' }, status: 'restored' }),
    ]);

    const episodes = await database.query<{ service: string; provider: string; active: boolean; closureReason: string | null }>(
      `SELECT "service", "provider", "active", "closureReason" FROM "OutageEpisode" WHERE "h3Cell" = (SELECT "h3Cell" FROM "ReportEvent" WHERE "submissionId" = (SELECT "id" FROM "SubmissionRecord" WHERE "submissionId" = 'consensus-a')) ORDER BY "service"::text, "provider"::text`,
    );
    expect(episodes.rows).toEqual([
      { service: 'electricity', provider: 'luz_del_sur', active: true, closureReason: null },
      { service: 'water', provider: 'other', active: false, closureReason: 'restored' },
      { service: 'water', provider: 'sedapal', active: true, closureReason: null },
    ]);

    await Promise.all(['reopened-a', 'reopened-b', 'reopened-c'].map((id) => submit(id, id, { providers: { water: 'other' } })));
    expect((await database.query<{ count: string }>('SELECT count(*) FROM "OutageEpisode" WHERE "service" = \'water\' AND "provider" = \'other\'', [])).rows[0]?.count).toBe('2');
    await database.query(`UPDATE "OutageEpisode" SET "active" = false, "closedAt" = CURRENT_TIMESTAMP, "closureReason" = 'expired'::"EpisodeClosureReason" WHERE "service" = 'water' AND "provider" = 'other' AND "active" = true`);
  });

  it('refreshes only after a later quorum and closes stale episodes without publishing them', async () => {
    const initial = await database.query<{ expiresAt: Date }>('SELECT "expiresAt" FROM "OutageEpisode" WHERE "service" = \'electricity\' AND "active" = true');
    await submit('electric-lone', 'electric-lone', { services: ['electricity'], providers: { electricity: 'luz_del_sur' } });
    expect((await database.query<{ expiresAt: Date }>('SELECT "expiresAt" FROM "OutageEpisode" WHERE "service" = \'electricity\' AND "active" = true')).rows[0]?.expiresAt)
      .toEqual(initial.rows[0]?.expiresAt);

    await database.query('ALTER TABLE "ReportEvent" DISABLE TRIGGER prevent_report_event_mutation');
    await database.query('UPDATE "ReportEvent" SET "createdAt" = CURRENT_TIMESTAMP - INTERVAL \'61 minutes\' WHERE "service" = \'electricity\' AND "status" = \'outage\'');
    await database.query('ALTER TABLE "ReportEvent" ENABLE TRIGGER prevent_report_event_mutation');
    await Promise.all(['refresh-a', 'refresh-b', 'refresh-c'].map((id) => submit(id, id, { services: ['electricity'], providers: { electricity: 'luz_del_sur' } })));
    const refreshed = await database.query<{ expiresAt: Date }>('SELECT "expiresAt" FROM "OutageEpisode" WHERE "service" = \'electricity\' AND "active" = true');
    expect(refreshed.rows[0]?.expiresAt.getTime()).toBeGreaterThan(initial.rows[0]?.expiresAt.getTime() ?? 0);

    const stale = await database.query<{ id: string; h3Cell: string }>('SELECT "id", "h3Cell" FROM "OutageEpisode" WHERE "service" = \'electricity\' AND "active" = true');
    await database.query('UPDATE "OutageEpisode" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE "id" = $1', [stale.rows[0]?.id]);
    expect(await consensus.listPublicEpisodes()).not.toContainEqual({ h3Cell: stale.rows[0]?.h3Cell, service: 'electricity', provider: 'luz_del_sur' });
    await consensus.expireStaleEpisodes();
    expect((await database.query<{ active: boolean; closureReason: string }>('SELECT "active", "closureReason" FROM "OutageEpisode" WHERE "id" = $1', [stale.rows[0]?.id])).rows[0])
      .toEqual({ active: false, closureReason: 'expired' });
  });

  it('publishes only active, approved, safe aggregates and suppresses disabled or expired cells', async () => {
    await request(app.getHttpServer()).get('/v1/cells').expect(200).expect([]);

    await database.query(
      `INSERT INTO "PilotZone" ("slug", "name", "approved", "boundary") VALUES ('north', 'North', true, '{"minLatitude": -12.1, "maxLatitude": -12.0, "minLongitude": -77.1, "maxLongitude": -77.0}')`,
    );
    process.env.PUBLIC_MAP_ENABLED = 'true';
    await Promise.all(['map-a', 'map-b', 'map-c'].map((id) => submit(id, id)));

    const cells = await request(app.getHttpServer()).get('/v1/cells?service=water').expect(200);
    const publicCells = (cells as unknown as { body: Array<{ h3Cell: string; service: string }> }).body;
    expect(publicCells).toHaveLength(1);
    expect(typeof publicCells[0]?.h3Cell).toBe('string');
    expect(publicCells[0]?.service).toBe('water');
    expect(JSON.stringify(publicCells)).not.toMatch(/device|name|created|timestamp|latitude|longitude/i);
    await request(app.getHttpServer()).get('/v1/cells?service=internet').expect(200).expect([{ h3Cell: '898e62c0cdbffff', service: 'internet', provider: 'win', confirmed: false, reports: 1 }]);
    await request(app.getHttpServer()).get('/v1/cells?service=unknown').expect(200).expect([]);

    await database.query('UPDATE "PilotZone" SET "approved" = false WHERE "slug" = \'central\'');
    await database.query(
      `INSERT INTO "PilotZone" ("slug", "name", "approved", "boundary") VALUES ('south', 'South', true, '{"minLatitude": -12.1, "maxLatitude": -12.0, "minLongitude": -77.1, "maxLongitude": -77.0}')`,
    );
    await request(app.getHttpServer()).get('/v1/cells?service=water').expect(200).expect([]);

    await database.query('UPDATE "OutageEpisode" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE "h3Cell" = $1 AND "service" = \'water\'', [publicCells[0]?.h3Cell]);
    await request(app.getHttpServer()).get('/v1/cells?service=water').expect(200).expect([]);
    delete process.env.PUBLIC_MAP_ENABLED;
  });

  it('keeps one safe opening intent recoverable across concurrency, provider failure, and dispatch rollback', async () => {
    await database.query('DROP TRIGGER fail_internet_event ON "ReportEvent"');
    await Promise.all(['alert-a', 'alert-b', 'alert-c'].map((id) => submit(id, id, { services: ['internet'], providers: { internet: 'win' } })));

    const intents = await database.query<{ count: string; content: string }>(
      `SELECT count(*), min(intent."content") AS "content" FROM "AlertIntent" intent JOIN "OutageEpisode" episode ON episode."id" = intent."episodeId" WHERE intent."kind" = 'OPENED' AND episode."service" = 'internet'`,
    );
    expect(intents.rows[0]?.count).toBe('1');
    expect(intents.rows[0]?.content).toContain('Corte de internet');
    expect(intents.rows[0]?.content).toContain('Información sobre cortes generada por la comunidad, no oficial.');
    expect(intents.rows[0]?.content).not.toMatch(/device|latitude|longitude|alert-a/i);

    process.env.ALERT_DISPATCH_ENABLED = 'true';
    await Promise.all([alerts.dispatchPending(), alerts.dispatchPending()]);
    expect((await database.query<{ status: string; attempts: number }>('SELECT intent."status", intent."attempts" FROM "AlertIntent" intent JOIN "OutageEpisode" episode ON episode."id" = intent."episodeId" WHERE episode."service" = \'internet\'')).rows[0]).toEqual({ status: 'retryable', attempts: 1 });
    expect((await database.query<{ active: boolean }>('SELECT "active" FROM "OutageEpisode" WHERE "service" = \'internet\'')).rows[0]).toEqual({ active: true });

    delete process.env.ALERT_DISPATCH_ENABLED;
    await alerts.dispatchPending();
    expect((await database.query<{ status: string }>('SELECT intent."status" FROM "AlertIntent" intent JOIN "OutageEpisode" episode ON episode."id" = intent."episodeId" WHERE episode."service" = \'internet\'')).rows[0]).toEqual({ status: 'cancelled' });
  });
});

});
