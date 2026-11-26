import { vi } from 'vitest';

/** A D1 stand-in for unit specs: every statement answers `rows(sql)`, so a spec can match on the SQL text. */
export function fakeD1(rows: (sql: string) => unknown[] = () => []) {
  const sqls: string[] = [];
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    const statement = {
      bind: () => statement,
      all: () => Promise.resolve({ results: rows(sql) }),
      run: () => Promise.resolve({ meta: { changes: 0 } }),
    };
    return statement;
  });
  return { db: { prepare } as unknown as D1Database, prepare, sqls };
}
