import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { fakeD1 } from '../database/fake-d1.js';
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

function buildService(): { service: ReportsService; query: Mock; runIntake: Mock } {
  const { db, prepare } = fakeD1();
  const runIntake = vi.fn();
  return { service: new ReportsService(db, runIntake), query: prepare, runIntake };
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
    const { service, query, runIntake } = buildService();

    await expect(service.accept(report)).rejects.toThrow(ReportRequestError);
    expect(query).not.toHaveBeenCalled();
    expect(runIntake).not.toHaveBeenCalled();
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

  it('reaches the database once every gate and secret are in place, and refuses a report outside every zone', async () => {
    const { service, query, runIntake } = buildService();

    await expect(service.accept(report)).rejects.toThrow(ReportRequestError);
    expect(query).toHaveBeenCalled();
    expect(runIntake).not.toHaveBeenCalled();
  });

  it('hands a report inside a zone to the cell coordinator and maps its rejection back to an error', async () => {
    const zone = { id: 'zone-1', name: 'Central', boundary: JSON.stringify({ minLatitude: -12.1, maxLatitude: -12.0, minLongitude: -77.1, maxLongitude: -77.0 }) };
    const runIntake = vi.fn()
      .mockResolvedValueOnce({ accepted: true, submissionId: 'submission-1' })
      .mockResolvedValueOnce({ rejected: { code: 'already_reported', message: 'This device already reported a cut.' }, status: 409 });
    const service = new ReportsService(fakeD1(() => [zone]).db, runIntake);

    await expect(service.accept(report)).resolves.toEqual({ submissionId: 'submission-1', accepted: true });
    expect(runIntake).toHaveBeenCalledWith('898e62c0cdbffff', expect.objectContaining({ zoneId: 'zone-1', zoneName: 'Central', h3Cell: '898e62c0cdbffff' }));
    await expect(service.accept(report)).rejects.toMatchObject({ status: 409, body: { code: 'already_reported' } });
  });
});
