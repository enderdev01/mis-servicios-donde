import { beforeEach, describe, expect, it } from 'vitest';

import { AlertsService } from '../src/alerts/alerts.service.js';
import { ConsensusService } from '../src/consensus/consensus.service.js';
import { ReportIntake, type IntakeJob } from '../src/reports/report-intake.js';
import { count, db, limaCell, request, resetDatabase, submit } from './helpers.js';

beforeEach(resetDatabase);

const outages = (prefix: string, ids: string[]): Promise<Response[]> =>
  Promise.all(ids.map((id) => submit({ deviceId: `${prefix}-${id}`, submissionId: `${prefix}-${id}` })));

describe('#69 pending cells after a closed episode', () => {
  it('#69 shows a pending cell after a past episode was closed', async () => {
    await outages('o', ['a', 'b', 'c']);
    await Promise.all(['a', 'b', 'c'].map((id) => submit({ deviceId: `r-${id}`, submissionId: `r-${id}`, status: 'restored' })));
    expect(await count('OutageEpisode', '"active" = 0')).toBe(1);

    await submit({ deviceId: 'fresh', submissionId: 'fresh' });

    const cells = await (await request('/v1/cells?service=water')).json<Record<string, unknown>[]>();
    expect(cells).toMatchObject([{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: false }]);
  });
});

describe('#71 public cells never publish counts', () => {
  it('#71 returns no reports key on any cell', async () => {
    await outages('p', ['a', 'b']);
    await outages('q', ['a', 'b', 'c']);

    const cells = await (await request('/v1/cells')).json<Record<string, unknown>[]>();
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell).not.toHaveProperty('reports');
  });
});

describe('#70 sustained outage extends the episode', () => {
  it('#70 extends expiresAt on every outage vote that meets quorum, with one OPENED alert', async () => {
    await outages('s', ['a', 'b', 'c']);
    const soon = new Date(Date.now() + 60_000).toISOString();
    await db.prepare('UPDATE "OutageEpisode" SET "expiresAt" = ?').bind(soon).run();

    await submit({ deviceId: 's-d', submissionId: 's-d' });

    expect(await count('OutageEpisode', '"active" = 1 AND "expiresAt" > ?', new Date(Date.now() + 5 * 3_600_000).toISOString())).toBe(1);
    expect(await count('OutageEpisode')).toBe(1);
    expect(await count('AlertIntent', `"kind" = 'OPENED'`)).toBe(1);
  });
});

describe('#68 evaluation is retried on replay', () => {
  const build = async (fail: boolean): Promise<{ intake: ReportIntake; job: (n: string) => IntakeJob }> => {
    const zone = await db.prepare('SELECT "id", "name" FROM "PilotZone" WHERE "approved" = 1 LIMIT 1').first<{ id: string; name: string }>();
    const real = new ConsensusService(new AlertsService(db), db);
    let thrown = !fail;
    const consensus = {
      evaluate: async (...args: Parameters<ConsensusService['evaluate']>) => {
        if (!thrown) { thrown = true; throw new Error('boom'); }
        return real.evaluate(...args);
      },
    } as ConsensusService;
    const job = (n: string): IntakeJob => ({
      zoneId: zone!.id, zoneName: zone!.name, h3Cell: limaCell, deviceToken: `tok-${n}`, requestHash: 'h',
      input: { submissionId: `sub-${n}`, services: ['water'], providers: { water: 'sedapal' }, status: 'outage' },
    });
    return { intake: new ReportIntake(consensus, db), job };
  };

  it('#68 opens the episode when the retry of a submission whose evaluation threw is a replay', async () => {
    await outages('f', ['a', 'b']);
    const { intake, job } = await build(true);

    await expect(intake.persist(job('c'))).rejects.toThrow('boom');
    expect(await count('OutageEpisode')).toBe(0);

    await intake.persist(job('c'));
    expect(await count('OutageEpisode', '"active" = 1')).toBe(1);
    expect(await count('AlertIntent', `"kind" = 'OPENED'`)).toBe(1);
  });

  it('#68 a normal replay creates no duplicate episode or alert', async () => {
    await outages('g', ['a', 'b']);
    const { intake, job } = await build(false);

    await intake.persist(job('c'));
    await intake.persist(job('c'));
    await intake.persist(job('c'));

    expect(await count('OutageEpisode')).toBe(1);
    expect(await count('AlertIntent')).toBe(1);
    expect(await count('ReportEvent')).toBe(3);
  });
});
