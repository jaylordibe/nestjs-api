import { PermissionOwnership } from '../enums/permission-ownership.enum';
import { RoleScope } from '../enums/role-scope.enum';
import { SeededRoleName } from '../enums/seeded-role-name.enum';
import {
  AUTHENTICATED_USER_PERMISSIONS,
  PERMISSION_CATALOG,
  ROLE_DEFINITION_CATALOG,
  permissionName,
} from './permission-catalog';
import { isOwnableSubject, isTenantScopedSubject } from './subject-key';

describe('permissionName', () => {
  it('derives a dotted lowercase slug, omitting the suffix for ANY', () => {
    expect(
      permissionName({
        scope: RoleScope.PLATFORM,
        subject: 'User',
        action: 'update',
        ownership: PermissionOwnership.ANY,
      }),
    ).toBe('platform.user.update');
  });

  it('appends `.own` for ownership-scoped permissions', () => {
    expect(
      permissionName({
        scope: RoleScope.PLATFORM,
        subject: 'DeviceToken',
        action: 'manage',
        ownership: PermissionOwnership.OWN,
      }),
    ).toBe('platform.device_token.manage.own');
  });

  it('snake-cases compound subjects and actions', () => {
    expect(
      permissionName({
        scope: RoleScope.BUSINESS,
        subject: 'BusinessMembership',
        action: 'assignRole',
        ownership: PermissionOwnership.ANY,
      }),
    ).toBe('business.business_membership.assign_role');
  });
});

