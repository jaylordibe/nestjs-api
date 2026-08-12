/**
 * Asserts that `yarn build` produced an artifact the runtime can actually boot.
 *
 * `yarn build` exiting 0 does NOT mean the build is usable. Two independent
 * mechanisms decide where files land in `dist/`, and they can disagree:
 *
 *   - `tsc` places compiled code, under `rootDir` from `tsconfig.build.json`;
 *   - `nest build` copies assets, under `compilerOptions.assets` in
 *     `nest-cli.json`, whose `outDir` is a fixed literal.
 *
 * When a `.ts` file outside `src/` entered the build scope, tsc rebased its
 * inferred rootDir to the repository root. Code moved to `dist/src/**` while
 * the `.hbs` email templates stayed at `dist/common/email/templates`. The build
 * stayed green and produced two independent boot failures: `MODULE_NOT_FOUND`
 * on the entrypoint, and — behind it — `ENOENT` from the template loader, which
 * resolves its directory relative to `__dirname` and reads it without a guard
 * during `onModuleInit`. The first thing to catch it was a container
 * healthcheck, after the running container had already been stopped.
 *
 * This runs as `postbuild`, so it fires on every `yarn build`: locally, in CI,
 * and inside the Docker build stage — where failing here means the image is
 * never produced and the deploy stops before it takes the old container down.
 *
 * The pure check is exported so it can be tested against fixture directories;
 * see `verify-build-artifacts.spec.ts`. Only the CLI wrapper at the bottom
 * touches the real `dist/` or exits the process.
 *
 * If this check ever fires, the two most likely causes are a .ts file outside
 * src/ entering the build scope, and a stale incremental cache at the project
 * root. Both are explained in the failure output.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Assets must stay siblings of the compiled module that loads them, because
 * resolution is `__dirname`-relative. Checking that the asset directory exists
 * is not enough on its own: `nest-cli.json` writes assets to a FIXED literal
 * `outDir`, so the directory sits in the same place in both the healthy and the
 * broken layout. It is the compiled *loader* that moves — so the loader is
 * checked too, and the file count is compared against the source of truth
 * rather than merely being non-zero, which would pass a truncated copy.
 */
interface AssetDirectoryContract {
  readonly distributionRelativePath: string;
  readonly sourceRelativePath: string;
  readonly requiredExtension: string;
  readonly loaderDistributionRelativePath: string;
  readonly requiredBy: string;
}

const ASSET_DIRECTORY_CONTRACTS: readonly AssetDirectoryContract[] = [
  {
    distributionRelativePath: 'common/email/templates',
    sourceRelativePath: 'src/common/email/templates',
    requiredExtension: '.hbs',
    loaderDistributionRelativePath: 'common/email/template-engine.js',
    requiredBy:
      "the email template engine — `path.join(__dirname, 'templates')` in src/common/email/template-engine.ts",
  },
];

/**
 * The entrypoints the runtime resolves.
 *
 * These are declared here rather than derived from the `Dockerfile`, and that is
 * deliberate: `.dockerignore` excludes the `Dockerfile`, so when this check runs
 * as `postbuild` **inside the Docker build stage** there is no Dockerfile to
 * read. An earlier revision derived the path and consequently failed every image
 * build — caught by the local Docker verification before it shipped.
 *
 * The anti-drift property is preserved by putting the cross-file assertion where
 * it can actually run: `build-config-contract.spec.ts` asserts that the
 * `CMD` in the Dockerfile matches `CONTAINER_ENTRYPOINT_RELATIVE_PATH`, using
 * the exported parser below. A retargeted CMD therefore fails the unit suite
 * rather than silently leaving this check verifying a file nothing runs.
 */
export const CONTAINER_ENTRYPOINT_RELATIVE_PATH = 'main.js';

/**
 * The worker runtime's entrypoint. It is a first-class deployment target, not a
 * convenience script: the same image runs `dist/main.js` as the HTTP API and
 * `dist/worker.js` as the queue-consuming worker pool, so a build that produced
 * only one of the two would deploy an API with nothing behind it — and every
 * signal except the queue heartbeat would stay green.
 */
export const WORKER_ENTRYPOINT_RELATIVE_PATH = 'worker.js';

/**
 * Parses the container entrypoint out of a Dockerfile's `CMD`. Exported for the
 * config-contract spec, which uses it to assert the Dockerfile and
 * `CONTAINER_ENTRYPOINT_RELATIVE_PATH` agree.
 */
