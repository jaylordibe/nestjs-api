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
  'arguments',
  'allowed-tools',
  'disallowed-tools',
  'disable-model-invocation',
  'user-invocable',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'hooks',
  'paths',
  'shell',
  'compatibility',
  'license',
  'version',
  'metadata',
]);

/** Tools that can modify a file. An agent holding any of these is not read-only. */
const FILE_MUTATING_TOOL_NAMES = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

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
 * Skills allowed to skip the prefix, each a deliberate decision. `work-item` is
 * the conductor rather than a gate, so a `gate-` name would misdescribe it. The
 * exemption is defensible partly because the name is a hyphenated compound:
 * Claude Code's built-ins are single words (`init`, `review`, `design`, `run`,
 * `debug`), so the collision surface is far smaller than for a bare noun.
 *
 * Exempt names get checked against the known built-ins below instead — a weaker
 * net, which is exactly why this list must stay short.
 */
const PREFIX_EXEMPT_SKILL_NAMES = new Set(['work-item']);

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
    reportViolation(
      filePath,
      'missing YAML frontmatter (file must start with `---`)',
    );
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
      reportViolation(
        filePath,
        `frontmatter line is not \`key: value\`: "${line.trim()}"`,
      );
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
  const frontmatter = parseFrontmatter(
    skillFilePath,
    readFileSync(skillFilePath, 'utf8'),
  );
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
    reportViolation(
      skillFilePath,
      'missing `description` — Claude uses it to decide when to load the skill',
    );
  }

  const listingLength =
    (frontmatter.description?.length ?? 0) +
    (frontmatter.when_to_use?.length ?? 0);
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
  const frontmatter = parseFrontmatter(
    agentFilePath,
    readFileSync(agentFilePath, 'utf8'),
  );
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
    reportViolation(
      agentFilePath,
      '`name` contains `:`, which is reserved for plugin-scoped identifiers — Claude Code refuses to load the file',
    );
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

  validateAgentIsReadOnly(agentFilePath, frontmatter);
}

/**
 * `.claude/README.md` states the invariant plainly: "Agents are read-only. The
 * main conversation verifies findings and owns any approved remediation." Every
 * review lens in this repository depends on it — an agent that can edit could
 * silently fix what it was asked to judge, and its finding would then describe
 * code that no longer exists.
 *
 * This deliberately checks the *tool pool* rather than searching the prose for a
 * phrase like "Never edit files". A prose probe only fires on agents that
 * happen to use the exact wording, so it passes an agent that forgot both the
 * sentence and the restriction — silence reads as compliance. Three of the
 * eight agents here were in exactly that state. A guardrail that cannot catch
 * an omission is not a guardrail.
 */
function validateAgentIsReadOnly(
  agentFilePath: string,
  frontmatter: Record<string, string>,
): void {
  const splitToolList = (rawValue: string | undefined): string[] =>
    (rawValue ?? '')
      .split(/[,\s]+/)
      .map((toolName) => toolName.trim())
      .filter((toolName) => toolName.length > 0);

  const grantedTools = splitToolList(frontmatter.tools);
  const deniedTools = splitToolList(frontmatter.disallowedTools);

  if (grantedTools.length === 0) {
    reportViolation(
      agentFilePath,
      'no `tools` allowlist — the agent inherits every tool available to subagents, including Edit and Write. Declare the read-only set explicitly',
    );
    return;
  }

  const grantedMutatingTools = grantedTools.filter((toolName) =>
    FILE_MUTATING_TOOL_NAMES.includes(toolName),
  );
  if (grantedMutatingTools.length > 0) {
    reportViolation(
      agentFilePath,
      `grants file-mutating tool(s) ${grantedMutatingTools.join(', ')} — .claude/README.md states every agent here is read-only, and a reviewer that can edit the code it judges invalidates its own finding`,
    );
  }

  const missingDenials = FILE_MUTATING_TOOL_NAMES.filter(
    (toolName) => toolName !== 'MultiEdit' && !deniedTools.includes(toolName),
  );
  if (missingDenials.length > 0) {
    reportViolation(
      agentFilePath,
      `\`disallowedTools\` omits ${missingDenials.join(', ')}. The \`tools\` allowlist already excludes them today, so this is belt-and-braces — but it is what keeps the agent read-only if someone later widens \`tools\`, and \`permissionMode: plan\` does not help: it is overridden when the parent session runs acceptEdits or bypassPermissions`,
    );
  }
}

/** Backticked path references, e.g. `src/common/errors/README.md` or `references/harness.md`. */
const PATH_REFERENCE_PATTERN =
  /`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:md|ts|json|prisma|ya?ml|sh))`/g;