describe('PERMISSION_CATALOG', () => {
  it('has no duplicate (scope, action, subject, ownership) tuples', () => {
    const names = PERMISSION_CATALOG.map(permissionName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('scopes every OWN permission to a subject with a known owner column', () => {
    for (const permission of PERMISSION_CATALOG) {
      if (permission.ownership === PermissionOwnership.OWN) {
        expect(isOwnableSubject(permission.subject)).toBe(true);
      }
    }
  });

  it('scopes every BUSINESS permission to a subject with a known tenant column', () => {
    for (const permission of PERMISSION_CATALOG) {
      if (permission.scope === RoleScope.BUSINESS) {
        expect(isTenantScopedSubject(permission.subject)).toBe(true);
      }
    }
  });

  it('marks every BUSINESS permission as ANY (its condition is the tenant)', () => {
    for (const permission of PERMISSION_CATALOG) {
      if (permission.scope === RoleScope.BUSINESS) {
        expect(permission.ownership).toBe(PermissionOwnership.ANY);
      }
    }
  });
});

describe('ROLE_DEFINITION_CATALOG', () => {
  const roleEntries = Object.entries(ROLE_DEFINITION_CATALOG) as Array<
    [SeededRoleName, (typeof ROLE_DEFINITION_CATALOG)[SeededRoleName]]
  >;

  it('defines every seeded role exactly once', () => {
    expect(roleEntries.map(([name]) => name).sort()).toEqual(
      Object.values(SeededRoleName).sort(),
    );
  });

  it('grants only permissions that exist in PERMISSION_CATALOG', () => {
    const catalogNames = new Set(PERMISSION_CATALOG.map(permissionName));
    for (const [roleName, definition] of roleEntries) {
      for (const permission of definition.permissions) {
        expect({
          roleName,
          permission: permissionName(permission),
          known: catalogNames.has(permissionName(permission)),
        }).toEqual({
          roleName,
          permission: permissionName(permission),
          known: true,
        });
      }
    }
  });

  it('grants each role only permissions from its own scope', () => {
    for (const [roleName, definition] of roleEntries) {
      for (const permission of definition.permissions) {
        expect({ roleName, scope: permission.scope }).toEqual({
          roleName,
          scope: definition.scope,
        });
      }
    }
  });

  it('never grants `manage` on a BUSINESS-scoped role, owner included', () => {
    // `manage` is CASL's wildcard. On `BusinessMembership` it silently includes
    // `assignRole`, `suspend`, and `transferOwnership`; on `Business` it
    // includes `delete`. The owner legitimately holds all of those TODAY, so
    // `manage` would be equivalent right now — and would silently grant
    // whatever verb is added to the vocabulary NEXT, to every business role
    // holding it, with nobody reviewing that decision.
    //
    // That is why this is a guard rather than a style check. The failure mode
    // is not a bad grant someone writes; it is a good grant that widens later,
    // when the person adding the verb has no reason to look here.
    for (const [roleName, definition] of roleEntries) {
      if (definition.scope !== RoleScope.BUSINESS) continue;
      const wildcardGrants = definition.permissions
        .filter((permission) => permission.action === 'manage')
        .map(permissionName);
      expect({ roleName, wildcardGrants }).toEqual({
        roleName,
        wildcardGrants: [],
      });
    }
  });

  it('never grants a role a permission every authenticated user already has', () => {
    // AUTHENTICATED_USER_PERMISSIONS are injected by `AbilityFactory` for every
    // caller. A role that also lists one compiles a SECOND, identical CASL rule
    // into that user's ability: harmless in outcome, but it bloats every
    // generated `where` clause and the packed rule set shipped to clients, and
    // it reads as though the role confers access that others lack.
    const intrinsic = new Set(
      AUTHENTICATED_USER_PERMISSIONS.map(permissionName),
    );
    for (const [roleName, definition] of roleEntries) {
      const redundant = definition.permissions
        .map(permissionName)
        .filter((name) => intrinsic.has(name));
      expect({ roleName, redundant }).toEqual({ roleName, redundant: [] });
    }
  });

  it('keeps every intrinsic permission ownership-scoped or a shared vocabulary read', () => {
    // The one rule that makes AUTHENTICATED_USER_PERMISSIONS safe: nothing here
    // may reach into a tenant. An `ANY`-ownership grant on a tenant-scoped
    // subject would hand every registered account authority inside every
    // business on the platform.
    const SHARED_VOCABULARY_SUBJECTS = new Set(['Role', 'Permission']);
    for (const permission of AUTHENTICATED_USER_PERMISSIONS) {
      const isSafe =
        permission.ownership === PermissionOwnership.OWN ||
        SHARED_VOCABULARY_SUBJECTS.has(permission.subject) ||
        // Creating a business grants authority over a tenant that does not yet
        // exist, and the creator becomes its owner. Deliberately open in this
        // template; see the note in the catalog.
        (permission.action === 'create' && permission.subject === 'Business');
      expect({ permission: permissionName(permission), isSafe }).toEqual({
        permission: permissionName(permission),
        isSafe: true,
      });
    }
  });

  it('withholds platform role assignment from every role except PLATFORM_ADMIN', () => {
    // The separation the platform role split exists to create: PLATFORM_ENGINEER
    // is the highest TECHNICAL authority and must not be able to promote itself
    // — or anyone — into governance. PLATFORM_ADMIN reaches it through
    // `manage all`, not through this permission.
    for (const [roleName, definition] of roleEntries) {
      const grantsRoleAssignment = definition.permissions.some(
        (permission) =>
          permission.action === 'assignRole' && permission.subject === 'User',
      );
      expect({ roleName, grantsRoleAssignment }).toEqual({
        roleName,
        grantsRoleAssignment: false,
      });
    }
  });

  it('withholds the audit trail from every support role', () => {
    // `audit_logs.metadata` carries IP addresses, user agents, parsed device
    // fingerprints, and Cloudflare geolocation for every account on the
    // platform. Support roles are the most widely staffed and the least
    // appropriate default holders of that.
    //
    // Investigative access stays with PLATFORM_ENGINEER and, through
    // `manage all`, PLATFORM_ADMIN. If a project needs support-side
    // visibility it should add a SANITIZED endpoint rather than granting
    // this permission — which is why this is a guard rather than a comment.
    const supportRoles = [
      SeededRoleName.PLATFORM_TECHNICAL_SUPPORT,
      SeededRoleName.PLATFORM_APP_SUPPORT,
    ];
    for (const roleName of supportRoles) {
      const readsAuditLog = ROLE_DEFINITION_CATALOG[roleName].permissions.some(
        (permission) =>
          permission.action === 'read' && permission.subject === 'AuditLog',
      );
      expect({ roleName, readsAuditLog }).toEqual({
        roleName,
        readsAuditLog: false,
      });
    }
  });

  it('withholds raw queue payloads from every support role', () => {
    // `readPayload QueueJob` is what makes "sanitized diagnostic visibility"
    // enforceable. Support roles investigate failures; they do not read the
    // user data those failures carry.
    const supportRoles = [
      SeededRoleName.PLATFORM_TECHNICAL_SUPPORT,
      SeededRoleName.PLATFORM_APP_SUPPORT,
    ];
    for (const roleName of supportRoles) {
      const readsPayloads = ROLE_DEFINITION_CATALOG[roleName].permissions.some(
        (permission) => permission.action === 'readPayload',
      );
      expect({ roleName, readsPayloads }).toEqual({
        roleName,
        readsPayloads: false,
      });
    }
  });

  it('reserves `manage all` for PLATFORM_ADMIN alone', () => {
    for (const [roleName, definition] of roleEntries) {
      const hasManageAll = definition.permissions.some(
        (permission) =>
          permission.action === 'manage' && permission.subject === 'all',
      );
      expect({ roleName, hasManageAll }).toEqual({
        roleName,
        hasManageAll: roleName === SeededRoleName.PLATFORM_ADMIN,
      });
    }
  });

  it('ranks the owner/admin of each scope above every other role in it', () => {
    const highestByScope = {
      [RoleScope.PLATFORM]: SeededRoleName.PLATFORM_ADMIN,
      [RoleScope.BUSINESS]: SeededRoleName.BUSINESS_OWNER,
    };
    for (const [scopeKey, expectedTopRole] of Object.entries(highestByScope)) {
      // `Object.entries` widens the key to `string`; cast at the boundary so
      // the comparison below stays enum-typed (no-unsafe-enum-comparison).
      const scope = scopeKey as RoleScope;
      const rolesInScope = roleEntries.filter(
        ([, definition]) => definition.scope === scope,
      );
      const topRank = Math.max(
        ...rolesInScope.map(([, definition]) => definition.rank),
      );
      const rolesAtTopRank = rolesInScope
        .filter(([, definition]) => definition.rank === topRank)
        .map(([name]) => name);
      expect(rolesAtTopRank).toEqual([expectedTopRole]);
    }
  });
});
