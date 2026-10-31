import { describe, expect, it } from 'vitest';

import { isMigrationDirectoryName } from './migration-name.js';

describe('isMigrationDirectoryName', () => {
  it('accepts Prisma migration directories whose descriptive name contains underscores', () => {
    expect(isMigrationDirectoryName('20260830190000_data_privacy')).toBe(true);
  });

  it('rejects files and directories without a timestamped migration name', () => {
    expect(isMigrationDirectoryName('migration.sql')).toBe(false);
    expect(isMigrationDirectoryName('data_privacy')).toBe(false);
  });
});