/** Backticked NestJS-shaped symbols whose disappearance would leave a skill quoting dead code. */
const SYMBOL_REFERENCE_PATTERN =
  /`([A-Z][A-Za-z0-9]*(?:Service|Dto|Guard|Module|Factory|Interceptor|Filter|Pipe|Strategy|Processor|Extension))`/g;

/**
 * Decorators and named constants — `@RequirePermission(...)`, `@Public()`,
 * `HHMM_PATTERN` — and dotted idioms such as `prisma.scoped`.
 *
 * These matter more than the class-suffix pattern above, because they are how a
 * skill states an *architectural* rule rather than a code reference. Comparing
 * this starter against a project cloned from it, the gate skills mandated
 * `@RequirePermission`, `@AuthenticatedOnly` and `AbilityScopedQueryService` —
 * none of which existed there, because that project uses a plain role guard.
 * Only the class-suffixed one was caught. A framework whose skills confidently
 * describe an architecture the repository does not have is worse than no
 * framework: every review it runs is measured against the wrong contract.
 *
 * A framework decorator such as `@UseGuards` resolves fine — it appears in
 * source because it is used. One that appears nowhere in `src/` or `test/` is
 * drift by definition, whoever declared it.
 */
const DECORATOR_REFERENCE_PATTERN = /`@([A-Z][A-Za-z0-9]*)(?:\([^`]*\))?`/g;

const NAMED_CONSTANT_REFERENCE_PATTERN = /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g;

/**
 * Dotted idioms are checked from a curated list rather than by a regex sweep.
 *
 * A pattern broad enough to catch `prisma.scoped` also catches `package.json`,
 * `settings.json`, `permissions.deny` and `user.name` — filenames and config
 * keys that will never appear in `src/`. Narrowing it by denying known
 * extensions just trades false positives for a list that goes stale.
 *
 * These are instead the handful of idioms that *define* the architecture this
 * tooling asserts. A project either has them or has to rewrite the skills,
 * which is exactly the decision this check exists to force. Keep the
 * list short: an idiom belongs here only if a skill would be wrong without it.
 */
const ARCHITECTURAL_IDIOMS = [
  'prisma.scoped',
  'configService.getOrThrow',
  'AuditService.record',
];

/**
 * Placeholder tokens mark a naming *pattern* rather than a real file, e.g.
 * placeholder paths such as `<file>` or `NNNN-slug.md`. Resolving them would always fail.
 */
const PLACEHOLDER_PATTERN = /NNNN|<[^>]+>|\*|\{|\[/;

/**
 * These documents teach by counter-example — "`OperationAcknowledgementDto`,
 * never `OperationAckDto`" deliberately names a symbol that must NOT exist.
 * Treating a prohibition as drift would train the next contributor to delete
 * the very rule that prevents it.
 */
const COUNTER_EXAMPLE_PATTERN =
  /\bnever\b|\bnot\b|\bno\b|instead|→|->|banned|avoid|prohibit|wrong|deprecat/i;

function findEnclosingLine(fileContent: string, matchIndex: number): string {
  const lineStart = fileContent.lastIndexOf('\n', matchIndex) + 1;
  const lineEnd = fileContent.indexOf('\n', matchIndex);
  return fileContent.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
}

function validateCrossReferences(markdownFilePath: string): void {
  const fileContent = readFileSync(markdownFilePath, 'utf8');

  for (const match of fileContent.matchAll(PATH_REFERENCE_PATTERN)) {
    const referencedPath = match[1];
    if (
      PLACEHOLDER_PATTERN.test(referencedPath) ||
      !referencedPath.includes('/')
    ) {
      continue;
    }
    if (
      COUNTER_EXAMPLE_PATTERN.test(findEnclosingLine(fileContent, match.index))
    ) {
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
      reportViolation(
        markdownFilePath,
        `references a path that does not exist: \`${referencedPath}\``,
      );
    }
  }

  const symbolChecks: readonly {
    pattern: RegExp;
    describe: (symbol: string) => string;
    exists: (symbol: string) => boolean;
  }[] = [
    {
      pattern: SYMBOL_REFERENCE_PATTERN,
      describe: (symbol) => `a symbol not found in src/: \`${symbol}\``,
      exists: wholeWordExistsInSource,
    },
    {
      pattern: DECORATOR_REFERENCE_PATTERN,
      describe: (symbol) =>
        `the decorator \`@${symbol}\`, which appears nowhere in the code`,
      exists: wholeWordExistsInSource,
    },
    {
      pattern: NAMED_CONSTANT_REFERENCE_PATTERN,
      describe: (symbol) => `the constant \`${symbol}\`, not found in the code`,
      exists: wholeWordExistsInSource,
    },
  ];

  for (const { pattern, describe, exists } of symbolChecks) {
    for (const match of fileContent.matchAll(pattern)) {
      const referencedSymbol = match[1];
      if (
        COUNTER_EXAMPLE_PATTERN.test(
          findEnclosingLine(fileContent, match.index),
        )
      ) {
        continue;
      }
      if (!exists(referencedSymbol)) {
        reportViolation(
          markdownFilePath,
          `references ${describe(referencedSymbol)} — either the docs have drifted from the code, or the Claude Engineering Framework was copied into a project whose architecture differs. Both are drift; fix the skill, not the check`,
        );
      }
    }
  }
}

