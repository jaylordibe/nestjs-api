import type { Prisma } from '@prisma/client';

// Columns that must never reach `audit_logs.metadata`, whatever row is being
// snapshotted. The audit trail is readable by PLATFORM_SUPPORT and
// PLATFORM_DEVELOPER, not just admins, so a leaked hash is a leaked hash.
//
// Denylist rather than allowlist on purpose: a new sensitive column added to a
// model would otherwise be snapshotted by default until someone remembered to
// exclude it. Here, a new *non*-sensitive column is included by default, and a
// new sensitive one is a one-line addition — the failure mode of forgetting is
// "too little history", not "leaked credentials".
const REDACTED_COLUMNS: ReadonlySet<string> = new Set([
  'password',
  'otpHash',
  'otpPurpose',
  'otpExpiresAt',
  'token',
]);

/**
 * A JSON-safe copy of a row, for `AuditService.record({ metadata: { snapshot } })`.
 *
 * WHY: soft delete tells you a row is gone; it cannot tell you what it held, and
 * it says nothing at all about hard-deleted rows. Snapshotting on delete gives
 * the audit trail *what it was* alongside *who* did it and *when* — which is the
 * traceability soft delete is so often (wrongly) reached for.
 *
 * `Date` becomes an ISO string; `Buffer`/`Decimal` and other non-JSON values are
 * stringified by `JSON.stringify` the same way Prisma's `Json` column would
 * store them. Sensitive columns are dropped entirely rather than masked, so no
 * length or format is inferable.
 *
 * Takes `object` rather than `Record<string, unknown>`: a Prisma row is typed as
 * an interface, and interfaces have no index signature, so they are not
 * assignable to a Record. Widening here beats casting at every call site.
 */
export function buildAuditSnapshot(row: object): Prisma.InputJsonObject {
  const snapshot: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (REDACTED_COLUMNS.has(column)) continue;
    if (value === undefined) continue;
    snapshot[column] = value instanceof Date ? value.toISOString() : value;
  }
  return snapshot as Prisma.InputJsonObject;
}
