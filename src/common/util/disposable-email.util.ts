import disposableDomains from 'disposable-email-domains';
import wildcardDomains from 'disposable-email-domains/wildcard.json';

// Single source of truth for "is this email a disposable / temporary
// address?". Use from the runtime auth checks (register + login) and any
// operator cleanup script so every code path shares the exact same domain
// list + matching rules — drift between them would let a "blocked" domain
// slip back in on the next signup.
//
// Backed by the `disposable-email-domains` npm package
// (https://github.com/ivolo/disposable-email-domains) — ~120k exact
// domains + ~400 wildcard bases, weekly updated. Bump the dep to pull in
// new providers.

// Frozen Sets for O(1) lookups. Built once at module load; the
// ~120k-domain exact set is the only meaningful one-time cost.
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set(disposableDomains);
const DISPOSABLE_WILDCARD_DOMAINS: ReadonlySet<string> = new Set(
  wildcardDomains,
);

// Operator overrides on top of the public package. Committed in code (not
// env vars) so additions go through PR review, leave a git audit trail, and
// can't drift between environments. Both lists apply across every env.
//
// `OPERATOR_ALLOWLIST` — domains the public list flags as disposable but you
// know to be legitimate. False-positive escape hatch.
//
// `OPERATOR_DENYLIST` — domains observed used for throwaway signups but the
// public list hasn't caught yet. Open a PR upstream
// (https://github.com/ivolo/disposable-email-domains) for each entry so other
// consumers benefit; this denylist is the immediate stopgap until the dep
// bump propagates.
//
// Add domains lowercase, exact match (no wildcards — contribute wildcard
// patterns upstream where wildcard.json already supports them).
const OPERATOR_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // Add domains here, e.g.: 'partner.example.com',
]);
const OPERATOR_DENYLIST: ReadonlySet<string> = new Set<string>([
  // Add domains here, e.g.: 'observed-throwaway.example',
]);

// Extracts the lowercased domain from an email. Returns null when the input
// doesn't have exactly one `@` with non-empty parts on either side —
// `@IsEmail()` should catch that upstream, so the null branch is only
// reachable for direct util consumers (a cleanup script processing legacy
// rows).
export function extractEmailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  if (trimmed.indexOf('@', at + 1) !== -1) return null;
  return trimmed.slice(at + 1);
}

// True if `email` is on a known disposable / temporary email provider.
//
// Matching order:
//   1. `OPERATOR_ALLOWLIST` short-circuit (false) — false-positive escape
//      hatch wins over every other classification.
//   2. `OPERATOR_DENYLIST` short-circuit (true) — emerging-abuse stopgap,
//      ahead of the public list.
//   3. Exact match against the public list (`mailinator.com`,
//      `10minutemail.com`, …).
//   4. Wildcard match — `domain` itself, or any suffix walked
//      label-by-label, present in the wildcard base set. Covers
//      `anonaddy.com` AND `foo.anonaddy.com` from one wildcard entry.
//
// Wildcard walk is O(d) on the number of dots in the domain (typically 2–4)
// with O(1) Set lookup at each step.
export function isDisposableEmail(email: string): boolean {
  const domain = extractEmailDomain(email);
  if (!domain) return false;
  if (OPERATOR_ALLOWLIST.has(domain)) return false;
  if (OPERATOR_DENYLIST.has(domain)) return true;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  const parts = domain.split('.');
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join('.');
    if (DISPOSABLE_WILDCARD_DOMAINS.has(suffix)) return true;
  }
  return false;
}