const sourceSymbolCache = new Map<string, boolean>();

/**
 * Where a referenced symbol may legitimately live. All code, no prose: including
 * `.claude/*.md` would let two documents cite each other into existence and the
 * drift check would confirm whatever the docs already believed. `.claude/hooks`
 * is in because a hook is executable logic whose constants the docs cite.
 */
const SYMBOL_SEARCH_ROOTS = ['src', 'test', 'scripts', '.claude/hooks'];

function existsInSource(cacheKey: string, grepFlags: string[]): boolean {
  const cached = sourceSymbolCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let found = false;
  try {
    execFileSync('grep', [...grepFlags, ...SYMBOL_SEARCH_ROOTS], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    found = true;
  } catch {
    found = false;
  }

  sourceSymbolCache.set(cacheKey, found);
  return found;
}

/** Identifier match: `Errors` must not be satisfied by `ErrorsFactory`. */
function wholeWordExistsInSource(symbolName: string): boolean {
  return existsInSource(`word:${symbolName}`, ['-rqw', symbolName]);
}

/** Literal match for dotted idioms — `-w` treats `.` as a boundary, so `prisma.scoped` would match `prisma` alone. */
function literalExistsInSource(idiom: string): boolean {
  return existsInSource(`literal:${idiom}`, ['-rqF', idiom]);
}

interface ClaudeCodeSettings {
  readonly hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
  readonly permissions?: { deny?: string[]; ask?: string[]; allow?: string[] };
}

function validateSettingsAndHooks(): void {
  const settingsPath = join(claudeDirectory, 'settings.json');
  if (!existsSync(settingsPath)) {
    reportViolation(
      settingsPath,
      'missing — the shared permission floor and hooks live here',
    );
    return;
  }

  let settings: ClaudeCodeSettings;
  try {
    settings = JSON.parse(
      readFileSync(settingsPath, 'utf8'),
    ) as ClaudeCodeSettings;
  } catch (parseError) {
    reportViolation(
      settingsPath,
      `is not valid JSON: ${(parseError as Error).message}`,
    );
    return;
  }

  validateFilePermissionRuleShapes(settingsPath, settings);
  validateRequiredDenyFloor(settingsPath, settings);
  validateShellRuleParity(settingsPath, settings);
  validateIssueTrackerRulePortability(settingsPath, settings);
  validateGitDenyMatchesGuardHook(settingsPath, settings);
  validateHookScripts(settingsPath, settings);
}

/**
 * Claude Code checks file permissions against `Edit(path)` and `Read(path)`
 * only. A `Write(...)`, `NotebookEdit(...)`, `MultiEdit(...)` or `Glob(...)`
 * path rule is accepted, warned about at startup, and then never consulted —
 * the most dangerous failure shape there is, because the file reads as
 * protected. Checked across all three arrays, not just `deny`: a `Write()`
 * entry in `allow` is equally inert and equally misleading.
 */
function validateFilePermissionRuleShapes(
  settingsPath: string,
  settings: ClaudeCodeSettings,
): void {
  const inertPathRuleTools: Record<string, string> = {
    Write: 'Edit',
    NotebookEdit: 'Edit',
    MultiEdit: 'Edit',
    Glob: 'Read',
  };

  for (const [tier, permissionRules] of Object.entries(
    settings.permissions ?? {},
  )) {
    for (const permissionRule of permissionRules) {
      const ruleToolName = /^([A-Za-z]+)\(/.exec(permissionRule)?.[1];
      const replacementToolName = ruleToolName
        ? inertPathRuleTools[ruleToolName]
        : undefined;
      if (replacementToolName) {
        reportViolation(
          settingsPath,
          `${tier} rule \`${permissionRule}\` is never consulted — Claude Code checks file permissions against Edit() and Read() only. Use ${replacementToolName}(...)`,
        );
      }
    }
  }
}

/**
 * `CLAUDE.md`'s *Human-owned operations* list is a promise to the developer.
 * Without this check, deleting one line from `settings.json` quietly retracts
 * the promise while every document still asserts it.
 */
const REQUIRED_DENY_RULES = [
  'Bash(git commit *)',
  'Bash(git push *)',
  'Bash(yarn prisma:deploy *)',
  'Bash(yarn prisma:reset *)',
  'Bash(prisma migrate *)',
  'Bash(docker volume rm *)',
  'Read(.env)',
  'Edit(.env)',
];

function validateRequiredDenyFloor(
  settingsPath: string,
  settings: ClaudeCodeSettings,
): void {
  const denyRules = new Set(settings.permissions?.deny ?? []);
  for (const requiredRule of REQUIRED_DENY_RULES) {
    if (!denyRules.has(requiredRule)) {
      reportViolation(
        settingsPath,
        `missing required deny rule \`${requiredRule}\` — CLAUDE.md reserves this operation for the human, and prose alone does not stop it`,
      );
    }
  }
}

/**
 * `Bash(...)` rules do not apply to the PowerShell tool, which is enabled by
 * default on Windows without Git Bash. A floor that exists only for Bash simply
 * vanishes on those machines, silently, with no warning anywhere.
 *
 * Only `deny` and `ask` are mirrored. A missing `allow` costs an extra prompt;
 * a missing `deny` costs the guarantee.
 */
function validateShellRuleParity(
  settingsPath: string,
  settings: ClaudeCodeSettings,
): void {
  for (const tier of ['deny', 'ask'] as const) {
    const permissionRules = settings.permissions?.[tier] ?? [];
    const patternsFor = (toolName: string): Set<string> =>
      new Set(
        permissionRules
          .filter((rule) => rule.startsWith(`${toolName}(`))
          .map((rule) => rule.slice(toolName.length + 1, -1)),
      );

    const bashPatterns = patternsFor('Bash');
    const powerShellPatterns = patternsFor('PowerShell');

    for (const pattern of bashPatterns) {
      if (!powerShellPatterns.has(pattern)) {
        reportViolation(
          settingsPath,
          `${tier} rule \`Bash(${pattern})\` has no \`PowerShell(${pattern})\` counterpart — Bash rules do not govern the PowerShell tool, which is on by default on Windows without Git Bash`,
        );
      }
    }
    for (const pattern of powerShellPatterns) {
      if (!bashPatterns.has(pattern)) {
        reportViolation(
          settingsPath,
          `${tier} rule \`PowerShell(${pattern})\` has no \`Bash(${pattern})\` counterpart — the two shells must carry the same floor`,
        );
      }
    }
  }
}

/**
 * The portability bug this repository exists to avoid shipping.
 *
 * An MCP tool is named `mcp__<server>__<tool>`, and `<server>` is whatever this
 * project called it in `.mcp.json`. A rule hardcoding `mcp__atlassian__`
 * matches nothing in a project whose server is `atlassian-acme` — the tracker
 * floor is simply absent, while `.claude/README.md` still promises it. Deny and
 * ask rules accept a glob in the server segment (only *allow* rules require it
 * to be literal), so `mcp__*__` is both correct and portable.
 */
function validateIssueTrackerRulePortability(
  settingsPath: string,
  settings: ClaudeCodeSettings,
): void {
  for (const tier of ['deny', 'ask'] as const) {
    for (const permissionRule of settings.permissions?.[tier] ?? []) {
      if (!permissionRule.startsWith('mcp__')) {
        continue;
      }
      const serverSegment = permissionRule.split('__')[1];
      if (serverSegment !== '*') {
        reportViolation(
          settingsPath,
          `${tier} rule \`${permissionRule}\` hardcodes the MCP server name \`${serverSegment}\`. This is a starter template: a project that names its server differently gets no rule at all, silently. Use \`mcp__*__<tool>\``,
        );
      }
    }
  }
}

/**
 * The guard hook and the deny floor cover the same Git verbs by two different
 * mechanisms, and each catches forms the other cannot. Letting them drift means
 * one list quietly becomes the real policy while the other is read as if it
 * still applied.
 */
function validateGitDenyMatchesGuardHook(
  settingsPath: string,
  settings: ClaudeCodeSettings,
): void {
  const guardHookPath = join(
    claudeDirectory,
    'hooks',
    'guard-dangerous-commands.sh',
  );
  if (!existsSync(guardHookPath)) {
    reportViolation(
      guardHookPath,
      'missing — it is the only layer that sees `git -C <path> commit` and other non-prefix forms',
    );
    return;
  }

  const hookSource = readFileSync(guardHookPath, 'utf8');
  const declaredTable = /GIT_HUMAN_OWNED_SUBCOMMANDS='([^']*)'/.exec(
    hookSource,
  )?.[1];
  if (declaredTable === undefined) {
    reportViolation(
      guardHookPath,
      'GIT_HUMAN_OWNED_SUBCOMMANDS is no longer a single-quoted literal, so its parity with settings.json can no longer be checked',
    );
    return;
  }

  const hookSubcommands = new Set(declaredTable.split(/\s+/).filter(Boolean));
  const deniedSubcommands = new Set(
    (settings.permissions?.deny ?? [])
      .map((rule) => /^Bash\(git ([a-z-]+) \*\)$/.exec(rule)?.[1])
      .filter((subcommand): subcommand is string => subcommand !== undefined),
  );

  for (const subcommand of hookSubcommands) {
    if (!deniedSubcommands.has(subcommand)) {
      reportViolation(
        settingsPath,
        `the guard hook denies \`git ${subcommand}\` but there is no \`Bash(git ${subcommand} *)\` deny rule. The hook can fail; the deny rule cannot — keep both`,
      );
    }
  }
  for (const subcommand of deniedSubcommands) {
    if (!hookSubcommands.has(subcommand)) {
      reportViolation(
        guardHookPath,
        `settings.json denies \`git ${subcommand}\` but GIT_HUMAN_OWNED_SUBCOMMANDS omits it, so \`git -C <path> ${subcommand}\` is not covered`,
      );
    }
  }
}

