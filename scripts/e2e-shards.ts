import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Splits the e2e spec files across CI shards by how long each one took on the
// last recorded run, and picks the shard count from a time budget.
//
// Jest's own `--shard` deals files out without regard to duration, so one
// shard could collect the slowest specs and run past the job's timeout while
// another finished in a third of the time, and a fixed shard count needed a
// failed run before anyone added one. Here the count grows with the suite and
// the slow specs are spread evenly.
//
// Node runs this file directly (its type stripping), so the planning job needs
// no `yarn install`: only `node:` imports and type syntax Node can erase.
// `.github/scripts/e2e-shards.mjs` is the command line the workflow calls.

/** Seconds of Jest time one shard is planned to hold. About 8 minutes, so a
 * shard plus its ~3 minutes of setup lands near 11 minutes, well inside the
 * job's 15-minute timeout. */
export const SHARD_BUDGET_SECONDS = 480;

/** The most shards one run may use. Every shard occupies a runner at the same
 * time as the run's other jobs, and a second deploy can be running too. If the
 * budget ever needs more, the plan says so in a warning. */
export const MAX_SHARDS = 10;

/** Seconds per byte of spec source, used to estimate every spec only when no
 * timings exist at all (the first run, or an evicted cache). Measured on a
 * project grown from this template: 2,648 s of Jest time over 2,591,879 bytes
 * of spec source. Once any spec has a recorded time, the ratio is recomputed
 * from the recorded specs instead. */
export const FALLBACK_SECONDS_PER_BYTE = 0.001;

/** A spec path the workflow passes to Jest through an unquoted shell variable,
 * so it must hold nothing the shell would split or expand. */
const SAFE_SPEC_PATH = /^[A-Za-z0-9._/-]+$/;

export interface SpecFile {
  /** Repository-relative, forward slashes: `test/bookings.e2e-spec.ts`. */
  readonly path: string;
  readonly sizeBytes: number;
}

export interface SpecTimings {
  readonly version: 1;
  /** Seconds the spec file took on the last run that measured it. */
  readonly seconds: Readonly<Record<string, number>>;
}

export interface Shard {
  /** 1-based, as the job name shows it. */
  readonly shard: number;
  readonly files: readonly string[];
  readonly estimatedSeconds: number;
}

export interface ShardPlan {
  readonly shards: readonly Shard[];
  readonly totalEstimatedSeconds: number;
  /** Specs with no recorded time, whose time was estimated from their size. */
  readonly estimatedFromSize: readonly string[];
  /** Plain-language problems worth a warning on the run. */
  readonly warnings: readonly string[];
}

export interface PlanOptions {
  readonly budgetSeconds: number;
  readonly maxShards: number;
}

interface JestConfiguration {
  readonly rootDir?: string;
  readonly testRegex?: string | readonly string[];
  readonly [key: string]: unknown;
}

/** Keys that change which files Jest picks up. Discovery below implements
 * only `rootDir` + `testRegex`; any of these appearing in the config would make
 * it disagree with Jest, so it refuses instead. */
const UNSUPPORTED_DISCOVERY_KEYS = [
  'roots',
  'testMatch',
  'testPathIgnorePatterns',
  'modulePathIgnorePatterns',
] as const;

/** Lists the spec files Jest would run for this config, the way Jest finds
 * them: every file under `rootDir` (skipping node_modules) whose absolute path
 * matches `testRegex`. */
export function discoverSpecs(
  configPath: string,
  repositoryRoot: string,
): SpecFile[] {
  const configuration = JSON.parse(
    readFileSync(configPath, 'utf8'),
  ) as JestConfiguration;
  for (const key of UNSUPPORTED_DISCOVERY_KEYS) {
    if (key in configuration) {
      throw new Error(
        `${configPath} sets "${key}", which e2e-shards does not implement; teach discoverSpecs about it`,
      );
    }
  }
  const patterns = [configuration.testRegex ?? []]
    .flat()
    .map((pattern) => new RegExp(pattern));
  if (patterns.length === 0) {
    throw new Error(`${configPath} sets no testRegex`);
  }
  const searchRoot = resolve(dirname(configPath), configuration.rootDir ?? '.');

  const specs: SpecFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') {
          visit(absolutePath);
        }
      } else if (
        entry.isFile() &&
        patterns.some((pattern) => pattern.test(absolutePath))
      ) {
        specs.push({
          path: toRepositoryPath(absolutePath, repositoryRoot),
          sizeBytes: statSync(absolutePath).size,
        });
      }
    }
  };
  visit(searchRoot);

  for (const spec of specs) {
    if (!SAFE_SPEC_PATH.test(spec.path)) {
      throw new Error(
        `Spec path "${spec.path}" holds a character the workflow cannot pass safely; rename the file`,
      );
    }
  }
  return specs.sort((left, right) => left.path.localeCompare(right.path));
}

/** Reads a timings file, treating a missing or unreadable one as no timings:
 * a lost cache must never stop a test run. */
