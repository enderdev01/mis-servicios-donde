/**
 * Every timestamp in the database is ISO-8601 UTC with milliseconds and `Z`: exactly what these
 * expressions and `new Date().toISOString()` produce, so text comparison is chronological.
 */
const isoFormat = '%Y-%m-%dT%H:%M:%fZ';

export const nowSql = `strftime('${isoFormat}', 'now')`;

/** SQL for "now plus/minus an interval", e.g. `offsetSql('+6 hours')` or `offsetSql('-60 minutes')`. */
export function offsetSql(modifier: string): string {
  return `strftime('${isoFormat}', 'now', '${modifier}')`;
}

export async function selectRows<R>(db: D1Database, sql: string, values: unknown[] = []): Promise<R[]> {
  return (await db.prepare(sql).bind(...values).all<R>()).results;
}
