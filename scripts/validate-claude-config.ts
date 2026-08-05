/**
 * Validates the Claude Code configuration under `.claude/` and `CLAUDE.md`.
 *
 * CLAUDE.md requires that every convention ship with a guardrail so the next
 * contributor cannot drift. That rule binds the tooling too: `.claude/` is
 * several thousand lines of frontmatter and cross-references that fail silently
 * — a mistyped key is ignored, a renamed symbol leaves a skill quoting a
 * function that no longer exists, and a skill whose name collides with a
 * bundled command resolves unpredictably. None of that surfaces at runtime.
 *
 * Run via `yarn claude:validate`. Wired into CI alongside lint and build.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const repositoryRoot = resolve(__dirname, '..');
const claudeDirectory = join(repositoryRoot, '.claude');

/** Frontmatter keys Claude Code recognises on a SKILL.md. Anything else is silently ignored at load time. */
const SUPPORTED_SKILL_KEYS = new Set([
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'allowed-tools',
  'disallowed-tools',
  'disable-model-invocation',
  'user-invocable',
  'model',
  'effort',
  'context',
  'license',
  'version',
  'metadata',
]);

/** Frontmatter keys Claude Code recognises on a `.claude/agents/*.md` subagent. */
const SUPPORTED_AGENT_KEYS = new Set([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'maxTurns',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'effort',
  'isolation',
  'color',
  'initialPrompt',
]);

/**
 * Namespace for every user-invocable project skill.
 *
 * A project skill sharing a name with a Claude Code built-in does not win — it
 * appears *beside* it in the `/` menu, distinguished only by which row the user
 * lands on. `review` collided with the bundled diff-review skill; `design`
 * collided with the Design-connector command sitting next to `/desktop`.
 *
 * A reserved-name denylist cannot solve this: it is stale the moment a new
 * built-in ships, and the list below is precisely what failed to catch `design`.
 * The prefix is the structural fix — Anthropic will not ship a `/gate-*`
 * command — and it makes the workflow discoverable as one family.
 */
const USER_INVOCABLE_SKILL_PREFIX = 'gate-';

/**
 * Skills allowed to skip the prefix, each a deliberate decision. `ticket` is the
 * conductor rather than a gate, so `gate-ticket` would misdescribe it. Exempt
 * names get checked against the known built-ins below instead — a weaker net,
 * which is exactly why the exemption list must stay short.
 */
const PREFIX_EXEMPT_SKILL_NAMES = new Set(['ticket']);

/**
 * Known built-in commands and bundled skills, used ONLY to screen the handful of
 * prefix-exempt names. Necessarily incomplete: treat an addition here as a
 * reason to reconsider the exemption, not as a substitute for the prefix.
 */
const KNOWN_BUILT_IN_COMMAND_NAMES = new Set([
  'init',
  'review',
  'code-review',
  'security-review',
  'simplify',
  'verify',
  'run',
  'debug',
  'design',
  'desktop',
  'loop',
  'schedule',
  'compact',
  'help',
  'clear',
  'config',
  'model',
  'agents',
  'skills',
  'hooks',
  'permissions',
  'context',
  'usage',
  'resume',
  'rewind',
  'export',
  'memory',
  'doctor',
]);

/** Documented truncation cap on the combined `description` + `when_to_use` text in the skill listing. */
const SKILL_LISTING_CHARACTER_CAP = 1536;

const VALID_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_AGENT_COLORS = new Set([
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
]);

interface Violation {
  readonly file: string;
  readonly message: string;
}

const violations: Violation[] = [];

function reportViolation(file: string, message: string): void {
  violations.push({ file: file.replace(`${repositoryRoot}/`, ''), message });
}

function listMarkdownFilesRecursively(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory).flatMap((entryName) => {
    const entryPath = join(directory, entryName);
    if (statSync(entryPath).isDirectory()) {
      return listMarkdownFilesRecursively(entryPath);
    }
    return entryName.endsWith('.md') ? [entryPath] : [];
  });
}

/**
 * Parses the leading `---` fenced block as flat `key: value` pairs.
 *
 * Deliberately not a YAML parser: every key in this repository's skills and
 * agents is a scalar or an inline list, and adding a YAML dependency to
 * validate configuration would be a heavier contract than the thing it checks.
 * A key whose value spans lines is reported rather than silently mis-parsed.
 */
