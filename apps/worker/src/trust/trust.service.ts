import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface EligibilityInput {
  submittedAt: Date;
  priorSubmissionTimes: Date[];
}

export interface EligibilityResult {
  eligible: boolean;
  internalReason?: 'rate_limit';
}

export function createVersionedDeviceToken(deviceId: string, secret: string, version: string): string {
  return `${version}:${createHmac('sha256', secret).update(deviceId).digest('hex')}`;
}

// shortcut: signed device ids never expire or rotate; add a version prefix to the id if DEVICE_TOKEN_SECRET must rotate.
export function signDeviceId(id: string, secret: string): string {
  return `${id}.${createHmac('sha256', secret).update(`device:${id}`).digest('hex')}`;
}

/** A server-issued device id: `<uuid>.<hmac>`, so a browser cannot invent or rotate its own. */
export function issueDeviceId(secret: string): string {
  return signDeviceId(randomUUID(), secret);
}

/** Returns the id part when the signature is genuine, otherwise undefined. */
export function verifyDeviceId(value: unknown, secret: string): string | undefined {
  if (typeof value !== 'string' || !secret) return undefined;
  const separator = value.lastIndexOf('.');
  const id = value.slice(0, separator);
  if (separator < 1) return undefined;
  const expected = Buffer.from(signDeviceId(id, secret));
  const given = Buffer.from(value);
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : undefined;
}

/** HMAC under its own label (`request:`, apart from `device:` and `limit:`); an unkeyed digest of a small input space can be enumerated. */
export function canonicalSubmissionHash(
  input: { h3Cell: string; services: string[]; status: string },
  secret: string,
): string {
  if (!secret) throw new Error('A secret is required to hash a submission.');
  return createHmac('sha256', secret)
    .update(`request:${JSON.stringify({ ...input, services: [...input.services].sort() })}`)
    .digest('hex');
}

/** Name of a limiter Durable Object: keyed so a client IP cannot be recovered from the name by enumerating IPv4. */
export function limiterName(kind: string, key: string, secret: string): string {
  if (!secret) throw new Error('A secret is required to name a limiter.');
  return createHmac('sha256', secret).update(`limit:${kind}:${key}`).digest('hex');
}

export function sanitizeDisplayName(value?: string): string | undefined {
  const sanitized = value?.replace(/[^\p{L}\p{N}' -]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 80);
  return sanitized || undefined;
}

export const submissionRateWindowHours = 1;
export const submissionRateLimitPerWindow = 1;

export function assessSubmissionEligibility(input: EligibilityInput): EligibilityResult {
  const windowStart = input.submittedAt.getTime() - submissionRateWindowHours * 60 * 60 * 1000;
  const recentCount = input.priorSubmissionTimes.filter((time) => time.getTime() > windowStart).length;
  return recentCount >= submissionRateLimitPerWindow ? { eligible: false, internalReason: 'rate_limit' } : { eligible: true };
}

export function toPublicTrustOutcome(result: EligibilityResult): { accepted: true } {
  void result;
  return { accepted: true };
}
