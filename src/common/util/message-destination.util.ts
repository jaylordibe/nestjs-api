import { domainToASCII } from 'node:url';

// Gmail ignores dots in the local part and treats googlemail.com as gmail.com.
const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The form of an email address that a per-destination send limit counts
 * against: every spelling that lands in the same inbox maps to one value.
 *
 * Trimmed and lower-cased, a quoted local part unquoted, an internationalised
 * domain converted to its ASCII form, `+tag` sub-addressing removed, and for
 * Gmail the dots removed and `googlemail.com` folded into `gmail.com` — otherwise
 * `victim+1@…`, `v.ictim@…` and so on would each get their own budget. Used to
 * build a counter key ONLY: never stored, never sent to, never compared for
 * identity.
 */
export function canonicalEmailDestination(email: string): string {
  const normalized = email.trim().toLowerCase();
  const separatorIndex = normalized.lastIndexOf('@');
  if (separatorIndex <= 0) return normalized;

  let localPart = normalized.slice(0, separatorIndex);
  if (
    localPart.length > 1 &&
    localPart.startsWith('"') &&
    localPart.endsWith('"')
  ) {
    localPart = localPart.slice(1, -1);
  }
  let domain =
    domainToASCII(normalized.slice(separatorIndex + 1)) ||
    normalized.slice(separatorIndex + 1);

  const tagIndex = localPart.indexOf('+');
  if (tagIndex > 0) localPart = localPart.slice(0, tagIndex);

  if (DOT_INSENSITIVE_DOMAINS.has(domain)) {
    localPart = localPart.replaceAll('.', '');
    domain = 'gmail.com';
  }

  return `${localPart}@${domain}`;
}