function validateHookScripts(
  settingsPath: string,
  settings: ClaudeCodeSettings,
): void {
  const referencedScriptPaths = new Set<string>();

  for (const hookEventGroups of Object.values(settings.hooks ?? {})) {
    for (const hookGroup of hookEventGroups) {
      for (const hookDefinition of hookGroup.hooks ?? []) {
        const hookCommand = hookDefinition.command ?? '';
        if (!hookCommand.includes('${CLAUDE_PROJECT_DIR}')) {
          continue;
        }

        const hookScriptPath = hookCommand
          .replace('${CLAUDE_PROJECT_DIR}', repositoryRoot)
          .trim();
        referencedScriptPaths.add(hookScriptPath);

        if (!existsSync(hookScriptPath)) {
          reportViolation(
            settingsPath,
            `hook script does not exist: ${hookCommand}`,
          );
          continue;
        }

        try {
          execFileSync('bash', ['-n', hookScriptPath], { stdio: 'ignore' });
        } catch {
          reportViolation(
            hookScriptPath,
            'hook script has a bash syntax error — it would fail open at runtime',
          );
        }

        try {
          execFileSync('test', ['-x', hookScriptPath], { stdio: 'ignore' });
        } catch {
          reportViolation(
            hookScriptPath,
            'hook script is not executable (chmod +x)',
          );
        }
      }
    }
  }

  // An unreferenced script reads as an active guard to anyone browsing the
  // directory, which is exactly how a protection is believed to exist after it
  // was unwired.
  const hooksDirectory = join(claudeDirectory, 'hooks');
  if (!existsSync(hooksDirectory)) {
    return;
  }
  for (const entryName of readdirSync(hooksDirectory)) {
    if (!entryName.endsWith('.sh')) {
      continue;
    }
    const scriptPath = join(hooksDirectory, entryName);
    if (!referencedScriptPaths.has(scriptPath)) {
      reportViolation(
        scriptPath,
        'exists but no hook in settings.json invokes it — an unwired guard still reads as an active one. Register it or delete it',
      );
    }
  }
}

