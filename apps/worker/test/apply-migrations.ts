import { applyD1Migrations, type D1Migration } from 'cloudflare:test';

import { env } from './helpers.js';

// The same files `wrangler d1 migrations apply` uses, so the tests run on the production schema and zones.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS as D1Migration[]);
