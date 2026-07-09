import type { AuthorizationSubject } from './permission-catalog';

// ─────────────────────────────────────────────────────────────────────────
// The "where" half of the authorization model.
//
// A permission row says WHAT a role may do. These two maps say WHERE that
// authority reaches, by naming the column that ties a subject back to its
// owning user or its owning business. `AbilityFactory` reads them to build
// the CASL condition; nothing else does.
// ─────────────────────────────────────────────────────────────────────────

// Which column ties a subject to the user who owns it. Used for
// PLATFORM + OWN permissions (`{ [key]: actingUserId }`).
//
// `Business` is deliberately absent: business ownership is a
// `business_members` row with the BUSINESS_OWNER role, not authorship of the
// record. Keying it off `createdBy` would let a creator who has since been
// removed from the roster keep owner powers forever.
export const SUBJECT_OWNER_KEY = {
  User: 'id',
  DeviceToken: 'userId',
  // A customer owns their own relationship to a business.
  BusinessCustomer: 'userId',
} as const satisfies Partial<Record<AuthorizationSubject, string>>;

// Which column ties a subject to the business that owns it. Used for every
// BUSINESS-scope permission (`{ [key]: businessId }`).
//
// EVERY business-scoped model added to this template registers its tenant key
// here — one line — and is then covered by `AbilityScopedQueryService`. A model
// that is missing from this map cannot be used with a business-scoped
// permission: `resolveTenantKey` throws at ability-build time rather than
// silently producing an unconditional rule.
export const SUBJECT_TENANT_KEY = {
  Business: 'id',
  BusinessMember: 'businessId',
  // …and the business owns its customer list. `BusinessCustomer` is the first
  // subject in BOTH maps: a customer reaches their own record via `userId`,
  // while staff reach every record in their tenant via `businessId`. The two
  // rules OR-compose, which is exactly right.
  BusinessCustomer: 'businessId',
} as const satisfies Partial<Record<AuthorizationSubject, string>>;

export type OwnableSubject = keyof typeof SUBJECT_OWNER_KEY;
export type TenantScopedSubject = keyof typeof SUBJECT_TENANT_KEY;

export function isOwnableSubject(
  subject: AuthorizationSubject,
): subject is OwnableSubject {
  return subject in SUBJECT_OWNER_KEY;
}

export function isTenantScopedSubject(
  subject: AuthorizationSubject,
): subject is TenantScopedSubject {
  return subject in SUBJECT_TENANT_KEY;
}

// Fail loudly rather than degrade to an unconditional rule. A missing entry
// means someone granted an `own`/business-scoped permission on a subject that
// has no column to scope it by — that must never quietly become "allow all".
export function resolveOwnerKey(subject: AuthorizationSubject): string {
  if (!isOwnableSubject(subject)) {
    throw new Error(
      `Subject "${subject}" has an ownership-scoped permission but no entry in ` +
        `SUBJECT_OWNER_KEY. Add its owning-user column to src/common/authorization/subject-key.ts.`,
    );
  }
  return SUBJECT_OWNER_KEY[subject];
}

export function resolveTenantKey(subject: AuthorizationSubject): string {
  if (!isTenantScopedSubject(subject)) {
    throw new Error(
      `Subject "${subject}" has a business-scoped permission but no entry in ` +
        `SUBJECT_TENANT_KEY. Add its owning-business column to src/common/authorization/subject-key.ts.`,
    );
  }
  return SUBJECT_TENANT_KEY[subject];
}
