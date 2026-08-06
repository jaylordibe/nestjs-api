import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  describeLikelyCause,
  findBuildArtifactViolations,
  readContainerEntrypointFromDockerfile,
} from './verify-build-artifacts';

// A guardrail that has only ever been run against a passing build is
// indistinguishable from one that always returns "fine". These tests exist to
// prove it catches each omission, not that it accepts the happy path — the
// happy path is asserted once, as a control, so the suite cannot pass vacuously.
//
// Fixtures are real directories rather than mocks: the check's whole job is to
// observe the filesystem, and a mocked `fs` would be asserting the mock.
describe('verify-build-artifacts', () => {
  const CONTAINER_ENTRYPOINT = {
    relativePath: 'main.js',
    requiredBy: 'the container entrypoint',
  };
  const WORKER_ENTRYPOINT = {
    relativePath: 'worker.js',
    requiredBy: 'the standalone queue worker',
  };
  const REQUIRED_ENTRYPOINTS = [CONTAINER_ENTRYPOINT, WORKER_ENTRYPOINT];

  let repositoryRoot: string;
  let distributionDirectory: string;

  /** Builds a fixture that mirrors a correct build, for tests to break one way. */
  function createSoundBuild(templateCount: number): void {
    const compiledEmailDirectory = join(distributionDirectory, 'common/email');
    const builtTemplates = join(compiledEmailDirectory, 'templates');
    const sourceTemplates = join(repositoryRoot, 'src/common/email/templates');

    mkdirSync(builtTemplates, { recursive: true });
    mkdirSync(sourceTemplates, { recursive: true });
    writeFileSync(join(distributionDirectory, 'main.js'), '');
    writeFileSync(join(distributionDirectory, 'worker.js'), '');
    writeFileSync(join(compiledEmailDirectory, 'template-engine.js'), '');

    for (
      let templateIndex = 0;
      templateIndex < templateCount;
      templateIndex++
    ) {
      writeFileSync(join(builtTemplates, `mail-${templateIndex}.html.hbs`), '');
      writeFileSync(
        join(sourceTemplates, `mail-${templateIndex}.html.hbs`),
        '',
      );
    }
  }

  function findViolations(): string[] {
    return findBuildArtifactViolations({
      distributionDirectory,
      repositoryRoot,
      requiredEntrypoints: REQUIRED_ENTRYPOINTS,
    });
  }

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'build-artifact-contract-'));
    distributionDirectory = join(repositoryRoot, 'dist');
    mkdirSync(distributionDirectory, { recursive: true });
  });

  afterEach(() => {
    rmSync(repositoryRoot, { recursive: true, force: true });
  });

  describe('the correct case', () => {
    it('accepts a sound build', () => {
      createSoundBuild(3);
      expect(findViolations()).toEqual([]);
    });

    it('accepts templates nested in subdirectories', () => {
      createSoundBuild(1);
      const nestedBuilt = join(
        distributionDirectory,
        'common/email/templates/listing-bookings',
      );
      const nestedSource = join(
        repositoryRoot,
        'src/common/email/templates/listing-bookings',
      );
      mkdirSync(nestedBuilt, { recursive: true });
      mkdirSync(nestedSource, { recursive: true });
      writeFileSync(join(nestedBuilt, 'confirmed.html.hbs'), '');
      writeFileSync(join(nestedSource, 'confirmed.html.hbs'), '');

      expect(findViolations()).toEqual([]);
    });
  });

  describe('the omitted cases', () => {
    // This is the outage: rootDir rebased and every compiled path moved.
    it('rejects a missing container entrypoint', () => {
      createSoundBuild(1);
      rmSync(join(distributionDirectory, 'main.js'));

      expect(findViolations()).toEqual([
        expect.stringContaining('dist/main.js is missing'),
      ]);
    });

    it('rejects a missing worker entrypoint', () => {
      createSoundBuild(1);
      rmSync(join(distributionDirectory, 'worker.js'));

      expect(findViolations()).toEqual([
        expect.stringContaining('dist/worker.js is missing'),
      ]);
    });

    it('rejects a missing template directory', () => {
      createSoundBuild(1);
      rmSync(join(distributionDirectory, 'common/email/templates'), {
        recursive: true,
      });

      expect(findViolations()).toEqual([
        expect.stringContaining('dist/common/email/templates/ is missing'),
      ]);
    });

    // An empty directory satisfies "the directory exists" and still fails at
    // boot, so existence alone was never a sufficient assertion.
    it('rejects an empty template directory', () => {
      createSoundBuild(0);

      expect(findViolations()).toEqual([
        expect.stringContaining('contains no .hbs files'),
      ]);
    });

    it('rejects a template directory holding no files of the required extension', () => {
      createSoundBuild(0);
      writeFileSync(
        join(distributionDirectory, 'common/email/templates/notes.txt'),
        '',
      );

      expect(findViolations()).toEqual([
        expect.stringContaining('contains no .hbs files'),
      ]);
    });

    // The asset directory is written to a fixed literal outDir, so in the real
    // split it is the LOADER that moves. Asserting only the assets would pass.
    it('rejects a loader that has moved away from its assets', () => {
      createSoundBuild(1);
      rmSync(join(distributionDirectory, 'common/email/template-engine.js'));

      expect(findViolations()).toEqual([
        expect.stringContaining(
          'dist/common/email/template-engine.js is missing',
        ),
      ]);
    });

    it('rejects a truncated asset copy', () => {
      createSoundBuild(3);
      rmSync(
        join(distributionDirectory, 'common/email/templates/mail-0.html.hbs'),
      );

      expect(findViolations()).toEqual([
        expect.stringContaining('the asset copy is incomplete'),
      ]);
    });

    it('rejects a dist directory that does not exist at all', () => {
      rmSync(distributionDirectory, { recursive: true });

      expect(findViolations()).toEqual([
        expect.stringContaining('dist/ does not exist'),
      ]);
    });

    it('reports every violation at once rather than stopping at the first', () => {
      createSoundBuild(1);
      rmSync(join(distributionDirectory, 'main.js'));
      rmSync(join(distributionDirectory, 'worker.js'));

      expect(findViolations()).toHaveLength(2);
    });
  });

  // The entrypoint is derived from the Dockerfile so a CMD retarget cannot
  // leave the check verifying a file nothing runs.
  describe('readContainerEntrypointFromDockerfile', () => {
    it('reads the entrypoint out of a CMD line', () => {
      expect(
        readContainerEntrypointFromDockerfile('CMD ["node", "dist/main.js"]'),
      ).toBe('main.js');
    });

    it('follows a retargeted CMD instead of assuming main.js', () => {
      expect(
        readContainerEntrypointFromDockerfile('CMD ["node", "dist/server.js"]'),
      ).toBe('server.js');
    });

    it('returns null when no node CMD is present, rather than guessing', () => {
      expect(
        readContainerEntrypointFromDockerfile('CMD ["sh", "-c", "x"]'),
      ).toBeNull();
    });
  });

  describe('describeLikelyCause', () => {
    // The first version of this script named one cause. When the stale-cache
    // mode actually happened it printed a confident wrong lead.
    it('names the stale root cache when that is what the evidence shows', () => {
      mkdirSync(join(distributionDirectory, 'common'), { recursive: true });
      writeFileSync(join(repositoryRoot, 'tsconfig.build.tsbuildinfo'), '');

      expect(
        describeLikelyCause(repositoryRoot, distributionDirectory),
      ).toContain('stale TypeScript incremental cache');
    });

    it('names the build-scope cause when there is no stale cache', () => {
      createSoundBuild(1);
      rmSync(join(distributionDirectory, 'main.js'));

      expect(
        describeLikelyCause(repositoryRoot, distributionDirectory),
      ).toContain('outside src/ entering the build scope');
    });
  });
});
