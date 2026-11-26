import { nowSql, offsetSql } from '../database/d1.js';

export interface RetentionResult {
  displayNames: number;
  events: number;
  submissions: number;
  abuseRecords: number;
  alertIntents: number;
}

export interface PilotPurgeResult {
  displayNames: number;
  events: number;
  submissions: number;
  abuseRecords: number;
  episodes: number;
}

export class RetentionService {
  constructor(private readonly db: D1Database) {}

  /** Counts come from RETURNING: D1's `meta.changes` also counts rows removed by ON DELETE CASCADE. */
  async cleanup(): Promise<RetentionResult> {
    const [displayNames, events, submissions, abuseRecords, alertIntents] = await this.db.batch([
      deleteExpired(this.db, 'ReportDisplayName'),
      deleteExpired(this.db, 'ReportEvent'),
      deleteExpired(this.db, 'SubmissionRecord'),
      deleteExpired(this.db, 'AbuseRecord'),
      this.db.prepare(`DELETE FROM "AlertIntent" WHERE "createdAt" <= ${offsetSql('-30 days')} RETURNING 1`),
    ]);
    return { displayNames: deleted(displayNames), events: deleted(events), submissions: deleted(submissions), abuseRecords: deleted(abuseRecords), alertIntents: deleted(alertIntents) };
  }

  async purgePilotData(): Promise<PilotPurgeResult> {
    const [displayNames, events, submissions, abuseRecords, episodes] = await this.db.batch(
      ['ReportDisplayName', 'ReportEvent', 'SubmissionRecord', 'AbuseRecord', 'OutageEpisode'].map((table) => this.db.prepare(`DELETE FROM "${table}" RETURNING 1`)),
    );
    return { displayNames: deleted(displayNames), events: deleted(events), submissions: deleted(submissions), abuseRecords: deleted(abuseRecords), episodes: deleted(episodes) };
  }
}

function deleted(result: D1Result | undefined): number {
  return result?.results.length ?? 0;
}

export const retentionIntervalMs = 24 * 60 * 60 * 1000;

const limaTimeZone = 'America/Lima';

export function millisecondsUntilNextLimaMidnight(now: Date = new Date()): number {
  if (Number.isNaN(now.getTime())) throw new RangeError('Cannot calculate retention schedule from an invalid date.');

  const limaDate = dateParts(now);
  const nextMidnightDate = Date.UTC(limaDate.year, limaDate.month - 1, limaDate.day + 1);
  const offsetAtNextMidnight = timeZoneOffsetMs(new Date(nextMidnightDate + 12 * 60 * 60 * 1000), limaTimeZone);
  const nextMidnight = nextMidnightDate - offsetAtNextMidnight;
  return nextMidnight - now.getTime();
}

function dateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: limaTimeZone,
    calendar: 'iso8601',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return { year: numericPart(parts, 'year'), month: numericPart(parts, 'month'), day: numericPart(parts, 'day') };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'iso8601',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const asUtc = Date.UTC(
    numericPart(parts, 'year'),
    numericPart(parts, 'month') - 1,
    numericPart(parts, 'day'),
    numericPart(parts, 'hour'),
    numericPart(parts, 'minute'),
    numericPart(parts, 'second'),
  );
  return asUtc - date.getTime();
}

function numericPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) throw new Error(`Missing ${type} from Lima time-zone calculation.`);
  return Number(value);
}

function deleteExpired(db: D1Database, table: 'ReportDisplayName' | 'ReportEvent' | 'SubmissionRecord' | 'AbuseRecord'): D1PreparedStatement {
  return db.prepare(`DELETE FROM "${table}" WHERE "expiresAt" <= ${nowSql} RETURNING 1`);
}
