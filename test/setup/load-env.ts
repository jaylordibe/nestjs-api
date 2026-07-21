import { resolve } from 'path';
import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';
import {
  currentWorkerId,
  workerDatabaseUrl,
  workerRedisUrl,
} from './worker-isolation';

const result = dotenv.config({
  path: resolve(__dirname, '../../.env.test'),
});
expand(result);

// Repoint THIS worker at its own database + Redis logical database, both
// provisioned by globalSetup. Runs as a jest `setupFiles` entry, i.e. before
// the spec file is imported and long before `createTestApp()` builds the
// ConfigModule — which reads these two variables once, at app-init time.
//
// Deliberately overwrites rather than defers to an existing value: unlike
// the dotenv load above (which never overrides), the worker suffix MUST win,
// or every worker would share one database and truncate the others' rows.
const workerId = currentWorkerId();
if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = workerDatabaseUrl(
    process.env.DATABASE_URL,
    workerId,
  );
}
if (process.env.REDIS_URL) {
  process.env.REDIS_URL = workerRedisUrl(process.env.REDIS_URL, workerId);
}
