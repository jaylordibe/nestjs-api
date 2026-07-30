// CI dependency-audit gate.
//
// Why this exists instead of the old one-liner
// (`yarn audit --level high || test $? -lt 8`):
// yarn 1.x's audit has no way to accept a *specific* advisory, so a single
// unfixable high finding would permanently red-light the `quality` job — the
// classic pressure to just delete the gate. This script keeps the gate hard
// (any high/critical fails the build) while allowing a *documented, dated*
// exception per advisory, and it actively nags when an exception has gone
// stale (the advisory is no longer present, so the entry should be removed) or
// has passed its review date. Dependency-free on purpose: adding an audit tool
// would add its own dependency tree — and its own audit surface.
//
// Usage: node .github/scripts/audit-gate.mjs <path-to-yarn-audit-json>
// The JSON is the newline-delimited output of `yarn audit --json`.

import { readFileSync } from 'node:fs';

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

// Advisories consciously accepted, with the rationale in-line so the next
// reader (or auditor) sees *why* without digging through git history. Match is
// by GitHub advisory id, CVE, or yarn's numeric id — whichever the tooling
// reports. Keep `reviewBy` realistic: once it passes, the gate warns so the
// exception gets re-justified rather than silently outliving its reason.
//
// EMPTY BY DEFAULT, and it should stay that way as long as possible. An
// allowlist entry is the LAST rung of the ladder, not the first:
//
//   1. `yarn upgrade <parent>` — most advisories are satisfied by a version the
//      parent's declared range ALREADY permits, i.e. the lockfile is stale
//      rather than the upstream constraint being real. Costs nothing and
//      leaves package.json untouched.
//   2. A `resolutions` override — only when a parent genuinely pins a
//      vulnerable range. Note next to it when it can be removed.
//   3. An entry here — only when NO compatible patched version exists at all
//      (e.g. the only fix is ESM-only on a CJS require chain).
//
// Diagnose which rung you are on with:
//   yarn audit --level high --json       → module, vulnerable_versions, path
//   npm view <parent> dependencies.<pkg> → does its range allow the fix?
//
// Shape of an entry:
//
//   {
//     ids: ['GHSA-xxxx-xxxx-xxxx', 'CVE-2026-00000', '1234567'],
//     package: 'some-package',
//     reason:
//       'What the vulnerability is, why no upgrade path exists, and why it is ' +
//       'not exploitable in THIS codebase. Be specific — "low risk" is not a ' +
//       'rationale.',
//     reviewBy: '2026-12-31',
//   }
const ALLOWLISTED_ADVISORIES = [
  {
    ids: ['GHSA-mh99-v99m-4gvg', 'CVE-2026-14257', '1124334'],
    package: 'brace-expansion',
    reason:
      'DoS via unbounded brace expansion. The only patched line is 5.0.8+, and the ' +
      'transitive CJS minimatch versions that pull this in declare incompatible ' +
      'ranges — minimatch@3 wants ^1.1.7, minimatch@5 wants ^2.0.1 — so no in-range ' +
      'bump reaches the fix. Forcing it via resolutions was TRIED and breaks eslint ' +
      "outright (crash in eslint-helpers' globMultiSearch), because 5.x changed to " +
      'named exports. No 1.x/2.x backport exists. Not exploitable here: every path ' +
      'to it is dev tooling — eslint, typescript-eslint, jest, @nestjs/cli — none of ' +
      'which ships in the pruned runtime image, and the brace patterns reached are ' +
      'internal lint/test globs, never attacker input.',
    reviewBy: '2026-12-31',
  },
];

const auditJsonPath = process.argv[2];
if (!auditJsonPath) {
  console.error('audit-gate: missing path to yarn audit JSON output');
  process.exit(2);
}

const advisoryLines = readFileSync(auditJsonPath, 'utf8')
  .split('\n')
  .filter(Boolean);

const blockingAdvisories = new Map();
for (const advisoryLine of advisoryLines) {
  let parsedLine;
  try {
    parsedLine = JSON.parse(advisoryLine);
  } catch {
    continue; // yarn interleaves non-advisory summary lines; skip them.
  }
  if (parsedLine.type !== 'auditAdvisory') continue;

  const advisory = parsedLine.data.advisory;
  if (!BLOCKING_SEVERITIES.has(advisory.severity)) continue;

  const advisoryKey = advisory.github_advisory_id || String(advisory.id);
  blockingAdvisories.set(advisoryKey, {
    severity: advisory.severity,
    package: advisory.module_name,
    identifiers: [
      advisory.github_advisory_id,
      String(advisory.id),
      ...(advisory.cves ?? []),
    ].filter(Boolean),
  });
}

const matchesAllowlistEntry = (advisory, allowlistEntry) =>
  advisory.identifiers.some((identifier) =>
    allowlistEntry.ids.includes(identifier),
  );

const acceptedAdvisories = [];
const unacceptedAdvisories = [];
for (const advisory of blockingAdvisories.values()) {
  const allowlistEntry = ALLOWLISTED_ADVISORIES.find((entry) =>
    matchesAllowlistEntry(advisory, entry),
  );
  if (allowlistEntry) {
    acceptedAdvisories.push({ advisory, allowlistEntry });
  } else {
    unacceptedAdvisories.push(advisory);
  }
}

for (const { advisory, allowlistEntry } of acceptedAdvisories) {
  const isPastReview =
    allowlistEntry.reviewBy < new Date().toISOString().slice(0, 10);
  const reviewNote = isPastReview
    ? ' (REVIEW OVERDUE — re-justify or remove)'
    : '';
  console.log(
    `audit-gate: allowing ${advisory.severity} ${advisory.package} ` +
      `[${allowlistEntry.ids.join(', ')}] until ${allowlistEntry.reviewBy}${reviewNote}`,
  );
}

// A stale allowlist entry (its advisory no longer appears) is a smell: the
// exception outlived the vulnerability. Surface it, but don't fail the build
// on it alone — the entry is harmless until someone prunes it.
const staleAllowlistEntries = ALLOWLISTED_ADVISORIES.filter(
  (entry) =>
    !acceptedAdvisories.some(({ allowlistEntry }) => allowlistEntry === entry),
);
for (const staleEntry of staleAllowlistEntries) {
  console.log(
    `audit-gate: allowlist entry for ${staleEntry.package} [${staleEntry.ids.join(', ')}] ` +
      `no longer matches any finding — remove it from audit-gate.mjs`,
  );
}

if (unacceptedAdvisories.length > 0) {
  console.error(
    `\naudit-gate: ${unacceptedAdvisories.length} un-allowlisted high/critical ` +
      `advisory(ies) — failing the build:`,
  );
  for (const advisory of unacceptedAdvisories) {
    console.error(
      `  - ${advisory.severity} ${advisory.package} [${advisory.identifiers.join(', ')}]`,
    );
  }
  console.error(
    '\nFix by upgrading (prefer an in-range parent bump over a resolutions override), ' +
      'or, only if genuinely unfixable, add a documented+dated entry to ' +
      'ALLOWLISTED_ADVISORIES in this file.',
  );
  process.exit(1);
}

console.log('\naudit-gate: no un-allowlisted high/critical advisories. OK.');
