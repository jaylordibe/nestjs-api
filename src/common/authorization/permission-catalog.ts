import { PermissionOwnership } from '../enums/permission-ownership.enum';
import { RoleScope } from '../enums/role-scope.enum';
import { SeededRoleName } from '../enums/seeded-role-name.enum';
import { toSnakeCase } from '../util/string-case.util';

// ─────────────────────────────────────────────────────────────────────────
// THE authorization catalog. Single source of truth for:
//
//   1. the compile-time types behind `@RequirePermission(action, subject)`,
//   2. the `permissions` / `roles` / `role_permissions` rows the seeder writes,
//   3. the CASL rules `AbilityFactory` compiles per request.
//
// The database is a *projection* of this file — never hand-edit permission
// rows. `PermissionCatalogIntegrityService` refuses to boot the app if the
// two ever disagree, and `yarn rbac:check` asserts the same thing in CI.
//
// Central design rule: a permission row records WHAT (action + subject).
// It never records a condition. `AbilityFactory` derives the WHERE from
// `scope` + `ownership` + request context. See `subject-key.ts`.
// ─────────────────────────────────────────────────────────────────────────

// `manage` is CASL's wildcard: it matches every other action on the subject.
// Grant it deliberately — `manage BusinessMember` silently includes
// `assignRole`, which is how privilege-escalation holes get opened.
export const AUTHORIZATION_ACTIONS = [
  'manage',
  'create',
  'read',
  'update',
  'delete',
  // Distinct from `update` on purpose. Resetting another user's password
  // bypasses the current-password re-authentication that `/users/me/password`
  // demands, so it must be grantable independently of ordinary profile edits.
  'resetPassword',
  // Distinct from `update` for the same reason: handing out roles is how
  // privilege escalation happens, and `manage` (CASL's wildcard) would
  // silently include it.
  'assignRole',
] as const;
export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];

// Subject names are exactly the Prisma model names, plus CASL's `all`
// wildcard. Keeping them identical is what lets `accessibleBy(...).ofType(subject)`
// resolve to that model's Prisma `WhereInput`.
export const AUTHORIZATION_SUBJECTS = [
  'all',
  'User',
  'Business',
  'BusinessMember',
  'BusinessCustomer',
  'Role',
  'Permission',
  'AppVersion',
  'DeviceToken',
  'AuditLog',
] as const;
export type AuthorizationSubject = (typeof AUTHORIZATION_SUBJECTS)[number];

export interface PermissionDefinition {
  readonly action: AuthorizationAction;
  readonly subject: AuthorizationSubject;
  readonly scope: RoleScope;
  readonly ownership: PermissionOwnership;
  readonly description: string;
}

// `platform.user.update.own`, `business.business_member.assign_role`,
// `platform.all.manage`. The `.own` suffix is omitted for ANY so the common
// case reads cleanly. This is the `permissions.name` unique key, and the
// identity function shared by the catalog, the seeder, and the integrity check.
export function permissionName(
  definition: Pick<
    PermissionDefinition,
    'scope' | 'action' | 'subject' | 'ownership'
  >,
): string {
  const segments = [
    definition.scope,
    toSnakeCase(definition.subject),
    toSnakeCase(definition.action),
  ];
  if (definition.ownership === PermissionOwnership.OWN) {
    segments.push('own');
  }
  return segments.join('.');
}

// Terse constructors so the catalog below reads as a table rather than as
// a wall of object literals.
const platform = (
  action: AuthorizationAction,
  subject: AuthorizationSubject,
  ownership: PermissionOwnership,
  description: string,
): PermissionDefinition => ({
  action,
  subject,
  scope: RoleScope.PLATFORM,
  ownership,
  description,
});

// Business-scoped permissions are always ANY: their condition is the tenant
// (supplied from the caller's `business_members` row), not the acting user.
const business = (
  action: AuthorizationAction,
  subject: AuthorizationSubject,
  description: string,
): PermissionDefinition => ({
  action,
  subject,
  scope: RoleScope.BUSINESS,
  ownership: PermissionOwnership.ANY,
  description,
});

