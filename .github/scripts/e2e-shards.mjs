// Command line for the e2e shard planner. The logic, its reasoning and its
// unit spec live in scripts/e2e-shards.ts; this file only wires files and
// GitHub's step outputs to it. Node 24 imports the .ts file directly.
//
//   node .github/scripts/e2e-shards.mjs plan --timings <file>
//     Writes `matrix` (the e2e job's strategy matrix) to $GITHUB_OUTPUT and
//     a table of the plan to $GITHUB_STEP_SUMMARY.
//
//   node .github/scripts/e2e-shards.mjs record --timings <file> --results <dir>
//     Rewrites <file> with the times in every Jest `--json` file in <dir>.

import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  MAX_SHARDS,
  SHARD_BUDGET_SECONDS,
  discoverSpecs,
  planShards,
  readTimings,
  recordTimings,
} from '../../scripts/e2e-shards.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const configPath = join(repositoryRoot, 'test/jest-e2e.json');

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    timings: { type: 'string' },
    results: { type: 'string' },
  },
});
const [command] = positionals;
if (!values.timings) {
  throw new Error('--timings is required');
}
const specs = discoverSpecs(configPath, repositoryRoot);

if (command === 'plan') {
  const plan = planShards(specs, readTimings(values.timings), {
    budgetSeconds: SHARD_BUDGET_SECONDS,
    maxShards: MAX_SHARDS,
  });
  const matrix = {
    include: plan.shards.map((shard) => ({
      shard: shard.shard,
      files: shard.files.join(' '),
    })),
  };
  writeGitHubFile('GITHUB_OUTPUT', `matrix=${JSON.stringify(matrix)}\n`);
  writeGitHubFile(
    'GITHUB_STEP_SUMMARY',
    [
      `### E2E shards: ${plan.shards.length} for ${specs.length} specs, about ${plan.totalEstimatedSeconds} s of Jest time`,
      '',
      '| Shard | Specs | Planned seconds |',
      '|---|---|---|',
      ...plan.shards.map(
        (shard) =>
          `| ${shard.shard} | ${shard.files.length} | ${shard.estimatedSeconds} |`,
      ),
      '',
      plan.estimatedFromSize.length === 0
        ? 'Every spec had a recorded time.'
        : `Estimated from file size (no recorded time): ${plan.estimatedFromSize.length} specs.`,
      '',
    ].join('\n'),
  );
  for (const warning of plan.warnings) {
    console.log(`::warning title=E2E shard plan::${warning}`);
  }
  console.log(JSON.stringify(plan, null, 2));
} else if (command === 'record') {
  if (!values.results) {
    throw new Error('--results is required');
  }
  const resultFiles = readdirSync(values.results, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(values.results, name));
  const timings = recordTimings(
    readTimings(values.timings),
    resultFiles,
    specs,
    repositoryRoot,
  );
  mkdirSync(dirname(values.timings), { recursive: true });
  writeFileSync(values.timings, `${JSON.stringify(timings, null, 2)}\n`);
  console.log(
    `Recorded times for ${Object.keys(timings.seconds).length} of ${specs.length} specs from ${resultFiles.length} result files.`,
  );
} else {
  throw new Error(`Unknown command "${command}"; expected plan or record`);
}

function writeGitHubFile(variable, content) {
  const path = process.env[variable];
  if (path) {
    appendFileSync(path, content);
  } else {
    process.stdout.write(content);
  }
}
