import { afterEach, describe, expect, it, vi } from 'vitest';

import { openingAlertContent, retryDelaySeconds } from './alerts.service.js';
import type { DatabasePool } from '../database/database.pool.js';

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
    const query = vi.fn((text: string) => ({ rows: rows(text) }));
    const { AlertsService } = await import('./alerts.service.js');
    return new AlertsService({ query } as unknown as DatabasePool);
  }

  const isClaim = (text: string): boolean => text.includes('SKIP LOCKED');
  const isNextDue = (text: string): boolean => text.includes('MIN("seconds")');
  const claimedIntent = { id: '00000000-0000-0000-0000-000000000001', content: 'Corte', attempts: 1, leaseToken: 'token' };

  it('reports claimed work so the worker keeps the dispatch interval', async () => {
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    const service = await serviceWith((text) => (isClaim(text) ? [claimedIntent] : []));

    await expect(service.dispatchPending()).resolves.toEqual({ claimedWork: true, nextDueInSeconds: null });
  });

  it('reports nothing due so the worker sleeps up to the idle interval', async () => {
    const service = await serviceWith((text) => (isClaim(text) ? [] : isNextDue(text) ? [{ seconds: null }] : []));

    await expect(service.dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: null });
  });

  it('reports the earliest next due attempt so the worker waits for that moment', async () => {
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    const service = await serviceWith((text) => (isClaim(text) ? [] : isNextDue(text) ? [{ seconds: '90' }] : []));

    await expect(service.dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: 90 });
  });

  it('keeps cancelling pending and retryable intents while dispatch is disabled', async () => {
    const queries: string[] = [];
    const query = vi.fn((text: string) => { queries.push(text); return { rows: [] }; });
    const { AlertsService } = await import('./alerts.service.js');
    const service = new AlertsService({ query } as unknown as DatabasePool);

    await expect(service.dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: null });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("'cancelled'");
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

  it('reports a claimable row skipped by SKIP LOCKED so the worker wakes at the dispatch interval, not the idle interval', async () => {
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    const texts: string[] = [];
    const query = vi.fn((text: string) => {
      texts.push(text);
      return { rows: text.includes('SKIP LOCKED') ? [] : [{ seconds: '0' }] };
    });
    const { AlertsService, dispatchCycleDelayMs } = await import('./alerts.service.js');
    const service = new AlertsService({ query } as unknown as DatabasePool);

    const summary = await service.dispatchPending();
    expect(summary).toEqual({ claimedWork: false, nextDueInSeconds: 1 });

    const predicate = `"status" IN ('pending', 'retryable') AND "nextAttemptAt" <= CURRENT_TIMESTAMP AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < CURRENT_TIMESTAMP)`;
    const claim = texts.find((text) => text.includes('SKIP LOCKED')) ?? '';
    const nextDue = texts.find((text) => text.includes('MIN("seconds")')) ?? '';
    expect(claim).toContain(predicate);
    expect(nextDue).toContain(predicate);

    expect(dispatchCycleDelayMs(summary, 30_000, 1_800_000)).toBe(30_000);
  });

  it('reports a lease at its exact expiry instant so no row is invisible to both boundaries', async () => {
    process.env.ALERT_DISPATCH_ENABLED = 'true';
    const texts: string[] = [];
    const query = vi.fn((text: string) => {
      texts.push(text);
      return { rows: text.includes('SKIP LOCKED') ? [] : [{ seconds: '0' }] };
    });
    const { AlertsService } = await import('./alerts.service.js');
    const service = new AlertsService({ query } as unknown as DatabasePool);

    await expect(service.dispatchPending()).resolves.toEqual({ claimedWork: false, nextDueInSeconds: 1 });

    const claim = texts.find((text) => text.includes('SKIP LOCKED')) ?? '';
    const nextDue = texts.find((text) => text.includes('MIN("seconds")')) ?? '';
    expect(claim).toContain('"leaseExpiresAt" < CURRENT_TIMESTAMP');
    expect(nextDue).toContain('"leaseExpiresAt" >= CURRENT_TIMESTAMP');
    expect(nextDue).not.toContain('"leaseExpiresAt" > CURRENT_TIMESTAMP');
  });
});
