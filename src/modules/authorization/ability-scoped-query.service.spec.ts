import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AbilityFactory } from './ability.factory';
import { AbilityScopedQueryService } from './ability-scoped-query.service';
import { WorkspaceMembershipStatus } from '../../common/enums/workspace-membership-status.enum';
import { PermissionOwnership } from '../../common/enums/permission-ownership.enum';
import { RoleScope } from '../../common/enums/role-scope.enum';
import { SeededRoleName } from '../../common/enums/seeded-role-name.enum';
import type { AuthorizationGrants } from './ability.factory';

const OWN_USER_ID = '11111111-1111-1111-1111-111111111111';
const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';

// An ordinary account: NO platform role, NO membership.
//
// Its `read User own` rule is deliberately not declared here — `AbilityFactory`
// injects AUTHENTICATED_USER_PERMISSIONS for every caller, so declaring it
// again would compile the same rule twice and the assertions below would see a
// duplicated OR branch. Empty grants are the point: an account holding nothing
// still reaches its own row, and reaches nothing else.
const NO_ROLE_ACCOUNT_GRANTS: AuthorizationGrants = {
  platformPermissions: [],
  workspaceMemberships: [],
};

const PLATFORM_ADMIN_GRANTS: AuthorizationGrants = {
  platformPermissions: [
    {
      action: 'manage',
      subject: 'all',
      scope: RoleScope.PLATFORM,
      ownership: PermissionOwnership.ANY,
    },
  ],
  workspaceMemberships: [],
};

const WORKSPACE_MEMBER_GRANTS: AuthorizationGrants = {
  platformPermissions: [],
  workspaceMemberships: [
    {
      membershipId: '00000000-0000-4000-8000-0000000000aa',
      workspaceId: WORKSPACE_ID,
      roleId: '00000000-0000-4000-8000-0000000000bb',
      roleName: SeededRoleName.WORKSPACE_STAFF,
      status: WorkspaceMembershipStatus.ACTIVE,
      permissions: [
        {
          action: 'read',
          subject: 'Workspace',
          scope: RoleScope.WORKSPACE,
          ownership: PermissionOwnership.ANY,
        },
      ],
    },
  ],
};