/**
 * Fixture table for `guard-dangerous-commands.sh`.
 *
 * A hook is the one piece of this directory that is real executable logic
 * rather than declarative configuration, so `bash -n` and `chmod +x` prove
 * nothing about whether it *decides* correctly. Every row here is a form that a
 * prefix-anchored `permissions.deny` rule cannot see, a regression from a
 * parser bug found while writing the guard, or an ordinary command that must
 * stay unprompted — a guard that blocks `yarn build` gets switched off within a
 * day, and then it protects nothing.
 */
const GUARD_HOOK_DECISION_FIXTURES: readonly {
  command: string;
  expected: string;
}[] = [
  // Human-owned Git writes hidden behind flags, wrappers, and separators.
  { command: 'git commit -m "x"', expected: 'deny' },
  { command: 'git -C /elsewhere commit -m x', expected: 'deny' },
  { command: 'yarn lint && git push origin main', expected: 'deny' },
  { command: 'timeout 30 git reset --hard origin/main', expected: 'deny' },
  { command: 'echo $(git stash)', expected: 'deny' },
  // Migration application behind environment runners the docs do not strip.
  { command: 'dotenv -e .env -- prisma migrate deploy', expected: 'deny' },
  { command: 'npx -y prisma migrate reset', expected: 'deny' },
  { command: 'yarn prisma:deploy', expected: 'deny' },
  { command: 'yarn prisma migrate dev', expected: 'deny' },
  // Publication and volume destruction.
  { command: 'sudo npm publish', expected: 'deny' },
  { command: 'docker volume rm app_pgdata', expected: 'deny' },
  { command: 'docker compose down -v', expected: 'deny' },
  { command: 'gh pr create --fill', expected: 'deny' },
  { command: 'dropdb app_local', expected: 'deny' },
  // Credential exposure through the shell, which Read() rules never see.
  { command: 'cat .env', expected: 'deny' },
  { command: 'grep DATABASE_URL .env', expected: 'deny' },
  { command: 'cat < .env', expected: 'deny' },
  { command: 'cat ~/.ssh/id_rsa', expected: 'deny' },
  { command: 'source .env', expected: 'deny' },
  // Unrecoverable removals.
  { command: 'rm -rf /', expected: 'deny' },
  { command: 'rm -rf ~', expected: 'deny' },
  // Dual-use: a human decides.
  { command: 'gh api /repos/o/r/pulls', expected: 'ask' },
  { command: 'psql -h localhost -c "select 1"', expected: 'ask' },
  { command: 'docker exec -it api sh', expected: 'ask' },
  { command: 'git branch -D feature/x', expected: 'ask' },
  { command: 'ls -la .env', expected: 'ask' },
  { command: 'rm -rf /usr', expected: 'ask' },
  // Ordinary work must never prompt.
  { command: 'yarn build', expected: 'allow' },
  { command: 'yarn test:e2e --testPathPattern users', expected: 'allow' },
  { command: 'yarn prisma:generate', expected: 'allow' },
  { command: 'git status --short', expected: 'allow' },
  { command: 'git log --oneline -20', expected: 'allow' },
  { command: 'git diff HEAD', expected: 'allow' },
  { command: 'cat .env.example', expected: 'allow' },
  { command: 'grep -n SERVICE_NAME .env.test', expected: 'allow' },
  { command: 'echo "remember to run git push yourself"', expected: 'allow' },
  { command: 'rm -rf node_modules', expected: 'allow' },
  { command: 'docker compose up -d', expected: 'allow' },
  { command: 'npx prisma generate', expected: 'allow' },
];

