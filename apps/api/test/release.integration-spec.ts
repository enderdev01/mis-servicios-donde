import { readdir, readFile } from 'node:fs/promises';

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AlertsService, dispatchCycleDelayMs } from '../src/alerts/alerts.service.js';
import { ConsensusService } from '../src/consensus/consensus.service.js';
import { AppModule } from '../src/app.module.js';

/** Never DATABASE_URL: these specs drop the schema, and development data must survive them. */
const databaseUrl = process.env.TEST_DATABASE_URL ??
  'postgresql://mis_servicios:mis_servicios@127.0.0.1:54329/mis_servicios_test';

describe('release outage flow', () => {
  let app: INestApplication;
  let database: pg.Pool;
  let alerts: AlertsService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.INTAKE_ENABLED = 'true';
    process.env.DEVICE_TOKEN_SECRET = 'test-device-secret';
    process.env.PUBLIC_MAP_ENABLED = 'true';
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    process.env.H3_RESOLUTION = '9';
    database = new pg.Pool({ connectionString: databaseUrl });
    await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const migrationsDirectory = new URL('../prisma/migrations/', import.meta.url);
    for (const entry of (await readdir(migrationsDirectory)).sort()) {
      await database.query(await readFile(new URL(`../prisma/migrations/${entry}/migration.sql`, import.meta.url), 'utf8'));
    }
    await database.query(`INSERT INTO "PilotZone" ("slug", "name", "approved", "boundary") VALUES
      ('central', 'Central', true, '{"minLatitude": -12.1, "maxLatitude": -12.0, "minLongitude": -77.1, "maxLongitude": -77.0}'),
      ('north', 'North', true, '{"minLatitude": -12.1, "maxLatitude": -12.0, "minLongitude": -77.1, "maxLongitude": -77.0}')`);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    alerts = app.get(AlertsService);
  });

  afterAll(async () => {
    delete process.env.INTAKE_ENABLED;
    delete process.env.PUBLIC_MAP_ENABLED;
    delete process.env.ALERT_DISPATCH_ENABLED;
    delete process.env.H3_RESOLUTION;
    await app?.close();
    await database?.end();
  });

  it('creates one safe public cell and one retryable opening intent from concurrent reports', async () => {
    const base = { services: ['water'], providers: { water: 'sedapal' }, status: 'outage', latitude: -12.0464, longitude: -77.0428, name: 'Release Reporter' };
    await Promise.all(['a', 'b', 'c'].map((suffix) => request(app.getHttpServer())
      .post('/v1/reports')
      .send({ ...base, deviceId: `release-device-${suffix}`, submissionId: `release-submission-${suffix}` })
      .expect(201)
      .expect({ submissionId: `release-submission-${suffix}`, accepted: true })));

    const cells = await request(app.getHttpServer()).get('/v1/cells?service=water').expect(200);
    expect(cells.body).toHaveLength(1);
    expect(Object.keys(cells.body[0] ?? {}).sort()).toEqual(['confirmed', 'h3Cell', 'provider', 'reports', 'service']);
    expect(JSON.stringify(cells.body)).not.toMatch(/device|reporter|latitude|longitude|created/i);

    await Promise.all([alerts.dispatchPending(), alerts.dispatchPending()]);
    const intents = await database.query<{ count: string; status: string; attempts: number; content: string }>(
      'SELECT count(*) OVER (), "status", "attempts", "content" FROM "AlertIntent"',
    );
    expect(intents.rows[0]).toMatchObject({ count: '1', status: 'retryable', attempts: 1 });
    expect(intents.rows[0]?.content).not.toMatch(/release|device|reporter|latitude|longitude/i);
  });

  it('refuses intake and suppresses public cells while rollout gates are disabled', async () => {
    delete process.env.INTAKE_ENABLED;
    await request(app.getHttpServer())
      .post('/v1/reports')
      .send({ services: ['water'], providers: { water: 'sedapal' }, status: 'outage', latitude: -12.0464, longitude: -77.0428, deviceId: 'disabled-device', submissionId: 'disabled-submission' })
      .expect(400)
      .expect({ code: 'report_unavailable', message: 'Unable to process report.' });
    expect((await database.query('SELECT * FROM "SubmissionRecord" WHERE "submissionId" = \'disabled-submission\'' )).rowCount).toBe(0);

    delete process.env.PUBLIC_MAP_ENABLED;
    await request(app.getHttpServer()).get('/v1/cells?service=water').expect(200).expect([]);

    delete process.env.ALERT_DISPATCH_ENABLED;
    await alerts.dispatchPending();
    await expect(database.query('SELECT "status" FROM "AlertIntent"')).resolves.toMatchObject({ rows: [{ status: 'cancelled' }] });
  });
});