export function readContainerEntrypointFromDockerfile(
  dockerfileContents: string,
): string | null {
  const commandMatch = /^\s*CMD\s*\[\s*"node"\s*,\s*"([^"]+)"\s*\]/m.exec(
    dockerfileContents,
  );
  if (commandMatch === null) {
    return null;
  }
  return commandMatch[1].replace(/^dist\//, '');
}

function countFilesRecursively(directory: string, extension: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce(
    (runningTotal, entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return runningTotal + countFilesRecursively(entryPath, extension);
      }
      return runningTotal + (entry.name.endsWith(extension) ? 1 : 0);
    },
    0,
  );
}

function isExistingFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function isExistingDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

export interface BuildArtifactCheckInput {
  readonly distributionDirectory: string;
  readonly repositoryRoot: string;
  /** Entrypoints the runtime resolves, keyed by what requires each one. */
  readonly requiredEntrypoints: ReadonlyArray<{
    readonly relativePath: string;
    readonly requiredBy: string;
  }>;
}

/**
 * Returns one message per violation, empty when the build is sound. Pure with
 * respect to process state — it reads the filesystem but never exits, so it can
 * be driven over fixture directories from a spec.
 */
export function findBuildArtifactViolations(
  input: BuildArtifactCheckInput,
): string[] {
  const { distributionDirectory, repositoryRoot, requiredEntrypoints } = input;
  const violations: string[] = [];

  if (!isExistingDirectory(distributionDirectory)) {
    return ['dist/ does not exist. The build produced no output at all.'];
  }

  for (const { relativePath, requiredBy } of requiredEntrypoints) {
    if (!isExistingFile(join(distributionDirectory, relativePath))) {
      violations.push(
        `dist/${relativePath} is missing — required by ${requiredBy}.`,
      );
    }
  }

  for (const contract of ASSET_DIRECTORY_CONTRACTS) {
    const {
      distributionRelativePath,
      sourceRelativePath,
      requiredExtension,
      loaderDistributionRelativePath,
      requiredBy,
    } = contract;

    if (
      !isExistingFile(
        join(distributionDirectory, loaderDistributionRelativePath),
      )
    ) {
      violations.push(
        `dist/${loaderDistributionRelativePath} is missing — it loads ` +
          `dist/${distributionRelativePath}/ relative to its own directory, so the two must ` +
          'stay siblings. The compiled code has moved away from its assets.',
      );
    }

    const assetDirectory = join(
      distributionDirectory,
      distributionRelativePath,
    );
    if (!isExistingDirectory(assetDirectory)) {
      violations.push(
        `dist/${distributionRelativePath}/ is missing — required by ${requiredBy}.`,
      );
      continue;
    }

    const builtCount = countFilesRecursively(assetDirectory, requiredExtension);
    const sourceDirectory = join(repositoryRoot, sourceRelativePath);
    const sourceCount = isExistingDirectory(sourceDirectory)
      ? countFilesRecursively(sourceDirectory, requiredExtension)
      : null;

    if (builtCount === 0) {
      violations.push(
        `dist/${distributionRelativePath}/ contains no ${requiredExtension} files — required by ${requiredBy}.`,
      );
    } else if (sourceCount !== null && builtCount !== sourceCount) {
      violations.push(
        `dist/${distributionRelativePath}/ has ${builtCount} ${requiredExtension} file(s) but ` +
          `${sourceRelativePath}/ has ${sourceCount} — the asset copy is incomplete.`,
      );
    }
  }

  violations.push(...findTelemetryOrderingViolations(distributionDirectory));

  return violations;
}

/**
 * Asserts that each entrypoint starts telemetry BEFORE it requires anything
 * that OpenTelemetry needs to patch.
 *
 * Auto-instrumentation works by intercepting `require`, so a module loaded
 * before `startTelemetry()` keeps an unpatched reference and never emits spans.
 * Nothing about that failure is loud: the process boots, serves traffic, and
 * exports traces — they are simply missing every database and outbound-HTTP
 * span, which is most of what makes a trace worth reading.
 *
 * The source ordering is correct today only because `module: nodenext` emits
 * CommonJS `require` calls in statement order. Switching the build to real ESM
 * would hoist every import above the call and silently break this, with no
 * type error and no failing test — which is exactly why it is checked in the
 * artifact rather than trusted in the source.
 */
