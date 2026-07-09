import { PermissionOwnership } from '../enums/permission-ownership.enum';
import { RoleScope } from '../enums/role-scope.enum';
import { SeededRoleName } from '../enums/seeded-role-name.enum';
import {
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
        subject: 'BusinessMember',
        action: 'assignRole',
        ownership: PermissionOwnership.ANY,
      }),
    ).toBe('business.business_member.assign_role');
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

  it('gives BUSINESS_ADMIN explicit verbs, never `manage BusinessMember`', () => {
    // `manage` is CASL's wildcard: it would include `assignRole` with no
    // ceiling, letting a business admin promote itself to owner. This is a
    // regression guard, not a style check.
    const businessAdmin =
      ROLE_DEFINITION_CATALOG[SeededRoleName.BUSINESS_ADMIN];
    const wildcardGrants = businessAdmin.permissions.filter(
      (permission) => permission.action === 'manage',
    );
    expect(wildcardGrants).toEqual([]);
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
