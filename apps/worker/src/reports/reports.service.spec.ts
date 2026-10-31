import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { ConsensusService } from '../consensus/consensus.service.js';
import type { DatabasePool } from '../database/database.pool.js';
import { ReportRequestError } from './report-input.js';
import { ReportsService } from './reports.service.js';

const report = {
  submissionId: 'submission-1',
  deviceId: 'device-1',
  services: ['water'],
  providers: { water: 'sedapal' },
  status: 'outage',
  latitude: -12.0464,
  longitude: -77.0428,
};

function buildService(): { service: ReportsService; query: Mock; connect: Mock } {
  const query = vi.fn();
  const connect = vi.fn();
  const database = { query, connect } as unknown as DatabasePool;
  return { service: new ReportsService({} as ConsensusService, database), query, connect };
}

describe('report intake configuration gates', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.INTAKE_ENABLED = 'true';
    process.env.H3_RESOLUTION = '9';
    process.env.DEVICE_TOKEN_SECRET = 'a-real-secret';
  });

  afterEach(() => { process.env = { ...original }; });

  it('refuses every report while the device secret is absent, before any database work', async () => {
    delete process.env.DEVICE_TOKEN_SECRET;
    const { service, query, connect } = buildService();

    await expect(service.accept(report)).rejects.toThrow(ReportRequestError);
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a blank device secret rather than deriving pseudonyms from whitespace', async () => {
    process.env.DEVICE_TOKEN_SECRET = '   ';
    const { service, query } = buildService();

    await expect(service.accept(report)).rejects.toThrow(ReportRequestError);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses every report while the H3 resolution is absent, before any database work', async () => {
    delete process.env.H3_RESOLUTION;
    const { service, query } = buildService();

    await expect(service.accept(report)).rejects.toThrow(ReportRequestError);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses intake while the gate is closed without reading configuration', async () => {
    delete process.env.INTAKE_ENABLED;
    const { service, query } = buildService();

    await expect(service.accept(report)).rejects.toThrow(ReportRequestError);
    expect(query).not.toHaveBeenCalled();
  });

  it('reaches the database once every gate and secret are in place', async () => {
    const { service, query } = buildService();

    await expect(service.accept(report)).rejects.toThrow();
    expect(query).toHaveBeenCalled();
  });
});
