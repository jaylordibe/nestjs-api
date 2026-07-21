import { execSync } from 'child_process';
import { resolve } from 'path';
import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';
import { Client } from 'pg';
import { MAX_PARALLEL_WORKERS, workerDatabaseName } from './worker-isolation';

// Jest hands globalSetup its resolved config; `maxWorkers` is already a
// number here even when jest-e2e.json expresses it as a percentage.
interface JestGlobalConfig {
  maxWorkers?: number;
}

export default async function globalSetup(
  globalConfig?: JestGlobalConfig,
): Promise<void> {
  const result = dotenv.config({
    path: resolve(__dirname, '../../.env.test'),
  });
  expand(result);

  const dbUrl = process.env.DATABASE_URL;
  const dbName = process.env.DB_NAME;
  if (!dbUrl || !dbName) {
    throw new Error(
      'DATABASE_URL and DB_NAME must be set before running e2e tests',
    );
  }

  const workerCount = Math.max(1, globalConfig?.maxWorkers ?? 1);
  if (workerCount > MAX_PARALLEL_WORKERS) {
    throw new Error(
      `e2e is configured for ${workerCount} workers but only ` +
        `${MAX_PARALLEL_WORKERS} can be isolated (Redis ships 16 logical ` +
        `databases and index 0 is reserved for dev). Lower maxWorkers in ` +
        `test/jest-e2e.json.`,
    );
  }

  // `dbName` is the TEMPLATE: migrated once, never connected to by a test.
  // Each worker gets a clone of it (see worker-isolation.ts).
  const workerDatabaseNames = Array.from({ length: workerCount }, (_, index) =>
    workerDatabaseName(dbName, index + 1),
  );

  const adminUrl = dbUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    // Drop the template AND every worker clone. A previous run may have left
    // clones behind (or been killed mid-run), and a stale clone would other-
    // wise be reused with an outdated schema.
    for (const databaseName of [dbName, ...workerDatabaseNames]) {
      await client.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName],
      );
      await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }

  // Migrations run ONCE, against the template — not once per worker. Cloning
  // a migrated database is a file copy inside Postgres and takes
  // milliseconds, so worker count barely affects startup cost.
  execSync('prisma migrate deploy', {
    stdio: 'inherit',
    env: process.env,
  });

  const cloneClient = new Client({ connectionString: adminUrl });
  await cloneClient.connect();
  try {
    for (const databaseName of workerDatabaseNames) {
      // CREATE DATABASE ... TEMPLATE requires the template to have no other
      // connections; `prisma migrate deploy` has exited by now, so it has
      // none.
      await cloneClient.query(
        `CREATE DATABASE "${databaseName}" TEMPLATE "${dbName}"`,
      );
    }
  } finally {
    await cloneClient.end();
  }
}
