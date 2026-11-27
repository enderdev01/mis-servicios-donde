import { beforeEach, describe, expect, it } from 'vitest';

import { count, db, limaCell, request, resetDatabase, submit } from './helpers.js';

const generic = { code: 'report_unavailable', message: 'Unable to process report.' };

beforeEach(resetDatabase);

describe('quorum under concurrency', () => {
  it('opens exactly one episode and one alert when a quorum arrives at once', async () => {
    const devices = ['a', 'b', 'c', 'd', 'e', 'f'];
    const responses = await Promise.all(devices.map((id) => submit({ deviceId: `burst-${id}`, submissionId: `burst-${id}` })));

    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ submissionId: `burst-${devices[index]}`, accepted: true });
    }
    expect(await count('OutageEpisode', '"active" = 1')).toBe(1);
    expect(await count('OutageEpisode')).toBe(1);
    expect(await count('AlertIntent', `"kind" = 'OPENED'`)).toBe(1);
    expect(await count('ReportEvent')).toBe(6);
  });

  it('keeps one active episode per service and provider, and a refresh extends it without a second alert', async () => {
    await Promise.all(['a', 'b', 'c'].map((id) => submit({ deviceId: `multi-${id}`, submissionId: `multi-w-${id}` })));
    await Promise.all(['a', 'b', 'c'].map((id) => submit({ deviceId: `multi-${id}`, submissionId: `multi-e-${id}`, services: ['electricity'], providers: { electricity: 'pluz' } })));

    expect(await count('OutageEpisode', '"active" = 1')).toBe(2);
    expect(await count('AlertIntent')).toBe(2);

    // Age the episode and drop the earlier votes, so a fresh quorum crosses the threshold again on an active episode.
    const soon = new Date(Date.now() + 60_000).toISOString();
    await db.batch([
      db.prepare(`DELETE FROM "ReportEvent" WHERE "service" = 'electricity'`),
      db.prepare(`UPDATE "OutageEpisode" SET "expiresAt" = ? WHERE "service" = 'electricity'`).bind(soon),
    ]);
    await Promise.all(['x', 'y', 'z'].map((id) => submit({ deviceId: `refresh-${id}`, submissionId: `refresh-${id}`, services: ['electricity'], providers: { electricity: 'pluz' } })));

    expect(await count('OutageEpisode', '"active" = 1')).toBe(2);
    expect(await count('OutageEpisode', `"service" = 'electricity' AND "expiresAt" > ?`, soon)).toBe(1);
    expect(await count('AlertIntent')).toBe(2);
  });

  it('shows reports below quorum as pending, confirms at quorum and clears on a restored quorum', async () => {
    const body = { services: ['internet'], providers: { internet: 'win' } };
    await Promise.all(['a', 'b'].map((id) => submit({ ...body, deviceId: `q-${id}`, submissionId: `q-${id}` })));
    expect(await (await request('/v1/cells?service=internet')).json()).toEqual([{ h3Cell: limaCell, service: 'internet', provider: 'win', confirmed: false }]);

    await submit({ ...body, deviceId: 'q-c', submissionId: 'q-c' });
    expect(await (await request('/v1/cells?service=internet')).json()).toEqual([{ h3Cell: limaCell, service: 'internet', provider: 'win', confirmed: true }]);

    await Promise.all(['a', 'b', 'c'].map((id) => submit({ ...body, status: 'restored', deviceId: `r-${id}`, submissionId: `r-${id}` })));
    expect(await (await request('/v1/cells?service=internet')).json()).toEqual([]);
    expect(await db.prepare(`SELECT "active", "closureReason" FROM "OutageEpisode" WHERE "service" = 'internet'`).first()).toEqual({ active: 0, closureReason: 'restored' });
    expect(await db.prepare('SELECT "status" FROM "AlertIntent"').first()).toEqual({ status: 'cancelled' });
  });
});

