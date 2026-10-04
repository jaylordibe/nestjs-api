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
  // Governance. Assigns platform roles, administers users and workspaces.
  PLATFORM_ADMIN = 'platform_admin',
  // Highest TECHNICAL authority: diagnostics, queue/worker investigation,
  // release operations. Deliberately holds no role-assignment power — the
  // separation between "can fix the system" and "can grant access" is the
  // point of splitting these two roles apart.
  PLATFORM_ENGINEER = 'platform_engineer',
  // Escalated technical support: investigates incidents and retries failed
  // work, but sees no raw job payloads and performs nothing destructive.
  PLATFORM_TECHNICAL_SUPPORT = 'platform_technical_support',
  // Customer-facing support: account status, verification resends,
  // session revocation. No infrastructure access.
  PLATFORM_APP_SUPPORT = 'platform_app_support',

  // ── Workspace scope ─────────────────────────────────────────────────────
  // Assigned through a `workspace_memberships` row, never `user_roles`.
  WORKSPACE_OWNER = 'workspace_owner',
  WORKSPACE_ADMIN = 'workspace_admin',
  WORKSPACE_MANAGER = 'workspace_manager',
  WORKSPACE_MEMBER = 'workspace_member',
}
