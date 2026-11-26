import { afterEach, describe, expect, it, vi } from 'vitest';

import { nowSql } from '../database/d1.js';
import { fakeD1 } from '../database/fake-d1.js';
import { openingAlertContent, retryDelaySeconds } from './alerts.service.js';

describe('alert delivery policy', () => {
  it('renders an opening alert with only aggregate community data', () => {
    const content = openingAlertContent({ service: 'water', zoneName: 'Central' });

    expect(content).toContain('Corte de agua');
    expect(content).toContain('Central');
    expect(content).toContain('Información sobre cortes generada por la comunidad, no oficial.');
    expect(content).not.toMatch(/ana|device|token|latitude|longitude|timestamp/i);
  });

  it('increases retry delay while bounding it for recoverable attempts', () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(120);
    expect(retryDelaySeconds(20)).toBe(3600);
  });
});

describe('dispatch cycle cadence', () => {
  afterEach(() => { delete process.env.ALERT_DISPATCH_ENABLED; });

  async function serviceWith(rows: (text: string) => unknown[]) {
    const { AlertsService } = await import('./alerts.service.js');
    return new AlertsService(fakeD1(rows).db);
  }

  const isClaim = (text: string): boolean => text.includes('RETURNING');
  const isNextDue = (text: string): boolean => text.includes('MIN("millis")');
  const claimedIntent = { id: '00000000-0000-0000-0000-000000000001', content: 'Corte', attempts: 1, leaseToken: 'token' };

  it('reports claimed work so the worker keeps the dispatch interval', async () => {
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    const service = await serviceWith((text) => (isClaim(text) ? [claimedIntent] : []));

    await expect(service.dispatchPending()).resolves.toEqual({ claimedWork: true, nextDueInSeconds: null });
  });

  it('reports nothing due so the worker sleeps up to the idle interval', async () => {
    const service = await serviceWith((text) => (isClaim(text) ? [] : isNextDue(text) ? [{ millis: null }] : []));

    await expect(service.dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: null });
  });

  it('reports the earliest next due attempt so the worker waits for that moment', async () => {
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    const service = await serviceWith((text) => (isClaim(text) ? [] : isNextDue(text) ? [{ millis: 90_000 }] : []));

    await expect(service.dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: 90 });
  });

  it('keeps cancelling pending and retryable intents while dispatch is disabled', async () => {
    const { db, sqls } = fakeD1();
    const { AlertsService } = await import('./alerts.service.js');
    const service = new AlertsService(db);

    await expect(service.dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: null });
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("'cancelled'");
  });

  it('derives the wake delay from the cycle summary inside the configured bounds', async () => {
    const { dispatchCycleDelayMs } = await import('./alerts.service.js');

    expect(dispatchCycleDelayMs({ claimedWork: true, nextDueInSeconds: null }, 30_000, 1_800_000)).toBe(30_000);
    expect(dispatchCycleDelayMs({ claimedWork: false, nextDueInSeconds: 90 }, 30_000, 1_800_000)).toBe(90_000);
    expect(dispatchCycleDelayMs({ claimedWork: false, nextDueInSeconds: 5 }, 30_000, 1_800_000)).toBe(30_000);
    expect(dispatchCycleDelayMs({ claimedWork: false, nextDueInSeconds: 4000 }, 30_000, 1_800_000)).toBe(1_800_000);
    expect(dispatchCycleDelayMs({ claimedWork: false, nextDueInSeconds: null }, 30_000, 1_800_000)).toBe(1_800_000);
  });

  it('keeps the dispatch interval as the floor even when the idle ceiling is below it', async () => {
    const { dispatchCycleDelayMs } = await import('./alerts.service.js');

    expect(dispatchCycleDelayMs({ claimedWork: false, nextDueInSeconds: null }, 3_600_000, 1_800_000)).toBe(3_600_000);
    expect(dispatchCycleDelayMs({ claimedWork: false, nextDueInSeconds: 7200 }, 3_600_000, 1_800_000)).toBe(3_600_000);
    expect(dispatchCycleDelayMs({ claimedWork: false, nextDueInSeconds: 90 }, 3_600_000, 1_800_000)).toBe(3_600_000);
  });

  it('honors the configured dispatch interval over a contradictory idle interval from the environment', async () => {
    process.env.ALERT_DISPATCH_INTERVAL_SECONDS = '3600';
    process.env.ALERT_DISPATCH_IDLE_INTERVAL_SECONDS = '1800';
    vi.resetModules();
    try {
      const { alertDispatchIntervalMs, alertDispatchIdleIntervalMs, dispatchCycleDelayMs } = await import('./alerts.service.js');

      expect(alertDispatchIntervalMs).toBe(3_600_000);
      expect(alertDispatchIdleIntervalMs).toBe(1_800_000);
      expect(dispatchCycleDelayMs({ claimedWork: false, nextDueInSeconds: null }, alertDispatchIntervalMs, alertDispatchIdleIntervalMs)).toBe(3_600_000);
      expect(dispatchCycleDelayMs({ claimedWork: false, nextDueInSeconds: 600 }, alertDispatchIntervalMs, alertDispatchIdleIntervalMs)).toBe(3_600_000);
    } finally {
      delete process.env.ALERT_DISPATCH_INTERVAL_SECONDS;
      delete process.env.ALERT_DISPATCH_IDLE_INTERVAL_SECONDS;
    }
  });

  it('builds the idle normalization warning only for a contradictory pair', async () => {
    const { idleIntervalNormalizationWarning } = await import('./alerts.service.js');

    const warning = idleIntervalNormalizationWarning(1_800_000, 3_600_000);
    expect(warning).toContain('ALERT_DISPATCH_IDLE_INTERVAL_SECONDS');
    expect(warning).toContain('ALERT_DISPATCH_INTERVAL_SECONDS');
    expect(warning).toContain('the effective idle ceiling is the dispatch interval');
    expect(warning).not.toContain('was raised');
    expect(idleIntervalNormalizationWarning(3_600_000, 3_600_000)).toBeNull();
    expect(idleIntervalNormalizationWarning(7_200_000, 3_600_000)).toBeNull();
  });

  it('reports a claimable row the claim did not take so the worker wakes at the dispatch interval, not the idle interval', async () => {
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    const { db, sqls } = fakeD1((text) => (text.includes('RETURNING') ? [] : [{ millis: 0 }]));
    const { AlertsService, dispatchCycleDelayMs } = await import('./alerts.service.js');

    const summary = await new AlertsService(db).dispatchPending();
    expect(summary).toEqual({ claimedWork: false, nextDueInSeconds: 1 });

    const predicate = `"status" IN ('pending', 'retryable') AND "nextAttemptAt" <= ${nowSql} AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${nowSql})`;
    const claim = sqls.find((text) => text.includes('RETURNING')) ?? '';
    const nextDue = sqls.find((text) => text.includes('MIN("millis")')) ?? '';
    expect(claim).toContain(predicate);
    expect(nextDue).toContain(predicate);

    expect(dispatchCycleDelayMs(summary, 30_000, 1_800_000)).toBe(30_000);
  });

  it('reports a lease at its exact expiry instant so no row is invisible to both boundaries', async () => {
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    const { db, sqls } = fakeD1((text) => (text.includes('RETURNING') ? [] : [{ millis: 0 }]));
    const { AlertsService } = await import('./alerts.service.js');

    await expect(new AlertsService(db).dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: 1 });

    const claim = sqls.find((text) => text.includes('RETURNING')) ?? '';
    const nextDue = sqls.find((text) => text.includes('MIN("millis")')) ?? '';
    expect(claim).toContain(`"leaseExpiresAt" < ${nowSql}`);
    expect(nextDue).toContain(`"leaseExpiresAt" >= ${nowSql}`);
    expect(nextDue).not.toContain(`"leaseExpiresAt" > ${nowSql}`);
  });

  it('guards the delivery update with the lease and a claimable status so a cancel wins', async () => {
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    const { db, sqls } = fakeD1((text) => (text.includes('RETURNING') ? [claimedIntent] : []));
    const { AlertsService } = await import('./alerts.service.js');

    await new AlertsService(db).dispatchPending();

    const update = sqls.find((text) => text.includes('SET "status" = \'retryable\'')) ?? '';
    expect(update).toContain(`"leaseToken" = ? AND "status" IN ('pending', 'retryable')`);
  });
});