describe('remediation verification coverage', () => {
  let app: INestApplication;
  let database: pg.Pool;
  let alerts: AlertsService;
  let consensus: ConsensusService;
  const report = { services: ['water'], providers: { water: 'sedapal' }, status: 'outage', latitude: -12.0464, longitude: -77.0428 };

  beforeAll(async () => {
    process.env.INTAKE_ENABLED = 'true';
    process.env.DEVICE_TOKEN_SECRET = 'test-device-secret';
    process.env.PUBLIC_MAP_ENABLED = 'true';
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    process.env.H3_RESOLUTION = '9';
    database = new pg.Pool({ connectionString: databaseUrl });
    await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const migrationsDirectory = new URL('../prisma/migrations/', import.meta.url);
    for (const entry of (await readdir(migrationsDirectory)).sort()) {
      await database.query(await readFile(new URL(`../prisma/migrations/${entry}/migration.sql`, import.meta.url), 'utf8'));
    }
    await database.query(`INSERT INTO "PilotZone" ("slug", "name", "approved", "boundary") VALUES
      ('central', 'Central', true, '{"minLatitude": -12.1, "maxLatitude": -12.0, "minLongitude": -77.1, "maxLongitude": -77.0}'),
      ('north', 'North', true, '{"minLatitude": -12.1, "maxLatitude": -12.0, "minLongitude": -77.1, "maxLongitude": -77.0}')`);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    alerts = app.get(AlertsService);
    consensus = app.get(ConsensusService);
  });

  afterAll(async () => {
    delete process.env.INTAKE_ENABLED;
    delete process.env.PUBLIC_MAP_ENABLED;
    delete process.env.ALERT_DISPATCH_ENABLED;
    delete process.env.H3_RESOLUTION;
    await app?.close();
    await database?.end();
  });

  async function submit(deviceId: string, submissionId: string, changes: Record<string, unknown> = {}): Promise<void> {
    await request(app.getHttpServer()).post('/v1/reports').send({ ...report, ...changes, deviceId, submissionId }).expect(201).expect({ submissionId, accepted: true });
  }

  it('keeps public operation disabled without a configured resolution or approved pilot set', async () => {
    const zone = await database.query<{ id: string }>('SELECT "id" FROM "PilotZone" WHERE "slug" = $1', ['central']);
    await database.query(`INSERT INTO "OutageEpisode" ("zoneId", "h3Cell", "service", "provider", "expiresAt") VALUES ($1, '898e62c0cdbffff', 'water', 'sedapal', CURRENT_TIMESTAMP + INTERVAL '6 hours')`, [zone.rows[0]?.id]);
    delete process.env.H3_RESOLUTION;
    await request(app.getHttpServer()).get('/v1/cells?service=water').expect(200).expect([]);
    process.env.H3_RESOLUTION = '9';
    await database.query('UPDATE "PilotZone" SET "approved" = false WHERE "slug" = $1', ['north']);
    await request(app.getHttpServer()).get('/v1/cells?service=water').expect(200).expect([]);
    await database.query('UPDATE "PilotZone" SET "approved" = true WHERE "slug" = $1', ['north']);
    await database.query(`UPDATE "OutageEpisode" SET "active" = false, "closedAt" = CURRENT_TIMESTAMP, "closureReason" = 'expired'::"EpisodeClosureReason" WHERE "h3Cell" = '898e62c0cdbffff' AND "service" = 'water' AND "provider" = 'sedapal' AND "active" = true`);
  });

  it('accepts an unsafe optional name without retaining it and keeps raw request data out of errors', async () => {
    await submit('name-device', 'unsafe-name', { name: '<>' });
    expect((await database.query('SELECT * FROM "ReportDisplayName"')).rowCount).toBe(0);

    const response = await request(app.getHttpServer()).post('/v1/reports').send({ ...report, deviceId: 'raw-device', submissionId: 'raw-submission', latitude: -13, longitude: -77 }).expect(400);
    expect(response.body).toEqual({ code: 'report_unavailable', message: 'Unable to process report.' });
    expect(JSON.stringify(response.body)).not.toMatch(/raw-device|-13|-77/);
    const persisted = await database.query('SELECT * FROM "SubmissionRecord" UNION ALL SELECT * FROM "SubmissionRecord" WHERE false');
    expect(JSON.stringify(persisted.rows)).not.toContain('raw-device');
  });

  it('accepts one report per device and refuses a second with an explicit signal', async () => {
    await submit('limited-device', 'limited-one', { services: ['electricity'], providers: { electricity: 'pluz' } });
    const second = await request(app.getHttpServer())
      .post('/v1/reports')
      .send({ ...report, services: ['electricity'], providers: { electricity: 'pluz' }, deviceId: 'limited-device', submissionId: 'limited-two' });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ code: 'already_reported', message: 'This device already reported a cut.' });
    expect((await database.query('SELECT * FROM "ReportEvent" WHERE "service" = \'electricity\'')).rowCount).toBe(1);
    await request(app.getHttpServer()).get('/v1/cells?service=electricity').expect(200).expect([{ h3Cell: '898e62c0cdbffff', service: 'electricity', provider: 'pluz', confirmed: false, reports: 1 }]);
  });

  it('shows reports below quorum as pending and removes restored conditions from the public map', async () => {
    await Promise.all(['a', 'b'].map((suffix) => submit(`below-${suffix}`, `below-${suffix}`, { services: ['internet'], providers: { internet: 'win' } })));
    await request(app.getHttpServer()).get('/v1/cells?service=internet').expect(200).expect([{ h3Cell: '898e62c0cdbffff', service: 'internet', provider: 'win', confirmed: false, reports: 2 }]);

    await submit('below-c', 'below-c', { services: ['internet'], providers: { internet: 'win' } });
    const confirmed = await request(app.getHttpServer()).get('/v1/cells?service=internet').expect(200);
    expect(confirmed.body as unknown).toEqual([{ h3Cell: '898e62c0cdbffff', service: 'internet', provider: 'win', confirmed: true, reports: 3 }]);
    await Promise.all(['a', 'b', 'c'].map((suffix) => submit(`restored-${suffix}`, `restored-${suffix}`, { services: ['internet'], providers: { internet: 'win' }, status: 'restored' })));
    await request(app.getHttpServer()).get('/v1/cells?service=internet').expect(200).expect([]);
    expect((await database.query<{ active: boolean; closureReason: string }>('SELECT "active", "closureReason" FROM "OutageEpisode" WHERE "service" = \'internet\'' )).rows[0]).toEqual({ active: false, closureReason: 'restored' });
  });

  it('retries the same alert successfully and never creates alerts for refresh or closure', async () => {
    await Promise.all(['a', 'b', 'c'].map((suffix) => submit(`retry-${suffix}`, `retry-${suffix}`)));
    const intent = await database.query<{ id: string }>('SELECT "id" FROM "AlertIntent" WHERE "status" = \'pending\' ORDER BY "createdAt" DESC LIMIT 1');
    await alerts.dispatchPending();
    await database.query('UPDATE "AlertIntent" SET "nextAttemptAt" = CURRENT_TIMESTAMP WHERE "id" = $1', [intent.rows[0]?.id]);
    const originalFetch = globalThis.fetch;
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = 'test-chat';
    globalThis.fetch = () => Promise.resolve(new Response('', { status: 200 }));
    try {
      await alerts.dispatchPending();
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
    expect((await database.query<{ id: string; status: string; attempts: number }>('SELECT "id", "status", "attempts" FROM "AlertIntent" WHERE "id" = $1', [intent.rows[0]?.id])).rows[0])
      .toEqual({ id: intent.rows[0]?.id, status: 'delivered', attempts: 1 });

    await Promise.all(['electric-open-a', 'electric-open-b', 'electric-open-c'].map((id) => submit(id, id, { services: ['electricity'], providers: { electricity: 'luz_del_sur' } })));
    expect((await database.query('SELECT * FROM "AlertIntent" WHERE "status" <> \'cancelled\'')).rowCount).toBe(2);
    await database.query('ALTER TABLE "ReportEvent" DISABLE TRIGGER prevent_report_event_mutation');
    await database.query('UPDATE "ReportEvent" SET "createdAt" = CURRENT_TIMESTAMP - INTERVAL \'61 minutes\' WHERE "service" = \'electricity\'');
    await database.query('ALTER TABLE "ReportEvent" ENABLE TRIGGER prevent_report_event_mutation');
    await Promise.all(['refresh-a', 'refresh-b', 'refresh-c'].map((id) => submit(id, id, { services: ['electricity'], providers: { electricity: 'luz_del_sur' } })));
    expect((await database.query('SELECT * FROM "AlertIntent" WHERE "status" <> \'cancelled\'')).rowCount).toBe(2);
    await Promise.all(['close-a', 'close-b', 'close-c'].map((id) => submit(id, id, { services: ['electricity'], providers: { electricity: 'luz_del_sur' }, status: 'restored' })));
    expect((await database.query('SELECT * FROM "AlertIntent" WHERE "status" <> \'cancelled\'')).rowCount).toBe(2);
    await database.query('UPDATE "OutageEpisode" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE "service" = \'water\'');
    await consensus.expireStaleEpisodes();
    expect((await database.query('SELECT * FROM "AlertIntent" WHERE "status" <> \'cancelled\'')).rowCount).toBe(2);
  });
});

