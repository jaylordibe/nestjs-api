import { AuditLog, Prisma } from '@prisma/client';

// Public shape of a user reference embedded in an audit-log row. Narrow on
// purpose — never the full User, which carries the password hash, OTP fields
// and lockout counters.
export interface AuditLogUserRef {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  // Platform role names the user holds RIGHT NOW — not when the action was
  // recorded. `user_roles` is mutable current state and `audit_logs` has no
  // snapshot of it, so this answers "who is this person?" (the triage question
  // an operator scanning a list actually has) and NOT "what were they allowed
  // to do at the time?".
  //
  // Never reason about historical authority from this field. Where a role was
  // material to a decision, the action that recorded it puts the role in
  // `metadata`, which IS point-in-time.
  //
  // Business-scoped memberships are excluded: they are per-business, so a flat
  // list would be meaningless without saying which business.
  roles: string[];
}

// Hydration source from the service. `actor` / `targetUser` are looked up
// separately — `audit_logs` has no FK to users, see the service for why — and
// may be null when the referenced user is missing, GDPR-erased, or never
// existed (metadata-only entries recording an attempt by no one).
export type AuditLogRow = AuditLog & {
  actor?: AuditLogUserRef | null;
  targetUser?: AuditLogUserRef | null;
};

export class AuditLogResponseDto {
  id!: string;
  createdAt!: Date;
  action!: string;
  // Server-vouched request envelope (requestId, ip, userAgent, parsed
  // browser/os/device, Cloudflare country) merged in by AuditService, plus
  // whatever context the recording action passed.
  metadata!: Prisma.JsonValue | null;
  // Raw FK columns, kept on the wire so a client can render a "show this user"
  // link without depending on the hydrated ref — which is best-effort and goes
  // null once the user row is gone.
  actorId!: string | null;
  targetUserId!: string | null;
  // Hydrated references. Null when the corresponding `*Id` is null OR the user
  // row no longer exists.
  actor!: AuditLogUserRef | null;
  targetUser!: AuditLogUserRef | null;

  // Field-by-field rather than `Object.assign`: the hydrated refs are optional
  // on the source type, and assigning wholesale would leave them `undefined`
  // — dropped entirely by JSON serialization — instead of the explicit `null`
  // a client can branch on.
  constructor(row: AuditLogRow) {
    this.id = row.id;
    this.createdAt = row.createdAt;
    this.action = row.action;
    this.metadata = row.metadata;
    this.actorId = row.actorId;
    this.targetUserId = row.targetUserId;
    this.actor = row.actor ?? null;
    this.targetUser = row.targetUser ?? null;
  }
}