export function readTimings(timingsPath: string): SpecTimings {
  try {
    const parsed = JSON.parse(
      readFileSync(timingsPath, 'utf8'),
    ) as Partial<SpecTimings>;
    if (parsed.version === 1 && typeof parsed.seconds === 'object') {
      return { version: 1, seconds: parsed.seconds ?? {} };
    }
  } catch {
    // Falls through to empty timings.
  }
  return { version: 1, seconds: {} };
}

/** Spreads the specs over as few shards as keep each within the budget:
 * longest first, each onto the shard holding the least work so far. Every
 * spec lands on exactly one shard, and the same inputs give the same plan. */
export function planShards(
  specs: readonly SpecFile[],
  timings: SpecTimings,
  options: PlanOptions,
): ShardPlan {
  const secondsPerByte = measuredSecondsPerByte(specs, timings);
  const estimatedFromSize: string[] = [];
  const estimates = specs.map((spec) => {
    const recorded = timings.seconds[spec.path];
    if (recorded === undefined) {
      estimatedFromSize.push(spec.path);
      return { path: spec.path, seconds: spec.sizeBytes * secondsPerByte };
    }
    return { path: spec.path, seconds: recorded };
  });

  const totalEstimatedSeconds = estimates.reduce(
    (sum, estimate) => sum + estimate.seconds,
    0,
  );
  const shardCount = Math.min(
    options.maxShards,
    Math.max(1, Math.ceil(totalEstimatedSeconds / options.budgetSeconds)),
  );

  const loads = Array.from({ length: shardCount }, () => ({
    files: [] as string[],
    seconds: 0,
  }));
  const longestFirst = [...estimates].sort(
    (left, right) =>
      right.seconds - left.seconds || left.path.localeCompare(right.path),
  );
  for (const estimate of longestFirst) {
    // The first shard among equals, so the plan never depends on sort order.
    const lightest = loads.reduce((least, load) =>
      load.seconds < least.seconds ? load : least,
    );
    lightest.files.push(estimate.path);
    lightest.seconds += estimate.seconds;
  }

  const warnings: string[] = [];
  const heaviest = Math.max(...loads.map((load) => load.seconds));
  if (heaviest > options.budgetSeconds && shardCount === options.maxShards) {
    warnings.push(
      `The suite needs more than ${options.maxShards} shards to keep each within ${options.budgetSeconds} s; the heaviest holds ${Math.round(heaviest)} s. Raise MAX_SHARDS in scripts/e2e-shards.ts or speed up the slowest specs.`,
    );
  }
  for (const estimate of longestFirst) {
    if (estimate.seconds > options.budgetSeconds) {
      warnings.push(
        `${estimate.path} alone takes ${Math.round(estimate.seconds)} s, more than a shard's ${options.budgetSeconds} s budget; split it.`,
      );
    }
  }

  return {
    shards: loads
      .filter((load) => load.files.length > 0)
      .map((load, index) => ({
        shard: index + 1,
        files: [...load.files].sort((left, right) => left.localeCompare(right)),
        estimatedSeconds: Math.round(load.seconds),
      })),
    totalEstimatedSeconds: Math.round(totalEstimatedSeconds),
    estimatedFromSize,
    warnings,
  };
}

interface JestFileResult {
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
}

/** Builds the next timings file: this run's measurement for every spec it ran,
 * the previous time for a spec it did not (a shard that timed out writes no
 * results), and nothing for a spec that no longer exists. */
export function recordTimings(
  previous: SpecTimings,
  jestResultFiles: readonly string[],
  specs: readonly SpecFile[],
  repositoryRoot: string,
): SpecTimings {
  const measured = new Map<string, number>();
  for (const resultFile of jestResultFiles) {
    const results = JSON.parse(readFileSync(resultFile, 'utf8')) as {
      readonly testResults?: readonly JestFileResult[];
    };
    for (const fileResult of results.testResults ?? []) {
      const durationMilliseconds = fileResult.endTime - fileResult.startTime;
      if (Number.isFinite(durationMilliseconds) && durationMilliseconds >= 0) {
        measured.set(
          toRepositoryPath(fileResult.name, repositoryRoot),
          Math.round(durationMilliseconds / 100) / 10,
        );
      }
    }
  }

  const seconds: Record<string, number> = {};
  for (const spec of specs) {
    const time = measured.get(spec.path) ?? previous.seconds[spec.path];
    if (time !== undefined) {
      seconds[spec.path] = time;
    }
  }
  return { version: 1, seconds };
}

function measuredSecondsPerByte(
  specs: readonly SpecFile[],
  timings: SpecTimings,
): number {
  let recordedSeconds = 0;
  let recordedBytes = 0;
  for (const spec of specs) {
    const recorded = timings.seconds[spec.path];
    if (recorded !== undefined) {
      recordedSeconds += recorded;
      recordedBytes += spec.sizeBytes;
    }
  }
  return recordedBytes > 0 && recordedSeconds > 0
    ? recordedSeconds / recordedBytes
    : FALLBACK_SECONDS_PER_BYTE;
}

function toRepositoryPath(
  absolutePath: string,
  repositoryRoot: string,
): string {
  return relative(repositoryRoot, absolutePath).split(sep).join('/');
}