function findTelemetryOrderingViolations(
  distributionDirectory: string,
): string[] {
  const violations: string[] = [];

  for (const relativePath of [
    CONTAINER_ENTRYPOINT_RELATIVE_PATH,
    WORKER_ENTRYPOINT_RELATIVE_PATH,
  ]) {
    const entrypointPath = join(distributionDirectory, relativePath);
    if (!isExistingFile(entrypointPath)) continue; // already reported above

    const compiled = readFileSync(entrypointPath, 'utf8');
    const startCallIndex = compiled.indexOf('startTelemetry)()');
    const nestRequireIndex = compiled.indexOf('require("@nestjs/core")');

    if (startCallIndex === -1) {
      violations.push(
        `dist/${relativePath} never calls startTelemetry() — telemetry will be ` +
          'silently disabled in this entrypoint. Import src/telemetry and call ' +
          'startTelemetry() on the first line.',
      );
      continue;
    }

    if (nestRequireIndex !== -1 && startCallIndex > nestRequireIndex) {
      violations.push(
        `dist/${relativePath} requires @nestjs/core BEFORE calling ` +
          'startTelemetry(), so OpenTelemetry cannot patch pg/http/ioredis and ' +
          'traces will be missing their database and outbound-HTTP spans. This ' +
          'usually means the build now emits ESM (which hoists imports above ' +
          'statements) rather than CommonJS.',
      );
    }
  }

  return violations;
}

/**
 * Picks the guidance that matches the evidence. The first version of this
 * script asserted a single cause; when the stale-cache mode actually occurred
 * it printed a confident wrong lead, and this text is read by someone mid
 * incident.
 */
export function describeLikelyCause(
  repositoryRoot: string,
  distributionDirectory: string,
): string {
  const rootBuildInfo = join(repositoryRoot, 'tsconfig.build.tsbuildinfo');
  const hasStaleRootCache = isExistingFile(rootBuildInfo);
  const hasAssetsButNoCode =
    isExistingDirectory(join(distributionDirectory, 'common')) &&
    !isExistingFile(join(distributionDirectory, 'main.js'));

  if (hasStaleRootCache && hasAssetsButNoCode) {
    return (
      `A stale TypeScript incremental cache is at ${rootBuildInfo}. It sits outside dist/, so ` +
      "nest-cli's `deleteOutDir` cannot clear it, and tsc believes there is nothing to emit. " +
      'Delete that file and rebuild. It should live at dist/tsconfig.build.tsbuildinfo — check ' +
      '`tsBuildInfoFile` in tsconfig.build.json.'
    );
  }

  return (
    'The usual cause is a .ts file outside src/ entering the build scope, which rebases the ' +
    'tsc rootDir and moves every compiled path. tsconfig.build.json restricts the build to ' +
    '`include: ["src/**/*"]` and pins `rootDir`; check that neither has been widened or removed.'
  );
}

function runCommandLineCheck(): void {
  const repositoryRoot = resolve(__dirname, '..');
  const distributionDirectory = join(repositoryRoot, 'dist');

  const violations = findBuildArtifactViolations({
    distributionDirectory,
    repositoryRoot,
    requiredEntrypoints: [
      {
        relativePath: CONTAINER_ENTRYPOINT_RELATIVE_PATH,
        requiredBy: 'the container entrypoint — the CMD line in Dockerfile',
      },
      {
        relativePath: WORKER_ENTRYPOINT_RELATIVE_PATH,
        requiredBy:
          'the standalone queue worker — `start:worker` in package.json',
      },
    ],
  });

  if (violations.length > 0) {
    console.error(
      `\n✘ Build artifact contract violated — this build cannot boot (${violations.length} problem(s)):\n`,
    );
    for (const violation of violations) {
      console.error(`  • ${violation}`);
    }
    console.error('\nActual top-level dist/ layout:\n');
    console.error(
      isExistingDirectory(distributionDirectory)
        ? readdirSync(distributionDirectory, { withFileTypes: true })
            .map(
              (entry) =>
                `  dist/${entry.name}${entry.isDirectory() ? '/' : ''}`,
            )
            .join('\n')
        : '  dist/ does not exist — did the build run?',
    );
    console.error(
      `\n${describeLikelyCause(repositoryRoot, distributionDirectory)}\n` +
        '\n',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `✔ Build artifact contract satisfied — entrypoints dist/${CONTAINER_ENTRYPOINT_RELATIVE_PATH} ` +
      `and dist/${WORKER_ENTRYPOINT_RELATIVE_PATH}, with assets beside their loader.`,
  );
}

if (require.main === module) {
  runCommandLineCheck();
}