function parseFrontmatter(
  filePath: string,
  fileContent: string,
): Record<string, string> | null {
  const lines = fileContent.split('\n');
  if (lines[0]?.trim() !== '---') {
    reportViolation(filePath, 'missing YAML frontmatter (file must start with `---`)');
    return null;
  }

  const closingIndex = lines.indexOf('---', 1);
  if (closingIndex === -1) {
    reportViolation(filePath, 'frontmatter is never closed with `---`');
    return null;
  }

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      reportViolation(filePath, `frontmatter line is not \`key: value\`: "${line.trim()}"`);
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    frontmatter[key] = value.replace(/^["']|["']$/g, '');
  }

  return frontmatter;
}

function validateSkill(skillFilePath: string): void {
  const skillDirectoryName = basename(dirname(skillFilePath));
  const frontmatter = parseFrontmatter(skillFilePath, readFileSync(skillFilePath, 'utf8'));
  if (frontmatter === null) {
    return;
  }

  for (const declaredKey of Object.keys(frontmatter)) {
    if (!SUPPORTED_SKILL_KEYS.has(declaredKey)) {
      reportViolation(
        skillFilePath,
        `unsupported frontmatter key \`${declaredKey}\` — Claude Code ignores it silently. Supported: ${[...SUPPORTED_SKILL_KEYS].join(', ')}`,
      );
    }
  }

  const declaredName = frontmatter.name;
  if (!declaredName) {
    reportViolation(skillFilePath, 'missing `name`');
  } else if (declaredName !== skillDirectoryName) {
    reportViolation(
      skillFilePath,
      `\`name: ${declaredName}\` does not match directory \`${skillDirectoryName}\` — the directory decides the slash command`,
    );
  }

  // Only skills that appear in the `/` menu can collide with a built-in there.
  // `user-invocable: false` skills are model-facing background knowledge.
  const appearsInSlashMenu = frontmatter['user-invocable'] !== 'false';

  if (declaredName && appearsInSlashMenu) {
    const carriesPrefix = declaredName.startsWith(USER_INVOCABLE_SKILL_PREFIX);
    const isExempt = PREFIX_EXEMPT_SKILL_NAMES.has(declaredName);

    if (!carriesPrefix && !isExempt) {
      reportViolation(
        skillFilePath,
        `user-invocable skill \`${declaredName}\` must be named \`${USER_INVOCABLE_SKILL_PREFIX}${declaredName}\` — an unprefixed name sits beside any same-named Claude Code built-in in the / menu, and the user picks by row. Rename the directory and the \`name:\` field, or add a reviewed exemption to PREFIX_EXEMPT_SKILL_NAMES`,
      );
    }

    if (isExempt && KNOWN_BUILT_IN_COMMAND_NAMES.has(declaredName)) {
      reportViolation(
        skillFilePath,
        `prefix-exempt skill \`${declaredName}\` now collides with a known built-in command — the exemption is no longer safe. Give it the \`${USER_INVOCABLE_SKILL_PREFIX}\` prefix`,
      );
    }
  }

  if (!frontmatter.description) {
    reportViolation(skillFilePath, 'missing `description` — Claude uses it to decide when to load the skill');
  }

  const listingLength =
    (frontmatter.description?.length ?? 0) + (frontmatter.when_to_use?.length ?? 0);
  if (listingLength > SKILL_LISTING_CHARACTER_CAP) {
    reportViolation(
      skillFilePath,
      `description + when_to_use is ${listingLength} chars, over the ${SKILL_LISTING_CHARACTER_CAP} cap — the listing is truncated and the trigger text is lost`,
    );
  }

  if (frontmatter.effort && !VALID_EFFORT_LEVELS.has(frontmatter.effort)) {
    reportViolation(skillFilePath, `invalid \`effort: ${frontmatter.effort}\``);
  }

  const isUserInvocable = frontmatter['user-invocable'] !== 'false';
  const isModelInvocable = frontmatter['disable-model-invocation'] !== 'true';
  if (!isUserInvocable && !isModelInvocable) {
    reportViolation(
      skillFilePath,
      'both `user-invocable: false` and `disable-model-invocation: true` — nothing can ever invoke this skill',
    );
  }
}

function validateAgent(agentFilePath: string): void {
  const agentFileStem = basename(agentFilePath, '.md');
  const frontmatter = parseFrontmatter(agentFilePath, readFileSync(agentFilePath, 'utf8'));
  if (frontmatter === null) {
    return;
  }

  for (const declaredKey of Object.keys(frontmatter)) {
    if (!SUPPORTED_AGENT_KEYS.has(declaredKey)) {
      reportViolation(
        agentFilePath,
        `unsupported frontmatter key \`${declaredKey}\` — Claude Code ignores it silently. Supported: ${[...SUPPORTED_AGENT_KEYS].join(', ')}`,
      );
    }
  }

  if (!frontmatter.name) {
    reportViolation(agentFilePath, 'missing `name` (required)');
  } else if (frontmatter.name !== agentFileStem) {
    reportViolation(
      agentFilePath,
      `\`name: ${frontmatter.name}\` does not match filename \`${agentFileStem}.md\``,
    );
  }

  if (frontmatter.name?.includes(':')) {
    reportViolation(agentFilePath, '`name` contains `:`, which is reserved for plugin-scoped identifiers — Claude Code refuses to load the file');
  }

  if (!frontmatter.description) {
    reportViolation(agentFilePath, 'missing `description` (required)');
  }

  if (frontmatter.effort && !VALID_EFFORT_LEVELS.has(frontmatter.effort)) {
    reportViolation(agentFilePath, `invalid \`effort: ${frontmatter.effort}\``);
  }

  if (frontmatter.color && !VALID_AGENT_COLORS.has(frontmatter.color)) {
    reportViolation(agentFilePath, `invalid \`color: ${frontmatter.color}\``);
  }

  const declaresReadOnlyIntent = readFileSync(agentFilePath, 'utf8').includes('Never edit files');
  const deniesWriteTools = (frontmatter.disallowedTools ?? '').includes('Edit');
  if (declaresReadOnlyIntent && !deniesWriteTools) {
    reportViolation(
      agentFilePath,
      'agent states "Never edit files" but does not set `disallowedTools: Edit, Write, NotebookEdit`. `permissionMode: plan` alone is overridden when the parent session runs acceptEdits/bypassPermissions',
    );
  }
}

/** Backticked path references, e.g. `src/common/errors/README.md` or `references/harness.md`. */
const PATH_REFERENCE_PATTERN = /`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:md|ts|json|prisma|ya?ml|sh))`/g;

/** Backticked NestJS-shaped symbols whose disappearance would leave a skill quoting dead code. */
const SYMBOL_REFERENCE_PATTERN =
  /`([A-Z][A-Za-z0-9]*(?:Service|Dto|Guard|Module|Factory|Interceptor|Filter|Pipe|Strategy|Processor|Extension))`/g;

/**
 * Placeholder tokens mark a naming *pattern* rather than a real file, e.g.
 * `docs/adr/NNNN-kebab-slug.md`. Resolving them would always fail.
 */
const PLACEHOLDER_PATTERN = /NNNN|<[^>]+>|\*|\{|\[/;

/**
 * These documents teach by counter-example — "`OperationAcknowledgementDto`,
 * never `OperationAckDto`" deliberately names a symbol that must NOT exist.
 * Treating a prohibition as drift would train the next contributor to delete
 * the very rule that prevents it.
 */
const COUNTER_EXAMPLE_PATTERN = /\bnever\b|\bnot\b|\bno\b|instead|→|->|banned|avoid|prohibit|wrong|deprecat/i;

function findEnclosingLine(fileContent: string, matchIndex: number): string {
  const lineStart = fileContent.lastIndexOf('\n', matchIndex) + 1;
  const lineEnd = fileContent.indexOf('\n', matchIndex);
  return fileContent.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
}

function validateCrossReferences(markdownFilePath: string): void {
  const fileContent = readFileSync(markdownFilePath, 'utf8');

  for (const match of fileContent.matchAll(PATH_REFERENCE_PATTERN)) {
    const referencedPath = match[1];
    if (PLACEHOLDER_PATTERN.test(referencedPath) || !referencedPath.includes('/')) {
      continue;
    }
    if (COUNTER_EXAMPLE_PATTERN.test(findEnclosingLine(fileContent, match.index))) {
      continue;
    }

    // CLAUDE.md and the skills routinely write source paths relative to `src/`
    // (`common/util/foo.util.ts`), so a bare repository-root check under-resolves.
    const candidateRoots = [
      repositoryRoot,
      dirname(markdownFilePath),
      join(repositoryRoot, 'src'),
      join(repositoryRoot, 'test'),
    ];
    const resolvesSomewhere = candidateRoots.some((candidateRoot) =>
      existsSync(join(candidateRoot, referencedPath)),
    );

    if (!resolvesSomewhere) {
      reportViolation(markdownFilePath, `references a path that does not exist: \`${referencedPath}\``);
    }
  }

  for (const match of fileContent.matchAll(SYMBOL_REFERENCE_PATTERN)) {
    const referencedSymbol = match[1];
    if (COUNTER_EXAMPLE_PATTERN.test(findEnclosingLine(fileContent, match.index))) {
      continue;
    }
    if (!symbolExistsInSource(referencedSymbol)) {
      reportViolation(
        markdownFilePath,
        `references a symbol not found in src/: \`${referencedSymbol}\` — the docs have drifted from the code`,
      );
    }
  }
}

const sourceSymbolCache = new Map<string, boolean>();

function symbolExistsInSource(symbolName: string): boolean {
  const cached = sourceSymbolCache.get(symbolName);
  if (cached !== undefined) {
    return cached;
  }

  let found = false;
  try {
    execFileSync('grep', ['-rqw', symbolName, 'src', 'test'], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    found = true;
  } catch {
    found = false;
  }

  sourceSymbolCache.set(symbolName, found);
  return found;
}

function validateSettingsAndHooks(): void {
  const settingsPath = join(claudeDirectory, 'settings.json');
  if (!existsSync(settingsPath)) {
    reportViolation(settingsPath, 'missing — the shared permission floor and hooks live here');
    return;
  }

  let settings: {
    hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
    permissions?: { deny?: string[]; ask?: string[]; allow?: string[] };
  };

  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (parseError) {
    reportViolation(settingsPath, `is not valid JSON: ${(parseError as Error).message}`);
    return;
  }

  for (const permissionRule of settings.permissions?.deny ?? []) {
    if (/^Write\(/.test(permissionRule)) {
      reportViolation(
        settingsPath,
        `deny rule \`${permissionRule}\` is never consulted — Claude Code checks file permissions against Edit() and Read() only. Use Edit(...)`,
      );
    }
  }

  for (const hookEventGroups of Object.values(settings.hooks ?? {})) {
    for (const hookGroup of hookEventGroups) {
      for (const hookDefinition of hookGroup.hooks ?? []) {
        const hookCommand = hookDefinition.command ?? '';
        if (!hookCommand.includes('${CLAUDE_PROJECT_DIR}')) {
          continue;
        }

        const hookScriptPath = hookCommand.replace('${CLAUDE_PROJECT_DIR}', repositoryRoot).trim();
        if (!existsSync(hookScriptPath)) {
          reportViolation(settingsPath, `hook script does not exist: ${hookCommand}`);
          continue;
        }

        try {
          execFileSync('bash', ['-n', hookScriptPath], { stdio: 'ignore' });
        } catch {
          reportViolation(hookScriptPath, 'hook script has a bash syntax error — it would fail open at runtime');
        }

        try {
          execFileSync('test', ['-x', hookScriptPath], { stdio: 'ignore' });
        } catch {
          reportViolation(hookScriptPath, 'hook script is not executable (chmod +x)');
        }
      }
    }
  }
}

function main(): void {
  const skillFiles = listMarkdownFilesRecursively(join(claudeDirectory, 'skills')).filter(
    (filePath) => basename(filePath) === 'SKILL.md',
  );
  const agentFiles = listMarkdownFilesRecursively(join(claudeDirectory, 'agents'));

  if (skillFiles.length === 0) {
    reportViolation(claudeDirectory, 'no skills found — expected .claude/skills/*/SKILL.md');
  }

  skillFiles.forEach(validateSkill);
  agentFiles.forEach(validateAgent);

  const crossReferencedFiles = [
    join(repositoryRoot, 'CLAUDE.md'),
    ...listMarkdownFilesRecursively(claudeDirectory),
  ].filter(existsSync);
  crossReferencedFiles.forEach(validateCrossReferences);

  validateSettingsAndHooks();

  const checkedCount = skillFiles.length + agentFiles.length + crossReferencedFiles.length;

  if (violations.length === 0) {
    console.log(
      `✔ Claude Code config valid — ${skillFiles.length} skills, ${agentFiles.length} agents, ${crossReferencedFiles.length} markdown files cross-checked.`,
    );
    return;
  }

  console.error(`\n✘ Claude Code config has ${violations.length} problem(s):\n`);
  for (const violation of violations) {
    console.error(`  ${violation.file}\n    ${violation.message}\n`);
  }
  console.error(`Checked ${checkedCount} files. Fix the above, then re-run \`yarn claude:validate\`.\n`);
  process.exit(1);
}

main();
