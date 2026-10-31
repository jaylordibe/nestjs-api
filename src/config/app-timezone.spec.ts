import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';

const REPOSITORY_ROOT = resolve(__dirname, '../..');
const PIN_MODULE = 'src/config/app-timezone';

// A zone well away from UTC, so a process that ignored the pin would visibly
// read an offset-less date-time as the previous day.
const FOREIGN_TIMEZONE = 'Asia/Manila';

// Runs `script` in a fresh Node process whose host zone is FOREIGN_TIMEZONE,
// optionally loading the pin module first, and returns what it printed.
function probe(script: string, withPin: boolean): string {
  const preamble = withPin
    ? `require(${JSON.stringify(join(REPOSITORY_ROOT, PIN_MODULE))});`
    : '';
  const result = spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', preamble + script],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, TZ: FOREIGN_TIMEZONE },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function typeScriptFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typeScriptFilesUnder(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

type JestConfig = { rootDir?: string; globalSetup?: string };

// Every Jest config — the `jest` block of package.json and each test/jest*.json
// — with its `<rootDir>` resolved the way Jest does: against the config's own
// directory.
function jestConfigs(
  root: string,
): { file: string; rootDir: string; globalSetup?: string }[] {
  const resolveConfig = (file: string, config: JestConfig) => ({
    file,
    rootDir: resolve(root, dirname(file), config.rootDir ?? '.'),
    globalSetup: config.globalSetup,
  });
  const packageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as { jest?: JestConfig };
  const testDirectory = join(root, 'test');
  const testConfigs = existsSync(testDirectory)
    ? readdirSync(testDirectory).filter((name) => /^jest.*\.json$/.test(name))
    : [];
  return [
    ...(packageJson.jest
      ? [resolveConfig('package.json', packageJson.jest)]
      : []),
    ...testConfigs.map((name) =>
      resolveConfig(
        `test/${name}`,
        JSON.parse(
          readFileSync(join(testDirectory, name), 'utf8'),
        ) as JestConfig,
      ),
    ),
  ];
}

// A file boots Nest when its code — not a comment — starts an application,
// an application context, a REPL or a command runner.
function bootsNest(source: string): boolean {
  return source
    .split('\n')
    .some(
      (line) =>
        !/^\s*(\/\/|\/?\*)/.test(line) &&
        /NestFactory\.create|\brepl\(|CommandFactory\./.test(line),
    );
}

// The prisma/ files a package script or the Prisma seed command runs, e.g.
// `ts-node --transpile-only prisma/seed-dev.ts`.
function prismaFilesRunByCommands(root: string): string[] {
  const packageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  const prismaConfig = join(root, 'prisma.config.ts');
  const commands = [
    ...Object.values(packageJson.scripts ?? {}),
    existsSync(prismaConfig) ? readFileSync(prismaConfig, 'utf8') : '',
  ];
  return commands.flatMap((command) =>
    [...command.matchAll(/\bprisma\/[\w./-]+\.ts\b/g)].map((match) =>
      join(root, match[0]),
    ),
  );
}

// Every file a process starts from, found on disk so a new one is covered
// without anyone remembering to list it: each src file that boots Nest, every
// prisma/seed*.ts and prisma/scripts file, every prisma/ file a command runs,
// and each Jest config's globalSetup.
function findEntrypoints(root: string): string[] {
  const nestEntrypoints = typeScriptFilesUnder(join(root, 'src'))
    .filter((path) => !path.endsWith('.spec.ts'))
    .filter((path) => bootsNest(readFileSync(path, 'utf8')));
  const globalSetups = jestConfigs(root).flatMap((config) =>
    config.globalSetup
      ? [config.globalSetup.replace('<rootDir>', config.rootDir)]
      : [],
  );
  const seeds = readdirSync(join(root, 'prisma'))
    .filter((name) => /^seed.*\.ts$/.test(name))
    .map((name) => join(root, 'prisma', name));
  const entrypoints = [
    ...nestEntrypoints,
    ...seeds,
    ...typeScriptFilesUnder(join(root, 'prisma/scripts')),
    ...prismaFilesRunByCommands(root),
    ...globalSetups,
  ].map((path) => relative(root, path));
  return [...new Set(entrypoints)];
}

// The first statement, skipping comments and blank lines, must import the pin:
// anything evaluated before it runs in the host's zone.
function loadsPinFirst(root: string, entrypoint: string): boolean {
  let isInBlockComment = false;
  for (const rawLine of readFileSync(join(root, entrypoint), 'utf8').split(
    '\n',
  )) {
    let line = rawLine.trim();
    if (!isInBlockComment && line.startsWith('/*')) {
      isInBlockComment = true;
      line = line.slice(2);
    }
    if (isInBlockComment) {
      const commentEnd = line.indexOf('*/');
      if (commentEnd === -1) continue;
      isInBlockComment = false;
      // Code after the comment closes, on the same line, is still a statement.
      line = line.slice(commentEnd + 2).trim();
    }
    if (line === '' || line.startsWith('//')) continue;
    const pinPath = relative(
      dirname(join(root, entrypoint)),
      join(root, PIN_MODULE),
    );
    return (
      line === `import '${pinPath.startsWith('.') ? '' : './'}${pinPath}';`
    );
  }
  return false;
}

const PARSE_OFFSETLESS_DATE_TIME =
  'process.stdout.write(new Date("2026-11-15T00:00:00").toISOString())';

describe('app time zone', () => {
  it('runs a process in UTC even when its host is set to another zone', () => {
    // Without the pin the host zone applies — the defect, and the proof this
    // probe is not running somewhere that is UTC anyway.
    expect(probe(PARSE_OFFSETLESS_DATE_TIME, false)).toBe(
      '2026-11-14T16:00:00.000Z',
    );
    expect(probe(PARSE_OFFSETLESS_DATE_TIME, true)).toBe(
      '2026-11-15T00:00:00.000Z',
    );
    expect(
      probe(
        'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)',
        true,
      ),
    ).toBe('UTC');
  }, 30_000);

  // This spec's own worker, through the unit suite's globalSetup. Only telling
  // on a host that is not UTC; the checks below hold on any host.
  it('runs this test worker in UTC', () => {
    expect(new Date('2026-11-15T00:00:00').toISOString()).toBe(
      '2026-11-15T00:00:00.000Z',
    );
  });

  it.each(findEntrypoints(REPOSITORY_ROOT))(
    'loads the pin before anything else in %s',
    (entrypoint) => {
      expect(loadsPinFirst(REPOSITORY_ROOT, entrypoint)).toBe(true);
    },
  );

  // Test workers inherit the zone from the Jest parent, where only globalSetup
  // runs; a `setupFiles` entry gets a sandbox copy of `process.env`.
  it.each(jestConfigs(REPOSITORY_ROOT).map((config) => config.file))(
    'pins the Jest config %s through a globalSetup',
    (configFile) => {
      const config = jestConfigs(REPOSITORY_ROOT).find(
        (candidate) => candidate.file === configFile,
      );
      expect(config?.globalSetup).toBeDefined();
    },
  );

  // The discovery itself must catch what nobody listed.
  describe('against a repository missing the pin', () => {
    let fixtureRoot: string;

    beforeAll(() => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'app-timezone-'));
      const write = (path: string, content: string): void => {
        mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
        writeFileSync(join(fixtureRoot, path), content);
      };
      write(
        'package.json',
        JSON.stringify({
          scripts: { 'seed:extra': 'ts-node prisma/tools/extra-seed.ts' },
          jest: { globalSetup: '<rootDir>/test/setup.ts' },
        }),
      );
      write('prisma/seed-dev.ts', "import 'reflect-metadata';\n");
      write('prisma/tools/extra-seed.ts', "import 'dotenv/config';\n");
      write(
        'prisma.config.ts',
        "export default { migrations: { seed: 'ts-node prisma/tools/config-seed.ts' } };\n",
      );
      write('prisma/tools/config-seed.ts', "import 'dotenv/config';\n");
      write(
        'src/command.ts',
        "import { CommandFactory } from 'nest-commander';\nvoid CommandFactory.run(AppModule);\n",
      );
      write(
        'src/repl.ts',
        "import { repl } from '@nestjs/core';\nvoid repl(AppModule);\n",
      );
      write(
        'prisma/scripts/closing-line.ts',
        "/**\n * header\n */ const startedAt = new Date();\nimport '../../src/config/app-timezone';\n",
      );
      write('test/setup.ts', "import '../src/config/app-timezone';\n");
      write('src/app.module.ts', 'export class AppModule {}\n');
      write(
        'src/cli.ts',
        "import { NestFactory } from '@nestjs/core';\nNestFactory.createApplicationContext;\n",
      );
      write(
        'prisma/seed.ts',
        "// header\nconst startedAt = new Date();\nimport '../src/config/app-timezone';\n",
      );
      write('prisma/scripts/ops/backfill.ts', "import 'dotenv/config';\n");
      write(
        'prisma/scripts/inline-comment.ts',
        "/* note */ const startedAt = new Date();\nimport '../../src/config/app-timezone';\n",
      );
      write(
        'src/cli/nested-main.ts',
        "import { NestFactory } from '@nestjs/core';\nNestFactory.create;\n",
      );
      write(
        'src/modules/broadcaster.ts',
        '// Mirrors NestFactory.createApplicationContext, in a comment only.\n',
      );
    });

    afterAll(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it('finds new Nest entrypoints and nested scripts, and flags each unpinned one', () => {
      const entrypoints = findEntrypoints(fixtureRoot);
      expect(entrypoints).toEqual(
        expect.arrayContaining([
          'src/cli.ts',
          'src/cli/nested-main.ts',
          'src/repl.ts',
          'src/command.ts',
          'prisma/tools/config-seed.ts',
          'prisma/seed.ts',
          'prisma/seed-dev.ts',
          'prisma/tools/extra-seed.ts',
          'prisma/scripts/ops/backfill.ts',
          'test/setup.ts',
        ]),
      );
      expect(entrypoints).not.toContain('src/app.module.ts');
      expect(entrypoints).not.toContain('src/modules/broadcaster.ts');
      expect(
        entrypoints
          .filter((entrypoint) => !loadsPinFirst(fixtureRoot, entrypoint))
          .sort(),
      ).toEqual(
        [
          'src/cli.ts',
          'src/cli/nested-main.ts',
          'src/repl.ts',
          'src/command.ts',
          'prisma/tools/config-seed.ts',
          'prisma/seed.ts',
          'prisma/seed-dev.ts',
          'prisma/tools/extra-seed.ts',
          'prisma/scripts/ops/backfill.ts',
          'prisma/scripts/inline-comment.ts',
          'prisma/scripts/closing-line.ts',
        ].sort(),
      );
    });
  });
});