const { OWN, ANY } = PermissionOwnership;

// ── Platform scope ───────────────────────────────────────────────────────
const MANAGE_EVERYTHING = platform(
  'manage',
  'all',
  ANY,
  'Unrestricted control over every resource on the platform',
);
const READ_ANY_USER = platform('read', 'User', ANY, 'View any user account');
const CREATE_ANY_USER = platform('create', 'User', ANY, 'Create user accounts');
const UPDATE_ANY_USER = platform(
  'update',
  'User',
  ANY,
  'Edit any user account',
);
const DELETE_ANY_USER = platform(
  'delete',
  'User',
  ANY,
  'Delete any user account',
);
const RESET_ANY_USER_PASSWORD = platform(
  'resetPassword',
  'User',
  ANY,
  "Reset another user's password without their current password",
);
const MANAGE_ANY_DEVICE_TOKEN = platform(
  'manage',
  'DeviceToken',
  ANY,
  "Administer any user's push-notification device tokens",
);
const READ_ANY_AUDIT_LOG = platform(
  'read',
  'AuditLog',
  ANY,
  'View the platform audit trail',
);
const READ_ANY_BUSINESS = platform(
  'read',
  'Business',
  ANY,
  'View any business on the platform',
);
const MANAGE_ANY_APP_VERSION = platform(
  'manage',
  'AppVersion',
  ANY,
  'Publish and edit mobile app version records',
);
const CREATE_BUSINESS = platform(
  'create',
  'Business',
  ANY,
  'Create a new business (the creator becomes its owner)',
);

// The role/permission catalogue is not sensitive — it is a vocabulary, much
// like `GET /enums`. Every user can read it, because a business owner needs a
// `roleId` before they can add anyone to their roster.
const READ_ROLE = platform('read', 'Role', ANY, 'List the available roles');
const CREATE_ROLE = platform('create', 'Role', ANY, 'Define a custom role');
const UPDATE_ROLE = platform(
  'update',
  'Role',
  ANY,
  "Edit a custom role's details and permission set",
);
const DELETE_ROLE = platform('delete', 'Role', ANY, 'Delete a custom role');
const READ_PERMISSION = platform(
  'read',
  'Permission',
  ANY,
  'List the permissions a role can grant',
);
const ASSIGN_PLATFORM_ROLE = platform(
  'assignRole',
  'User',
  ANY,
  'Grant or revoke a platform-scope role on a user account',
);

const READ_OWN_USER = platform('read', 'User', OWN, 'View your own profile');
const UPDATE_OWN_USER = platform(
  'update',
  'User',
  OWN,
  'Edit your own profile',
);
const DELETE_OWN_USER = platform(
  'delete',
  'User',
  OWN,
  'Delete your own account',
);
const MANAGE_OWN_DEVICE_TOKEN = platform(
  'manage',
  'DeviceToken',
  OWN,
  'Register and remove your own push-notification device tokens',
);

// A customer's side of the relationship. Ownership-scoped, so these grant
// nothing over the business itself — only over the caller's own record.
const CREATE_OWN_BUSINESS_CUSTOMER = platform(
  'create',
  'BusinessCustomer',
  OWN,
  'Become a customer of a business',
);
const READ_OWN_BUSINESS_CUSTOMER = platform(
  'read',
  'BusinessCustomer',
  OWN,
  'View your own customer relationship with a business',
);
const DELETE_OWN_BUSINESS_CUSTOMER = platform(
  'delete',
  'BusinessCustomer',
  OWN,
  'End your own customer relationship with a business',
);