describe('replay and conflict', () => {
  const report = { deviceId: 'replay-device', submissionId: 'replay-1', services: ['water', 'electricity', 'internet'], providers: { water: 'sedapal', electricity: 'luz_del_sur', internet: 'win' }, name: 'Ana' };

  it('expands a submission across its services and keeps coordinates and device ids out of storage', async () => {
    const response = await submit(report);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ submissionId: 'replay-1', accepted: true });

    const events = await db.prepare('SELECT * FROM "ReportEvent" ORDER BY "service"').all<Record<string, unknown>>();
    expect(events.results.map((event) => event.service)).toEqual(['electricity', 'internet', 'water']);
    expect(new Set(events.results.map((event) => event.h3Cell))).toEqual(new Set([limaCell]));
    expect(JSON.stringify(events.results)).not.toMatch(/replay-device|-12\.0464|-77\.0428/);
    expect(await count('ReportDisplayName')).toBe(3);
  });

  it('returns the same outcome for an identical retry and rejects a changed payload for the same id', async () => {
    await submit(report);

    const retry = await submit(report);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual({ submissionId: 'replay-1', accepted: true });

    const changed = await submit({ ...report, services: ['water'], providers: { water: 'sedapal' }, status: 'restored' });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ code: 'submission_conflict', message: 'Submission identifier conflicts with prior input.' });
    expect(await count('ReportEvent')).toBe(3);
    expect(await count('SubmissionRecord')).toBe(1);
  });

  it('stores one submission when the same one is sent twice concurrently', async () => {
    const responses = await Promise.all([submit(report), submit(report), submit(report)]);

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    expect(await count('SubmissionRecord')).toBe(1);
    expect(await count('ReportEvent')).toBe(3);
  });

  it('rejects the same id with a different payload that races the first', async () => {
    const responses = await Promise.all([submit(report), submit({ ...report, services: ['water'], providers: { water: 'sedapal' } })]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await count('SubmissionRecord')).toBe(1);
  });
});

describe('per-device rate rule', () => {
  it('lets only one of two concurrent submissions from a device through for a service', async () => {
    const responses = await Promise.all([
      submit({ deviceId: 'rate-device', submissionId: 'rate-1' }),
      submit({ deviceId: 'rate-device', submissionId: 'rate-2' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const rejected = responses.find((response) => response.status === 409);
    expect(await rejected?.json()).toEqual({ code: 'already_reported', message: 'This device already reported a cut.' });
    expect(await count('ReportEvent')).toBe(1);
    expect(await count('SubmissionRecord')).toBe(1);
  });

  it('holds across cells, which are serialized by different coordinators', async () => {
    const responses = await Promise.all([
      submit({ deviceId: 'cells-device', submissionId: 'cells-1' }),
      submit({ deviceId: 'cells-device', submissionId: 'cells-2', latitude: -12.05, longitude: -77.03 }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await count('ReportEvent')).toBe(1);
  });

  it('refuses a second report for the same service as a whole and leaves nothing of its other services', async () => {
    await submit({ deviceId: 'whole-device', submissionId: 'whole-1', services: ['electricity'], providers: { electricity: 'pluz' } });

    const second = await submit({ deviceId: 'whole-device', submissionId: 'whole-2', services: ['water', 'electricity'], providers: { water: 'sedapal', electricity: 'pluz' } });

    expect(second.status).toBe(409);
    expect(await count('ReportEvent')).toBe(1);
    expect(await count('SubmissionRecord', '"submissionId" = ?', 'whole-2')).toBe(0);
  });

  it('lets the device report another service and the opposite status', async () => {
    await submit({ deviceId: 'free-device', submissionId: 'free-1' });

    expect((await submit({ deviceId: 'free-device', submissionId: 'free-2', services: ['internet'], providers: { internet: 'win' } })).status).toBe(201);
    expect((await submit({ deviceId: 'free-device', submissionId: 'free-3', status: 'restored' })).status).toBe(201);
  });
});

describe('input handling', () => {
  it('rejects a report outside the pilot zones without storing anything and without echoing the input', async () => {
    const response = await submit({ deviceId: 'raw-device', submissionId: 'outside-1', latitude: -13, longitude: -77 });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: 'outside_pilot_zone', message: 'Location is outside the pilot zones.' });
    expect(await count('ReportEvent')).toBe(0);
    expect(await count('SubmissionRecord')).toBe(0);
  });

  it('accepts an unsafe optional name without retaining it', async () => {
    expect((await submit({ deviceId: 'name-device', submissionId: 'name-1', name: '<>' })).status).toBe(201);

    expect(await count('ReportDisplayName')).toBe(0);
  });

  it('answers 503 intake_paused while the intake gate is off', async () => {
    const original = process.env.INTAKE_ENABLED;
    process.env.INTAKE_ENABLED = 'false';
    try {
      const response = await submit({ deviceId: 'paused-device', submissionId: 'paused-1' });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'intake_paused', message: 'Report intake is paused.' });
      expect(await count('SubmissionRecord')).toBe(0);
    } finally {
      process.env.INTAKE_ENABLED = original;
    }
  });

  it('rejects a malformed body generically', async () => {
    const response = await request('/v1/reports', { submissionId: 'x' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(generic);
  });
});