describe('AbilityScopedQueryService', () => {
  const abilityFactory = new AbilityFactory();
  const service = new AbilityScopedQueryService();
  const abilityFor = (grants: AuthorizationGrants) =>
    abilityFactory.createForUser(OWN_USER_ID, grants);

  describe('the Prisma empty-OR landmine', () => {
    // Prisma DROPS `{ OR: [] }` when it is an element of an `AND` array, so
    // `{ AND: [callerWhere, fragment] }` would return every row to a caller
    // with no rules. These tests pin the two defences.

    it('refuses outright when the caller has no rule for the subject', () => {
      // `AuditLog`, not `User`: every authenticated caller now holds an
      // intrinsic `read User own`, so `User` can no longer express "no rule at
      // all". `AuditLog` is granted only to staff roles, which this fixture has
      // none of.
      expect(() =>
        service.buildWhere(
          abilityFor(NO_ROLE_ACCOUNT_GRANTS),
          'read',
          'AuditLog',
        ),
      ).toThrow(ForbiddenException);
    });

    it('never emits the fragment as an element of an AND array', () => {
      const where = service.buildWhere(
        abilityFor(NO_ROLE_ACCOUNT_GRANTS),
        'read',
        'User',
        { isActive: true },
      );

      // The accessible fragment must sit at the TOP LEVEL…
      expect(where).toHaveProperty('OR', [{ id: OWN_USER_ID }]);
      // …and the caller's filter under AND — never the other way around.
      expect(where.AND).toEqual([{ isActive: true }]);

      const andClause = where.AND as Array<Record<string, unknown>>;
      for (const clause of andClause) {
        expect(clause).not.toHaveProperty('OR');
      }
    });
  });

  describe('scoping', () => {
    it('restricts an ownership-scoped caller to their own rows', () => {
      const where = service.buildWhere(
        abilityFor(NO_ROLE_ACCOUNT_GRANTS),
        'read',
        'User',
      );
      expect(where.OR).toEqual([{ id: OWN_USER_ID }]);
    });

    it('does not restrict a caller holding `manage all`', () => {
      const where = service.buildWhere(
        abilityFor(PLATFORM_ADMIN_GRANTS),
        'read',
        'User',
      );
      // No OR fragment at all — the admin sees every row.
      expect(where.OR).toBeUndefined();
      expect(where).toEqual({ AND: [{}] });
    });

    it('restricts a workspace-scoped caller to their tenant', () => {
      const where = service.buildWhere(
        abilityFor(WORKSPACE_MEMBER_GRANTS),
        'read',
        'Workspace',
      );
      expect(where.OR).toEqual([{ id: WORKSPACE_ID }]);
    });

    it('denies a workspace-scoped caller on an unrelated subject', () => {
      // `AuditLog` rather than `User`: a tenant grant must not leak into a
      // subject it never named, and `User` can no longer prove that because
      // every caller holds an intrinsic `read User own`.
      expect(() =>
        service.buildWhere(
          abilityFor(WORKSPACE_MEMBER_GRANTS),
          'read',
          'AuditLog',
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe('assertWorkspaceReachable', () => {
    const OTHER_WORKSPACE_ID = '33333333-3333-3333-3333-333333333333';
    const WORKSPACE_INVITATION_READER_GRANTS: AuthorizationGrants = {
      platformPermissions: [],
      workspaceMemberships: [
        {
          membershipId: '00000000-0000-4000-8000-0000000000cc',
          workspaceId: WORKSPACE_ID,
          roleId: '00000000-0000-4000-8000-0000000000dd',
          roleName: SeededRoleName.WORKSPACE_ADMIN,
          status: WorkspaceMembershipStatus.ACTIVE,
          permissions: [
            {
              action: 'read',
              subject: 'WorkspaceInvitation',
              scope: RoleScope.WORKSPACE,
              ownership: PermissionOwnership.ANY,
            },
          ],
        },
      ],
    };

    it('passes a caller whose grant reaches the workspace', () => {
      expect(() =>
        service.assertWorkspaceReachable(
          abilityFor(WORKSPACE_INVITATION_READER_GRANTS),
          'read',
          'WorkspaceInvitation',
          WORKSPACE_ID,
        ),
      ).not.toThrow();
    });

    it('answers 404, not 403, for a workspace the grant does not reach', () => {
      expect(() =>
        service.assertWorkspaceReachable(
          abilityFor(WORKSPACE_INVITATION_READER_GRANTS),
          'read',
          'WorkspaceInvitation',
          OTHER_WORKSPACE_ID,
        ),
      ).toThrow(NotFoundException);
    });

    it('answers 404 for a caller with no grant at all', () => {
      expect(() =>
        service.assertWorkspaceReachable(
          abilityFor(NO_ROLE_ACCOUNT_GRANTS),
          'read',
          'WorkspaceInvitation',
          WORKSPACE_ID,
        ),
      ).toThrow(NotFoundException);
    });

    it('passes a platform grant for any workspace', () => {
      expect(() =>
        service.assertWorkspaceReachable(
          abilityFor(PLATFORM_ADMIN_GRANTS),
          'create',
          'WorkspaceInvitation',
          OTHER_WORKSPACE_ID,
        ),
      ).not.toThrow();
    });
  });

  describe('buildRecordWhere', () => {
    it('composes the record id under AND, leaving the fragment on top', () => {
      const where = service.buildRecordWhere(
        abilityFor(NO_ROLE_ACCOUNT_GRANTS),
        'read',
        'User',
        'some-other-user',
      );
      expect(where).toEqual({
        OR: [{ id: OWN_USER_ID }],
        AND: [{ id: 'some-other-user' }],
      });
      // Both clauses must survive: OR pins the caller to themselves, AND pins
      // the lookup to the requested id, so a cross-user fetch matches nothing.
    });
  });
});
