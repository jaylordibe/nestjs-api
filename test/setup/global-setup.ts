import { execSync } from 'child_process';
import { resolve } from 'path';
import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';
import { Client } from 'pg';

export default async function globalSetup(): Promise<void> {
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

  const adminUrl = dbUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }

  execSync('prisma migrate deploy', {
    stdio: 'inherit',
    env: process.env,
  });
}
