import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// One command, two projects: `unit` fakes the database in Node, `d1` runs against a real D1 inside workerd.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', environment: 'node', include: ['src/**/*.spec.ts'] } },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              // The workerd bundled with the pool is older than wrangler's, and rejects a newer date than it knows.
              compatibilityDate: '2026-08-22',
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations('./migrations'),
                INTAKE_ENABLED: 'true',
                RETENTION_WORKER_ENABLED: 'true',
                DEVICE_TOKEN_SECRET: 'test-device-secret',
              },
            },
          })),
        ],
        test: { name: 'd1', include: ['test/**/*.test.ts'], setupFiles: ['./test/apply-migrations.ts'] },
      },
    ],
  },
});