// ── Business scope ───────────────────────────────────────────────────────
const MANAGE_BUSINESS = business(
  'manage',
  'Business',
  'Unrestricted control over the business, including deleting it',
);
const READ_BUSINESS = business('read', 'Business', 'View the business');
const UPDATE_BUSINESS = business(
  'update',
  'Business',
  'Edit the business profile and settings',
);
const MANAGE_BUSINESS_MEMBER = business(
  'manage',
  'BusinessMember',
  'Unrestricted control over the business roster, including role assignment',
);
const READ_BUSINESS_MEMBER = business(
  'read',
  'BusinessMember',
  'View the business roster',
);
const CREATE_BUSINESS_MEMBER = business(
  'create',
  'BusinessMember',
  'Add an existing user to the business roster',
);
const UPDATE_BUSINESS_MEMBER = business(
  'update',
  'BusinessMember',
  'Edit a roster entry',
);
const DELETE_BUSINESS_MEMBER = business(
  'delete',
  'BusinessMember',
  'Remove a member from the business roster',
);
const ASSIGN_ROLE_BUSINESS_MEMBER = business(
  'assignRole',
  'BusinessMember',
  "Change a member's role within the business (bounded by the rank guard)",
);

// The business's side of the relationship: its customer list, scoped to the
// tenant. `manage` is safe here — BusinessCustomer has no assignRole action.
const MANAGE_BUSINESS_CUSTOMER = business(
  'manage',
  'BusinessCustomer',
  'Unrestricted control over the business customer list',
);
const READ_BUSINESS_CUSTOMER = business(
  'read',
  'BusinessCustomer',
  'View the business customer list',
);
const CREATE_BUSINESS_CUSTOMER = business(
  'create',
  'BusinessCustomer',
  'Register an existing user as a customer of the business',
);
const UPDATE_BUSINESS_CUSTOMER = business(
  'update',
  'BusinessCustomer',
  'Annotate a customer record (notes, active flag)',
);
const DELETE_BUSINESS_CUSTOMER = business(
  'delete',
  'BusinessCustomer',
  'Remove a customer from the business',
);

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  MANAGE_EVERYTHING,
  READ_ANY_USER,
  CREATE_ANY_USER,
  UPDATE_ANY_USER,
  DELETE_ANY_USER,
  RESET_ANY_USER_PASSWORD,
  MANAGE_ANY_DEVICE_TOKEN,
  READ_ANY_AUDIT_LOG,
  READ_ANY_BUSINESS,
  MANAGE_ANY_APP_VERSION,
  CREATE_BUSINESS,
  READ_ROLE,
  CREATE_ROLE,
  UPDATE_ROLE,
  DELETE_ROLE,
  READ_PERMISSION,
  ASSIGN_PLATFORM_ROLE,
  READ_OWN_USER,
  UPDATE_OWN_USER,
  DELETE_OWN_USER,
  MANAGE_OWN_DEVICE_TOKEN,
  CREATE_OWN_BUSINESS_CUSTOMER,
  READ_OWN_BUSINESS_CUSTOMER,
  DELETE_OWN_BUSINESS_CUSTOMER,
  MANAGE_BUSINESS,
  READ_BUSINESS,
  UPDATE_BUSINESS,
  MANAGE_BUSINESS_MEMBER,
  READ_BUSINESS_MEMBER,
  CREATE_BUSINESS_MEMBER,
  UPDATE_BUSINESS_MEMBER,
  DELETE_BUSINESS_MEMBER,
  ASSIGN_ROLE_BUSINESS_MEMBER,
  MANAGE_BUSINESS_CUSTOMER,
  READ_BUSINESS_CUSTOMER,
  CREATE_BUSINESS_CUSTOMER,
  UPDATE_BUSINESS_CUSTOMER,
  DELETE_BUSINESS_CUSTOMER,
] as const;

export interface RoleDefinition {
  readonly scope: RoleScope;
  // Orders roles for the escalation guard ONLY: you may never assign a role
  // whose rank is >= your own. It does NOT imply inherited permissions —
  // every role's grants are listed explicitly below. Conflating "outranks"
  // with "inherits" is how RBAC systems rot.
  readonly rank: number;
  readonly description: string;
  readonly permissions: readonly PermissionDefinition[];
}

export const ROLE_DEFINITION_CATALOG: Readonly<
  Record<SeededRoleName, RoleDefinition>
