// The roles the seeder installs on every deployment, and the ONLY roles that
// exist. They are catalog-owned, unreachable by any write endpoint, and their
// permission sets are reconciled from ROLE_DEFINITION_CATALOG on every
// `yarn prisma:seed`.
//
// There is no `isSystem` flag on the row, because there is no other kind of
// role for it to distinguish.
//
// This list is CLOSED. There is no endpoint that creates, edits, or deletes a
// role — roles are code, reviewed like code, and deployed like code. An
// operator who needs a new capability set adds it here and ships it.
//
// There is deliberately NO "every registered user" role. A role granted to
// everyone and revocable by nobody is not a role, it is a baseline — and the
// baseline lives in AUTHENTICATED_USER_PERMISSIONS, which `AbilityFactory`
// injects for every authenticated caller. Most accounts therefore hold NO
// platform role, and that is the normal, fully-functional state.
export enum SeededRoleName {
  // ── Platform scope ─────────────────────────────────────────────────────
  // Governance. Assigns platform roles, administers users and businesses.
  PLATFORM_ADMIN = 'platform_admin',
  // Highest TECHNICAL authority: diagnostics, queue/worker investigation,
  // release operations. Deliberately holds no role-assignment power — the
  // separation between "can fix the system" and "can grant access" is the
  // point of splitting these two roles apart.
  PLATFORM_ENGINEER = 'platform_engineer',
  // Escalated technical support: investigates incidents and retries failed
  // work, but sees no raw job payloads and performs nothing destructive.
  PLATFORM_TECHNICAL_SUPPORT = 'platform_technical_support',
  // Customer-facing support: account status, verification resends, unlocks,
  // session revocation. No infrastructure access.
  PLATFORM_APP_SUPPORT = 'platform_app_support',

  // ── Business scope ─────────────────────────────────────────────────────
  // Assigned through a `business_memberships` row, never `user_roles`.
  BUSINESS_OWNER = 'business_owner',
  BUSINESS_ADMIN = 'business_admin',
  BUSINESS_MANAGER = 'business_manager',
  BUSINESS_MEMBER = 'business_member',
  // A customer of the business. A membership role like any other, which is
  // what makes one-role-per-business true: a person is staff OR a customer
  // of a given business, never both.
  BUSINESS_CUSTOMER = 'business_customer',
}
