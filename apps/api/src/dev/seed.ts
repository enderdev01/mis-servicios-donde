import { readdir, readFile } from 'node:fs/promises';

import pg from 'pg';

import { pilotZoneSeeds } from './pilot-zones.js';

/**
 * Development data, reproducible on demand.
 *
 * The pilot publishes only with two or more approved zones, and a zone
 * without a real bounding box matches no report, so a half-seeded database looks
 * exactly like a broken one. Running this is the difference.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://mis_servicios:mis_servicios@127.0.0.1:54329/mis_servicios';

if (databaseUrl.endsWith('_test')) {
  throw new Error('Refusing to seed the integration test database. Point DATABASE_URL at the development database.');
}

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const existing = await pool.query<{ count: string }>(
    `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'PilotZone'`,
  );

  if (Number(existing.rows[0]?.count ?? 0) === 0) {
    const directory = new URL('../../prisma/migrations/', import.meta.url);
    for (const entry of (await readdir(directory)).sort()) {
      await pool.query(await readFile(new URL(`${entry}/migration.sql`, directory), 'utf8'));
    }
    console.log(`applied migrations`);
  }

  for (const zone of pilotZoneSeeds) {
    await pool.query(
      `INSERT INTO "PilotZone" ("slug", "name", "approved", "boundary") VALUES ($1, $2, true, $3::jsonb)
       ON CONFLICT ("slug") DO UPDATE SET "name" = EXCLUDED."name", "approved" = true, "boundary" = EXCLUDED."boundary"`,
      [zone.slug, zone.name, JSON.stringify(zone.boundary)],
    );
  }

  const approved = await pool.query<{ slug: string }>('SELECT "slug" FROM "PilotZone" WHERE "approved" = true ORDER BY "slug"');
  console.log(`approved zones: ${approved.rows.map((row) => row.slug).join(', ')}`);

  // A misconfigured pilot answers every report with the same generic 400, by
  // design: the API must never tell a caller which check it failed. That leaves
  // the operator with nothing to go on, so the diagnosis belongs here instead.
  const resolution = process.env.H3_RESOLUTION?.trim() ?? '';
  const blockers = [
    (approved.rowCount ?? 0) >= 2 ? undefined
      : `the public map publishes only with two or more approved zones; this database has ${approved.rowCount ?? 0}`,
    process.env.INTAKE_ENABLED === 'true' ? undefined
      : `INTAKE_ENABLED is ${JSON.stringify(process.env.INTAKE_ENABLED ?? null)}; POST /v1/reports refuses every report unless it is exactly "true"`,
    process.env.PUBLIC_MAP_ENABLED === 'true' ? undefined
      : `PUBLIC_MAP_ENABLED is ${JSON.stringify(process.env.PUBLIC_MAP_ENABLED ?? null)}; GET /v1/cells answers an empty list unless it is exactly "true"`,
    /^\d+$/.test(resolution) && Number(resolution) <= 15 ? undefined
      : `H3_RESOLUTION is ${JSON.stringify(process.env.H3_RESOLUTION ?? null)}; it must be an integer from 0 through 15`,
    process.env.DEVICE_TOKEN_SECRET?.trim() ? undefined
      : 'DEVICE_TOKEN_SECRET is empty; intake refuses every report rather than derive pseudonyms from a shared default',
  ].filter((blocker): blocker is string => blocker !== undefined);

  if (blockers.length === 0) {
    console.log('configuration: ready — intake accepts reports and the map publishes');
  } else {
    console.warn(`\nconfiguration: ${blockers.length} blocker(s). Reports will be refused with a generic error until these are fixed:`);
    for (const blocker of blockers) console.warn(`  - ${blocker}`);
    console.warn('\nEdit .env, then run this command again.');
  }
} finally {
  await pool.end();
}
