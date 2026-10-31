import { describe, expect, it } from 'vitest';

import {
  assessSubmissionEligibility,
  canonicalSubmissionHash,
  createVersionedDeviceToken,
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
    expect(canonicalSubmissionHash({ h3Cell: '8a2a1072b59ffff', services: ['internet', 'water'], status: 'outage' })).toBe(
      canonicalSubmissionHash({ h3Cell: '8a2a1072b59ffff', services: ['water', 'internet'], status: 'outage' }),
    );
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
