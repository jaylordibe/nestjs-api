// Per-worker isolation for the e2e suite.
//
// The suite used to be pinned to `maxWorkers: 1`, because every spec shared
// ONE database: two workers running concurrently would have truncated each
// other's rows mid-test. That made the wall-clock the sum of every spec —
// ~13 min locally, and the same serially in CI.
//
// Instead of serialising, give each worker its own state. `globalSetup`
// migrates a TEMPLATE database once and clones it per worker (`CREATE
// DATABASE … TEMPLATE …`, so migrations run exactly once no matter how many
// workers), and `load-env` repoints that worker's DATABASE_URL / REDIS_URL
// before the app boots. Workers then never touch each other's data, and
// `truncateAll` only ever wipes its own.
//
// Both halves derive their names from these helpers so the writer
// (globalSetup) and the reader (load-env) can never disagree about where a
// worker's data lives.

// Redis ships 16 logical databases (0-15) and `truncateAll` refuses to flush
// index 0 — that one belongs to local dev. Worker N takes index N, so 15 is
// the ceiling. Beyond that two workers would share a keyspace and flush each
// other's keys, which is exactly the cross-talk this module exists to
// prevent — so `globalSetup` fails loudly rather than silently colliding.
export const MAX_PARALLEL_WORKERS = 15;

// Jest sets JEST_WORKER_ID per worker process, 1-based, and sets it even
// under `--runInBand`. Defaulting to 1 keeps any non-jest caller sane.
export function currentWorkerId(): number {
  return Number(process.env.JEST_WORKER_ID ?? '1');
}

export function workerDatabaseName(
  templateDatabaseName: string,
  workerId: number,
): string {
  return `${templateDatabaseName}_w${workerId}`;
}

// Swaps only the database name in the connection string, preserving
// credentials, host, port and query parameters (`?schema=public`).
export function workerDatabaseUrl(
  templateDatabaseUrl: string,
  workerId: number,
): string {
  const url = new URL(templateDatabaseUrl);
  const templateDatabaseName = url.pathname.slice(1);
  url.pathname = `/${workerDatabaseName(templateDatabaseName, workerId)}`;
  return url.toString();
}

// Swaps only the logical-database segment, preserving auth/host/port.
export function workerRedisUrl(baseRedisUrl: string, workerId: number): string {
  const url = new URL(baseRedisUrl);
  url.pathname = `/${workerId}`;
  return url.toString();
}
