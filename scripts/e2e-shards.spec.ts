import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import {
  FALLBACK_SECONDS_PER_BYTE,
  type SpecFile,
  type SpecTimings,
  discoverSpecs,
  planShards,
  readTimings,
  recordTimings,
} from './e2e-shards';

const repositoryRoot = resolve(__dirname, '..');
const options = { budgetSeconds: 100, maxShards: 4 };

function spec(path: string, sizeBytes = 1000): SpecFile {
  return { path, sizeBytes };
}

function timings(seconds: Record<string, number>): SpecTimings {
  return { version: 1, seconds };
}

function allFiles(plan: ReturnType<typeof planShards>): string[] {
  return plan.shards.flatMap((shard) => shard.files).sort();
}

describe('e2e shard planner', () => {
  describe('planShards', () => {
    it('places every spec on exactly one shard', () => {
      const specs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) =>
        spec(`test/${name}.e2e-spec.ts`),
      );
      const plan = planShards(
        specs,
        timings(
          Object.fromEntries(
            specs.map((file, index) => [file.path, (index + 1) * 10]),
          ),
        ),
        options,
      );

      expect(allFiles(plan)).toEqual(specs.map((file) => file.path));
    });

    it('uses as many shards as the budget needs', () => {
      const specs = ['a', 'b', 'c', 'd', 'e'].map((name) =>
        spec(`test/${name}.e2e-spec.ts`),
      );
      // 250 s against a 100 s budget: three shards.
      const plan = planShards(
        specs,
        timings({
          'test/a.e2e-spec.ts': 90,
          'test/b.e2e-spec.ts': 80,
          'test/c.e2e-spec.ts': 40,
          'test/d.e2e-spec.ts': 30,
          'test/e.e2e-spec.ts': 10,
        }),
        options,
      );

      expect(plan.totalEstimatedSeconds).toBe(250);
      expect(plan.shards.map((shard) => shard.estimatedSeconds)).toEqual([
        90, 80, 80,
      ]);
      expect(plan.warnings).toEqual([]);
    });

    it('balances by time, not by file count', () => {
      // `--shard` would put two files on each shard whatever they cost.
      const plan = planShards(
        [
          spec('test/slow.e2e-spec.ts'),
          spec('test/quick-1.e2e-spec.ts'),
          spec('test/quick-2.e2e-spec.ts'),
          spec('test/quick-3.e2e-spec.ts'),
        ],
        timings({
          'test/slow.e2e-spec.ts': 90,
          'test/quick-1.e2e-spec.ts': 30,
          'test/quick-2.e2e-spec.ts': 30,
          'test/quick-3.e2e-spec.ts': 30,
        }),
        options,
      );

      expect(plan.shards).toEqual([
        { shard: 1, files: ['test/slow.e2e-spec.ts'], estimatedSeconds: 90 },
        {
          shard: 2,
          files: [
            'test/quick-1.e2e-spec.ts',
            'test/quick-2.e2e-spec.ts',
            'test/quick-3.e2e-spec.ts',
          ],
          estimatedSeconds: 90,
        },
      ]);
    });

    it('gives the same plan whatever order the specs arrive in', () => {
      const specs = ['a', 'b', 'c', 'd'].map((name) =>
        spec(`test/${name}.e2e-spec.ts`),
      );
      const recorded = timings({
        'test/a.e2e-spec.ts': 50,
        'test/b.e2e-spec.ts': 50,
        'test/c.e2e-spec.ts': 50,
        'test/d.e2e-spec.ts': 50,
      });

      expect(planShards([...specs].reverse(), recorded, options)).toEqual(
        planShards(specs, recorded, options),
      );
    });

    it('estimates a spec with no recorded time from its size, at the rate the recorded specs ran', () => {
      const plan = planShards(
        [
          spec('test/known.e2e-spec.ts', 1000),
          spec('test/new.e2e-spec.ts', 3000),
        ],
        // 0.02 s per byte.
        timings({ 'test/known.e2e-spec.ts': 20 }),
        options,
      );

      expect(plan.estimatedFromSize).toEqual(['test/new.e2e-spec.ts']);
      expect(plan.totalEstimatedSeconds).toBe(80);
    });

    it('falls back to the measured default rate when no timings exist', () => {
      const plan = planShards(
        [spec('test/a.e2e-spec.ts', 50_000)],
        timings({}),
        options,
      );

      expect(plan.totalEstimatedSeconds).toBe(
        Math.round(50_000 * FALLBACK_SECONDS_PER_BYTE),
      );
      expect(plan.shards).toHaveLength(1);
    });

    it('stops at the shard cap and warns instead of failing the run', () => {
      const specs = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) =>
        spec(`test/${name}.e2e-spec.ts`),
      );
      const plan = planShards(
        specs,
        timings(Object.fromEntries(specs.map((file) => [file.path, 90]))),
        options,
      );

      expect(plan.shards).toHaveLength(options.maxShards);
      expect(allFiles(plan)).toHaveLength(specs.length);
      expect(plan.warnings).toEqual([
        expect.stringContaining('more than 4 shards'),
      ]);
    });

    it('warns about a single spec longer than the budget', () => {
      const plan = planShards(
        [spec('test/huge.e2e-spec.ts')],
        timings({ 'test/huge.e2e-spec.ts': 150 }),
        options,
      );

      expect(plan.warnings).toEqual([
        expect.stringContaining('test/huge.e2e-spec.ts alone takes 150 s'),
      ]);
    });
  });

  describe('recordTimings', () => {
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'e2e-shards-'));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    function writeJestResults(
      name: string,
      files: Record<string, number>,
    ): string {
      const resultPath = join(directory, name);
      writeFileSync(
        resultPath,
        JSON.stringify({
          testResults: Object.entries(files).map(([path, seconds]) => ({
            name: join(repositoryRoot, path),
            startTime: 1_000_000,
            endTime: 1_000_000 + seconds * 1000,
          })),
        }),
      );
      return resultPath;
    }

    it('takes this run’s times, keeps the previous time for a spec that did not run, and drops a deleted spec', () => {
      const next = recordTimings(
        timings({
          'test/ran.e2e-spec.ts': 10,
          'test/did-not-run.e2e-spec.ts': 20,
          'test/deleted.e2e-spec.ts': 30,
        }),
        [
          writeJestResults('shard-1.json', { 'test/ran.e2e-spec.ts': 12.34 }),
          writeJestResults('shard-2.json', { 'test/new.e2e-spec.ts': 5 }),
        ],
        [
          spec('test/ran.e2e-spec.ts'),
          spec('test/did-not-run.e2e-spec.ts'),
          spec('test/new.e2e-spec.ts'),
        ],
        repositoryRoot,
      );

      expect(next).toEqual(
        timings({
          'test/ran.e2e-spec.ts': 12.3,
          'test/did-not-run.e2e-spec.ts': 20,
          'test/new.e2e-spec.ts': 5,
        }),
      );
    });

    it('reads a missing or malformed timings file as no timings', () => {
      const malformed = join(directory, 'timings.json');
      writeFileSync(malformed, '{ not json');

      expect(readTimings(join(directory, 'absent.json'))).toEqual(timings({}));
      expect(readTimings(malformed)).toEqual(timings({}));
    });
  });

  describe('discoverSpecs', () => {
    // The planner finds specs itself so the planning job needs no install.
    // This pins it to Jest's own discovery: a spec Jest would run but the
    // plan missed would never run in CI at all.
    it('finds exactly the files Jest runs for test/jest-e2e.json', () => {
      const jestListing = execFileSync(
        process.execPath,
        [
          join(repositoryRoot, 'node_modules/jest/bin/jest.js'),
          '--config',
          'test/jest-e2e.json',
          '--listTests',
        ],
        { cwd: repositoryRoot, encoding: 'utf8' },
      );
      const jestPaths = jestListing
        .trim()
        .split('\n')
        .map((absolutePath) =>
          relative(repositoryRoot, absolutePath).split(sep).join('/'),
        )
        .sort();

      const discovered = discoverSpecs(
        join(repositoryRoot, 'test/jest-e2e.json'),
        repositoryRoot,
      );

      expect(discovered.map((file) => file.path)).toEqual(jestPaths);
      expect(discovered.every((file) => file.sizeBytes > 0)).toBe(true);
    }, 60_000);

    it('refuses a Jest config key it does not implement', () => {
      const directory = mkdtempSync(join(tmpdir(), 'e2e-shards-'));
      try {
        const configPath = join(directory, 'jest.json');
        writeFileSync(
          configPath,
          JSON.stringify({ testRegex: '.e2e-spec.ts$', testMatch: ['**/*'] }),
        );

        expect(() => discoverSpecs(configPath, directory)).toThrow(
          /sets "testMatch"/,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