> = {
  [SeededRoleName.PLATFORM_ADMIN]: {
    scope: RoleScope.PLATFORM,
    rank: 100,
    description: 'Full control over the platform and every business on it',
    permissions: [MANAGE_EVERYTHING],
  },
  [SeededRoleName.PLATFORM_SUPPORT]: {
    scope: RoleScope.PLATFORM,
    rank: 50,
    // Read-only by design. `UPDATE_ANY_USER` and `RESET_ANY_USER_PASSWORD`
    // exist in the catalog and can be granted to a custom role, but shipping
    // them to support by default would let any support account change a
    // customer's email and take over the account. Start closed; widen
    // deliberately.
    description:
      'Customer-support staff: read users, businesses, and the audit trail',
    permissions: [READ_ANY_USER, READ_ANY_AUDIT_LOG, READ_ANY_BUSINESS],
  },
  [SeededRoleName.PLATFORM_DEVELOPER]: {
    scope: RoleScope.PLATFORM,
    rank: 50,
    description: 'Engineering staff: manage app releases, read the audit trail',
    permissions: [MANAGE_ANY_APP_VERSION, READ_ANY_AUDIT_LOG],
  },
  [SeededRoleName.PLATFORM_USER]: {
    scope: RoleScope.PLATFORM,
    rank: 10,
    description:
      'Every registered user. Self-service over their own account, and the ability to start a business',
    permissions: [
      READ_OWN_USER,
      UPDATE_OWN_USER,
      DELETE_OWN_USER,
      MANAGE_OWN_DEVICE_TOKEN,
      CREATE_BUSINESS,
      // A customer's own side of a business relationship. Grants no authority
      // over the business itself.
      CREATE_OWN_BUSINESS_CUSTOMER,
      READ_OWN_BUSINESS_CUSTOMER,
      DELETE_OWN_BUSINESS_CUSTOMER,
      // Needed to pick a `roleId` when adding someone to a business roster.
      READ_ROLE,
      READ_PERMISSION,
    ],
  },

  [SeededRoleName.BUSINESS_OWNER]: {
    scope: RoleScope.BUSINESS,
    rank: 100,
    description: 'Owns the business. Unrestricted within it',
    permissions: [
      MANAGE_BUSINESS,
      MANAGE_BUSINESS_MEMBER,
      MANAGE_BUSINESS_CUSTOMER,
    ],
  },
  [SeededRoleName.BUSINESS_ADMIN]: {
    scope: RoleScope.BUSINESS,
    rank: 70,
    // Explicit verbs, NOT `manage BusinessMember` — `manage` is CASL's
    // wildcard and would grant `assignRole` with no ceiling, letting an
    // admin promote itself to owner. The rank guard bounds which roles it
    // may actually hand out.
    description: 'Administers the business and its roster, below the owner',
    permissions: [
      READ_BUSINESS,
      UPDATE_BUSINESS,
      READ_BUSINESS_MEMBER,
      CREATE_BUSINESS_MEMBER,
      UPDATE_BUSINESS_MEMBER,
      DELETE_BUSINESS_MEMBER,
      ASSIGN_ROLE_BUSINESS_MEMBER,
      READ_BUSINESS_CUSTOMER,
      CREATE_BUSINESS_CUSTOMER,
      UPDATE_BUSINESS_CUSTOMER,
      DELETE_BUSINESS_CUSTOMER,
    ],
  },
  [SeededRoleName.BUSINESS_MANAGER]: {
    scope: RoleScope.BUSINESS,
    rank: 40,
    description:
      'Runs day-to-day operations; can add staff but not assign roles',
    permissions: [
      READ_BUSINESS,
      UPDATE_BUSINESS,
      READ_BUSINESS_MEMBER,
      CREATE_BUSINESS_MEMBER,
      READ_BUSINESS_CUSTOMER,
      CREATE_BUSINESS_CUSTOMER,
      UPDATE_BUSINESS_CUSTOMER,
    ],
  },
  [SeededRoleName.BUSINESS_STAFF]: {
    scope: RoleScope.BUSINESS,
    rank: 10,
    description: 'Read-only access to the business and its roster',
    permissions: [READ_BUSINESS, READ_BUSINESS_MEMBER, READ_BUSINESS_CUSTOMER],
  },
};
