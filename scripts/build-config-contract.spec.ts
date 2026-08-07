import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as typescript from 'typescript';

import {
  CONTAINER_ENTRYPOINT_RELATIVE_PATH,
  readContainerEntrypointFromDockerfile,
} from './verify-build-artifacts';

// The postbuild guardrail cannot protect its own preconditions. If someone
// reverts `rootDir` but keeps the build scope narrow, the emitted layout is
// still correct and the guardrail passes — so occurrence #4 would once again be
// silent. Likewise, deleting the `postbuild` hook removes the guardrail with
// nothing left to notice.
//
// These assertions are the omission case for the configuration itself. Repo
// precedent for a spec that reads config rather than code:
// src/common/util/phone-field-naming.util.spec.ts.
interface BuildTypeScriptConfiguration {
  readonly compilerOptions?: {
    readonly rootDir?: string;
    readonly tsBuildInfoFile?: string;
  };
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly jest?: { readonly roots?: readonly string[] };
}

describe('build configuration contract', () => {
  const repositoryRoot = resolve(__dirname, '..');

  function readJsonWithComments<T>(relativePath: string): T {
    const absolutePath = join(repositoryRoot, relativePath);
    const parsed = typescript.parseConfigFileTextToJson(
      absolutePath,
      readFileSync(absolutePath, 'utf8'),
    );
    expect(parsed.error).toBeUndefined();
    return parsed.config as T;
  }

  describe('tsconfig.build.json', () => {
    const buildConfiguration = () =>
      readJsonWithComments<BuildTypeScriptConfiguration>('tsconfig.build.json');

    // Without this the emit path depends on which files are in scope, which is
    // what moved dist/main.js to dist/src/main.js and took staging down.
    it('pins rootDir to src so the emit layout cannot drift', () => {
      expect(buildConfiguration().compilerOptions?.rootDir).toBe('./src');
    });

    // Pinning rootDir moves the default cache location out of dist/, where
    // deleteOutDir can no longer clear it. A stale cache then makes tsc emit
    // nothing while exiting 0.
    it('keeps the incremental cache inside dist/ so deleteOutDir clears it', () => {
      expect(buildConfiguration().compilerOptions?.tsBuildInfoFile).toBe(
        './dist/tsconfig.build.tsbuildinfo',
      );
    });

    it('restricts the build to src via a positive include', () => {
      expect(buildConfiguration().include).toEqual(['src/**/*']);
    });

    it.each([['**/*spec.ts'], ['test'], ['scripts'], ['prisma']])(
      'excludes %s from the build',
      (excludedPattern) => {
        expect(buildConfiguration().exclude).toContain(excludedPattern);
      },
    );
  });

  describe('package.json', () => {
    const packageManifest = () =>
      JSON.parse(
        readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
      ) as PackageManifest;

    it('runs the artifact check after every build', () => {
      expect(packageManifest().scripts?.postbuild).toContain(
        'scripts/verify-build-artifacts.ts',
      );
    });

    // A spec under scripts/ that jest does not collect reports as passing,
    // which is worse than having no spec at all.
    it('collects specs from scripts/ as well as src/', () => {
      expect(packageManifest().jest?.roots).toEqual(
        expect.arrayContaining(['<rootDir>/src', '<rootDir>/scripts']),
      );
    });
  });

  // The artifact check cannot read the Dockerfile itself: .dockerignore excludes
  // it, so when the check runs as postbuild INSIDE the Docker build stage there
  // is no Dockerfile present. Deriving it there failed every image build. The
  // anti-drift assertion therefore lives here, where the file does exist — a
  // retargeted CMD fails this spec instead of silently leaving the guardrail
  // verifying a file nothing runs.
  describe('Dockerfile', () => {
    const dockerfile = () =>
      readFileSync(join(repositoryRoot, 'Dockerfile'), 'utf8');

    it('starts the same entrypoint the artifact check asserts', () => {
      expect(readContainerEntrypointFromDockerfile(dockerfile())).toBe(
        CONTAINER_ENTRYPOINT_RELATIVE_PATH,
      );
    });
  });

  describe('.dockerignore', () => {
    const dockerignore = () =>
      readFileSync(join(repositoryRoot, '.dockerignore'), 'utf8');

    // A stale cache copied in via `COPY . .` makes the in-image build emit
    // nothing. The pattern must match at any depth, not just the repo root.
    it('excludes TypeScript incremental caches at any depth', () => {
      expect(dockerignore()).toMatch(/^\*\*\/\*\.tsbuildinfo$/m);
    });

    // postbuild runs inside the Docker build stage, so scripts/ is now a
    // required part of the build context. Excluding it would break every
    // deploy at image-build time.
    it('does not exclude scripts/, which the in-image build now needs', () => {
      expect(dockerignore()).not.toMatch(/^scripts\/?$/m);
    });
  });
});

// `eslint --fix` repairs what it can and THEN exits 0, so a fixing linter can
// never fail a gate: it rewrites the runner's copy, reports success, and the
// fixes die with the container. The unsuffixed `lint` is therefore the CHECK
// and `lint:fix` the opt-in mutation, so that a workflow step or a document
// written from muscle memory gets the gate rather than a silent pass.
//
// Prettier is enforced through the `prettier/prettier` ESLint rule, so a
// separate `format` script is a second entry point to a formatter `lint`
// already applies — and one whose glob drifts out of step with the lint glob.
// It covered `prisma/` while lint did not, which is why the lint glob must
// keep covering `prisma/` now that `format` is gone.
//
// Documentation alone cannot hold any of this: re-adding `--fix` to `lint`, or
// pointing CI at `lint:fix`, restores the silent pass with no visible symptom.
// These assertions are that omission case.
describe('lint gate contract', () => {
  const repositoryRoot = resolve(__dirname, '..');

  const packageManifest = () =>
    JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
    ) as PackageManifest;

  const testWorkflow = () =>
    readFileSync(join(repositoryRoot, '.github/workflows/test.yml'), 'utf8');

  it('keeps the default lint script free of --fix so it can actually fail', () => {
    const lintScript = packageManifest().scripts?.lint;
    expect(lintScript).toBeDefined();
    expect(lintScript).not.toContain('--fix');
  });

  // One definition of the lint scope. If the fixer stops delegating, the two
  // scripts drift and a path added to one is silently unlinted by the other.
  it('derives the fixing script from the checking script', () => {
    expect(packageManifest().scripts?.['lint:fix']).toContain('yarn lint');
  });

  // Inherited from the deleted `format` script, whose glob was the only thing
  // covering these files.
  it('keeps prisma/ inside the lint glob', () => {
    expect(packageManifest().scripts?.lint).toContain('prisma');
  });

  it.each([['format'], ['format:check']])(
    'has no standalone %s script duplicating the ESLint prettier rule',
    (scriptName) => {
      expect(packageManifest().scripts?.[scriptName]).toBeUndefined();
    },
  );

  it('runs the checking script in CI', () => {
    expect(testWorkflow()).toMatch(/run:\s*yarn lint\s*$/m);
  });

  it('never invokes the fixing script from CI', () => {
    expect(testWorkflow()).not.toContain('yarn lint:fix');
  });
});
