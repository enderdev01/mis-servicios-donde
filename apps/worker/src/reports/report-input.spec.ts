import { describe, expect, it } from 'vitest';

import { ReportRequestError, validateReportInput } from './report-input.js';

describe('report intake input', () => {
  const valid = {
    submissionId: 'submitted-001',
    deviceId: 'device-001',
    services: ['water', 'internet'],
    providers: { water: 'sedapal', internet: 'win' },
    status: 'outage',
    latitude: -12.0464,
    longitude: -77.0428,
    name: ' Ana <script> ',
  };

  it('accepts one to three distinct supported services and sanitizes an optional display name', () => {
    expect(validateReportInput(valid)).toEqual({ ...valid, name: 'Ana script' });
    expect(validateReportInput({ ...valid, services: ['electricity'], providers: { electricity: 'pluz' } }).services).toEqual(['electricity']);
    expect(validateReportInput({ ...valid, services: ['water', 'electricity', 'internet'], providers: { water: 'sedapal', electricity: 'luz_del_sur', internet: 'win' } }).services).toHaveLength(3);
  });

  it('rejects empty, duplicate, and unsupported service selections before any database work', () => {
    for (const services of [[], ['water', 'water'], ['water', 'gas']]) {
      expect(() => validateReportInput({ ...valid, services })).toThrow(ReportRequestError);
    }
    expect(() => validateReportInput({ ...valid, providers: { water: 'pluz', internet: 'win' } })).toThrow(ReportRequestError);
    expect(() => validateReportInput({ ...valid, providers: { water: 'sedapal' } })).toThrow(ReportRequestError);
  });
});