function validateGuardHookBehaviour(): void {
  const guardHookPath = join(
    claudeDirectory,
    'hooks',
    'guard-dangerous-commands.sh',
  );
  if (!existsSync(guardHookPath)) {
    return; // Absence is already reported by validateGitDenyMatchesGuardHook.
  }

  // Without jq the hook fails closed to `ask` on every input — correct at
  // runtime, but it would turn this table into forty identical failures that
  // say nothing about the guard. Report the missing prerequisite once instead.
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
  } catch {
    reportViolation(
      guardHookPath,
      'cannot be behaviour-tested because jq is not installed. The hook itself fails closed to a prompt without it, but its decisions are unverified here — install jq (brew install jq / apt-get install jq)',
    );
    return;
  }

  for (const fixture of GUARD_HOOK_DECISION_FIXTURES) {
    let hookOutput: string;
    try {
      hookOutput = execFileSync('bash', [guardHookPath], {
        input: JSON.stringify({ tool_input: { command: fixture.command } }),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (executionError) {
      reportViolation(
        guardHookPath,
        `crashed on \`${fixture.command}\` — a non-zero exit is treated as a non-blocking error, so the call would be ALLOWED: ${(executionError as Error).message.split('\n')[0]}`,
      );
      continue;
    }

    let actualDecision = 'allow';
    if (hookOutput.trim() !== '') {
      try {
        actualDecision =
          (
            JSON.parse(hookOutput) as {
              hookSpecificOutput?: { permissionDecision?: string };
            }
          ).hookSpecificOutput?.permissionDecision ?? 'allow';
      } catch {
        reportViolation(
          guardHookPath,
          `emitted output that is not a single JSON object for \`${fixture.command}\` — Claude Code cannot parse a decision from it, so the call would be ALLOWED: ${hookOutput.trim().slice(0, 120)}`,
        );
        continue;
      }
    }

    if (actualDecision !== fixture.expected) {
      reportViolation(
        guardHookPath,
        `decided \`${actualDecision}\` for \`${fixture.command}\`, expected \`${fixture.expected}\``,
      );
    }
  }
}

/**
 * The architectural idioms the skills assert must actually exist here. Build on
 * different foundations and this fails immediately, instead of quietly reviewing
 * the code against contracts it never had.
 */
function validateArchitecturalIdioms(): void {
  for (const idiom of ARCHITECTURAL_IDIOMS) {
    if (literalExistsInSource(idiom)) {
      continue;
    }
    reportViolation(
      join(claudeDirectory, 'skills'),
      `the skills describe \`${idiom}\` as a project idiom, but it appears nowhere in the code. Either the code moved, or this project was built on a different architecture than the skills describe — rewrite the affected skills to describe THIS repository, or drop the idiom from ARCHITECTURAL_IDIOMS with a note saying why`,
    );
  }
}

/**
 * The `## Consumers` table in `CLAUDE.md` must be filled in before the gates can
 * ask a meaningful question about contract changes.
 *
 * An unfilled table and a deliberately empty one look identical to every later
 * reader, and to the review gate — so "which consumers does this break?" gets
 * the answer "none" for the wrong reason. Failing here forces that to be a
 * decision instead of an oversight. Declaring `none — internal
 * only` satisfies it.
 */
const CONSUMERS_PLACEHOLDER_ROW = '_(none declared yet)_';

/** The template's own package name. A clone that still carries it has not been bootstrapped yet. */
const UNADOPTED_TEMPLATE_PACKAGE_NAME = 'nestjs-api';

/**
 * True while the repository is still the starter itself, or a clone nobody has
 * renamed yet. The project-specific checks stay quiet until then, so a fresh
 * clone ships with a green build — you have to be able to tell a real failure
 * from a ritual one, and a starter whose CI is red on day zero teaches you to
 * ignore it.
 */
function isUnrenamedStarterClone(): boolean {
  const packageManifestPath = join(repositoryRoot, 'package.json');
  if (!existsSync(packageManifestPath)) {
    return false;
  }
  const packageManifest = JSON.parse(
    readFileSync(packageManifestPath, 'utf8'),
  ) as { name?: string };
  return packageManifest.name === UNADOPTED_TEMPLATE_PACKAGE_NAME;
}

function validateConsumersTable(): void {
  const projectInstructionsPath = join(repositoryRoot, 'CLAUDE.md');
  if (!existsSync(projectInstructionsPath)) {
    return;
  }

  const fileContent = readFileSync(projectInstructionsPath, 'utf8');
  if (!fileContent.includes('## Consumers')) {
    reportViolation(
      projectInstructionsPath,
      'has no `## Consumers` section — the design, implement, and review gates all ask which consumers a contract change forces a matching change in, and without the table that question has no answer',
    );
    return;
  }

  if (
    fileContent.includes(CONSUMERS_PLACEHOLDER_ROW) &&
    !isUnrenamedStarterClone()
  ) {
    reportViolation(
      projectInstructionsPath,
      'the `## Consumers` table still holds its placeholder row. List every client that programs against this API, or state `_(none — internal only)_` and why. An unfilled table is indistinguishable from a deliberately empty one, so the review gate reads both as "no consumers"',
    );
  }
}

/**
 * A gate ends one way when a human typed its command and another way when it is
 * a `/work-item` stage. Getting that wrong is not cosmetic: a gate that offers
 * to continue inside the conductor turns one authorisation into a confirmation
 * at every stage boundary, which is the exact friction the two-mode split
 * removed. Nothing about that split is machine-checkable from behaviour — it
 * lives entirely in prose across seven files — so this check holds the prose
 * together.
 */
const HANDOFF_CONTRACT_RELATIVE_PATH = 'standards/gate-handoff.md';

const REQUIRED_HANDOFF_CONTRACT_SECTIONS = [
  {
    marker: '## 0. Establish the mode first',
    requirement:
      'the mode table that tells a gate whether it was invoked standalone or as a /work-item stage',
  },
  {
    marker: '## 5. Closing a gate in conductor mode',
    requirement:
      'the conductor-mode closing rules and the exhaustive list of what still stops a run mid-pipeline',
  },
];

/** A gate's handoff section must say which mode it is describing. */
const MODE_AWARE_TERMS = ['conductor', '/work-item'];

function validateHandoffModeContract(): void {
  const handoffContractPath = join(
    claudeDirectory,
    HANDOFF_CONTRACT_RELATIVE_PATH,
  );

  if (!existsSync(handoffContractPath)) {
    reportViolation(
      handoffContractPath,
      'missing — every gate skill defers its closing behaviour to this file, so without it each gate invents its own and the pipeline stops in different places depending on which gate ran',
    );
    return;
  }

  const handoffContract = readFileSync(handoffContractPath, 'utf8');

  REQUIRED_HANDOFF_CONTRACT_SECTIONS.forEach(({ marker, requirement }) => {
    if (!handoffContract.includes(marker)) {
      reportViolation(
        handoffContractPath,
        `has no \`${marker}\` section — it must document ${requirement}`,
      );
    }
  });

  const gateSkillFiles = listMarkdownFilesRecursively(
    join(claudeDirectory, 'skills'),
  ).filter(
    (filePath) =>
      basename(filePath) === 'SKILL.md' &&
      basename(dirname(filePath)).startsWith('gate-'),
  );

  gateSkillFiles.forEach((gateSkillFile) => {
    const gateSkill = readFileSync(gateSkillFile, 'utf8');
    if (!gateSkill.includes(HANDOFF_CONTRACT_RELATIVE_PATH)) {
      reportViolation(
        gateSkillFile,
        `does not reference \`.claude/${HANDOFF_CONTRACT_RELATIVE_PATH}\` — a gate that closes on its own restated rules is a second copy of the sequence, and a second copy drifts silently`,
      );
      return;
    }

    const handoffSectionIndex = gateSkill.lastIndexOf('Handoff');
    const handoffSection = gateSkill.slice(handoffSectionIndex).toLowerCase();
    const isModeAware = MODE_AWARE_TERMS.some((term) =>
      handoffSection.includes(term),
    );

    if (!isModeAware) {
      reportViolation(
        gateSkillFile,
        'its Handoff section never distinguishes standalone invocation from a /work-item stage. State both, or say plainly that the conductor does not route through this gate — an unqualified "offer to continue" makes an autonomous run stop and ask at every stage boundary',
      );
    }
  });

  const conductorSkillPath = join(
    claudeDirectory,
    'skills',
    'work-item',
    'SKILL.md',
  );

  if (!existsSync(conductorSkillPath)) {
    return;
  }

  const conductorSkill = readFileSync(conductorSkillPath, 'utf8');
  if (!conductorSkill.includes('## Autonomy contract')) {
    reportViolation(
      conductorSkillPath,
      "has no `## Autonomy contract` section — it must name the pipeline's only two human stops (plan approval and the Stage 6 present/push boundary) and the conditions that stop a run mid-pipeline. Without it the conductor inherits each gate's standalone closing behaviour and asks for permission it already has",
    );
  }
}

function main(): void {
  const skillFiles = listMarkdownFilesRecursively(
    join(claudeDirectory, 'skills'),
  ).filter((filePath) => basename(filePath) === 'SKILL.md');
  const agentFiles = listMarkdownFilesRecursively(
    join(claudeDirectory, 'agents'),
  );

  if (skillFiles.length === 0) {
    reportViolation(
      claudeDirectory,
      'no skills found — expected .claude/skills/*/SKILL.md',
    );
  }

  skillFiles.forEach(validateSkill);
  agentFiles.forEach(validateAgent);

  const crossReferencedFiles = [
    join(repositoryRoot, 'CLAUDE.md'),
    ...listMarkdownFilesRecursively(claudeDirectory),
  ].filter(existsSync);
  crossReferencedFiles.forEach(validateCrossReferences);

  validateSettingsAndHooks();
  validateGuardHookBehaviour();
  validateArchitecturalIdioms();
  validateConsumersTable();
  validateHandoffModeContract();

  const checkedCount =
    skillFiles.length + agentFiles.length + crossReferencedFiles.length;

  if (violations.length === 0) {
    console.log(
      `✔ Claude Code config valid — ${skillFiles.length} skills, ${agentFiles.length} agents, ` +
        `${crossReferencedFiles.length} markdown files cross-checked.`,
    );
    return;
  }

  console.error(
    `\n✘ Claude Code config has ${violations.length} problem(s):\n`,
  );
  for (const violation of violations) {
    console.error(`  ${violation.file}\n    ${violation.message}\n`);
  }
  console.error(
    `Checked ${checkedCount} files. Fix the above, then re-run \`yarn claude:validate\`.\n`,
  );
  process.exit(1);
}

main();