describe('dispatch wake budget', () => {
  let app: INestApplication;
  let database: pg.Pool;
  let alerts: AlertsService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    database = new pg.Pool({ connectionString: databaseUrl });
    await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const migrationsDirectory = new URL('../prisma/migrations/', import.meta.url);
    for (const entry of (await readdir(migrationsDirectory)).sort()) {
      await database.query(await readFile(new URL(`../prisma/migrations/${entry}/migration.sql`, import.meta.url), 'utf8'));
    }
    await database.query(`INSERT INTO "PilotZone" ("slug", "name", "approved", "boundary") VALUES
      ('wake-central', 'Wake Central', true, '{"minLatitude": -12.1, "maxLatitude": -12.0, "minLongitude": -77.1, "maxLongitude": -77.0}')`);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    alerts = app.get(AlertsService);
  });

  afterAll(async () => {
    delete process.env.ALERT_DISPATCH_ENABLED;
    await app?.close();
    await database?.end();
  });

  it('reports a claimable row skipped by SKIP LOCKED as due now so the worker wakes at the dispatch interval, not the idle interval', async () => {
    const zone = await database.query<{ id: string }>('SELECT "id" FROM "PilotZone" WHERE "slug" = \'wake-central\'');
    const episode = await database.query<{ id: string }>(
      `INSERT INTO "OutageEpisode" ("zoneId", "h3Cell", "service", "provider", "expiresAt")
       VALUES ($1, '898e62c0cdbffff', 'water', 'sedapal', CURRENT_TIMESTAMP + INTERVAL '6 hours') RETURNING "id"`,
      [zone.rows[0]?.id],
    );
    await database.query(
      `INSERT INTO "AlertIntent" ("episodeId", "kind", "content") VALUES ($1, 'OPENED', $2)`,
      [episode.rows[0]?.id, 'Corte de agua en Central. Información sobre cortes generada por la comunidad, no oficial.'],
    );

    const holder = await database.connect();
    try {
      await holder.query('BEGIN');
      const locked = await holder.query<{ id: string }>('SELECT "id" FROM "AlertIntent" WHERE "episodeId" = $1 FOR UPDATE', [episode.rows[0]?.id]);
      expect(locked.rows).toHaveLength(1);

      const summary = await alerts.dispatchPending();
      expect(summary).toEqual({ claimedWork: false, nextDueInSeconds: 1 });
      expect(dispatchCycleDelayMs(summary, 30_000, 1_800_000)).toBe(30_000);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});
