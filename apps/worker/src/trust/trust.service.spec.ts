import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  assessSubmissionEligibility,
  canonicalSubmissionHash,
  createVersionedDeviceToken,
  issueDeviceId,
  limiterName,
  verifyDeviceId,
  sanitizeDisplayName,
  toPublicTrustOutcome,
} from './trust.service.js';

describe('trust controls', () => {
  it('derives a versioned device pseudonym and a post-H3 canonical hash', () => {
    expect(createVersionedDeviceToken('device-1', 'secret', 'v1')).toBe(
      'v1:08e3223c1e11ebacaf7dde2ecf4b067459712f189dc9ce7ff1e1fa6bc1277fc7',
    );
    expect(createVersionedDeviceToken('device-1', 'secret', 'v2')).not.toBe(
      createVersionedDeviceToken('device-1', 'secret', 'v1'),
    );
    expect(canonicalSubmissionHash({ h3Cell: '8a2a1072b59ffff', services: ['internet', 'water'], status: 'outage' }, 'secret')).toBe(
      canonicalSubmissionHash({ h3Cell: '8a2a1072b59ffff', services: ['water', 'internet'], status: 'outage' }, 'secret'),
    );
  });

  it('keys the request hash and the limiter name with the secret, under different labels', () => {
    const input = { h3Cell: '8a2a1072b59ffff', services: ['water:sedapal'], status: 'outage' };
    const unkeyed = createHash('sha256').update(JSON.stringify(input)).digest('hex');

    expect(canonicalSubmissionHash(input, 'one')).not.toBe(canonicalSubmissionHash(input, 'two'));
    expect(canonicalSubmissionHash(input, 'one')).not.toBe(unkeyed);
    expect(() => canonicalSubmissionHash(input, '')).toThrow();

    const oldName = createHash('sha256').update('report-ip-limit:203.0.113.7').digest('hex');
    expect(limiterName('report-ip', '203.0.113.7', 'one')).not.toBe(limiterName('report-ip', '203.0.113.7', 'two'));
    expect(limiterName('report-ip', '203.0.113.7', 'one')).not.toBe(oldName);
    expect(limiterName('report-ip', 'x', 'one')).not.toBe(limiterName('device-issue', 'x', 'one'));
    expect(() => limiterName('report-ip', 'x', '')).toThrow();
  });

  it('issues a signed device id that only the same secret verifies', () => {
    const issued = issueDeviceId('secret');
    const [id] = issued.split('.');

    expect(verifyDeviceId(issued, 'secret')).toBe(id);
    expect(issueDeviceId('secret')).not.toBe(issued);
    expect(verifyDeviceId(issued, 'other-secret')).toBeUndefined();
    expect(verifyDeviceId(issued, '')).toBeUndefined();
  });

  it('rejects bare, tampered, truncated and non-string device ids', () => {
    const issued = issueDeviceId('secret');
    const [id, signature] = issued.split('.');

    for (const bad of [id, `${id}.`, `.${signature}`, `other.${signature}`, `${id}.${signature?.slice(1)}`, `${issued}0`, '', 42, undefined, null]) {
      expect(verifyDeviceId(bad, 'secret')).toBeUndefined();
    }
  });

  it('sanitizes optional names and excludes a fourth hourly submission without disclosing why', () => {
    expect(sanitizeDisplayName('  Ana <script>  ')).toBe('Ana script');
    expect(sanitizeDisplayName('<>')).toBeUndefined();
    const now = new Date('2026-08-30T18:00:00.000Z');
    const result = assessSubmissionEligibility({
      submittedAt: now,
      priorSubmissionTimes: [
        new Date('2026-08-30T17:05:00.000Z'),
        new Date('2026-08-30T17:20:00.000Z'),
        new Date('2026-08-30T17:50:00.000Z'),
      ],
    });
    expect(result).toEqual({ eligible: false, internalReason: 'rate_limit' });
    expect(toPublicTrustOutcome(result)).toEqual({ accepted: true });
  });

});
