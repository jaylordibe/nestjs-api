import { taggedSubject } from '../../common/authorization/app-ability';
import { AbilityFactory, type AuthorizationGrants } from './ability.factory';
import { WorkspaceMembershipStatus } from '../../common/enums/workspace-membership-status.enum';
import { PermissionOwnership } from '../../common/enums/permission-ownership.enum';
import { RoleScope } from '../../common/enums/role-scope.enum';
import { SeededRoleName } from '../../common/enums/seeded-role-name.enum';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_WORKSPACE_ID = '33333333-3333-3333-3333-333333333333';

const membership = (
  permissions: AuthorizationGrants['workspaceMemberships'][number]['permissions'],
  status: WorkspaceMembershipStatus = WorkspaceMembershipStatus.ACTIVE,
) => ({
  membershipId: '00000000-0000-4000-8000-0000000000aa',
  workspaceId: WORKSPACE_ID,
  roleId: '00000000-0000-4000-8000-0000000000bb',
  roleName: SeededRoleName.WORKSPACE_STAFF,
  status,
  permissions,
});

describe('AbilityFactory', () => {
  const factory = new AbilityFactory();
  const build = (grants: AuthorizationGrants) =>
    factory.createForUser(USER_ID, grants);

  const NO_GRANTS: AuthorizationGrants = {
    platformPermissions: [],
    workspaceMemberships: [],
  };

  describe('intrinsic authenticated-user permissions', () => {
    it('reach an account holding no role and no membership', () => {
      const ability = build(NO_GRANTS);
      expect(ability.can('read', taggedSubject('User', { id: USER_ID }))).toBe(
        true,
      );
      expect(ability.can('create', 'Workspace')).toBe(true);
      expect(ability.can('read', 'Role')).toBe(true);
    });

    it('do not reach anybody else’s rows', () => {
      const ability = build(NO_GRANTS);
      expect(
        ability.can('read', taggedSubject('User', { id: 'someone-else' })),
      ).toBe(false);
      expect(ability.can('read', 'AuditLog')).toBe(false);
    });
  });

  describe('the scope guard', () => {
    /**
     * The escalation this exists to stop, and the reason it lives here rather
     * than in a database constraint.
     *
     * This factory branches on where a grant ARRIVED from, not on what the
     * permission claims to be, and the platform branch emits an UNCONDITIONAL
     * rule. Workspace permissions are always `ANY`, so a workspace permission
     * reaching the platform loop — a workspace role assigned through
     * `user_roles` — would become platform-wide authority over every tenant.
     *
     * A CHECK constraint on `user_roles` guards the write that creates that
     * row. It cannot guard this: grants also arrive here deserialized from
     * Redis, where no constraint reaches.
     */
    it('drops a WORKSPACE permission that arrives platform-wide', () => {
      const ability = build({
        platformPermissions: [
          {
            action: 'read',
            subject: 'WorkspaceMembership',
            scope: RoleScope.WORKSPACE,
            ownership: PermissionOwnership.ANY,
          },
        ],
        workspaceMemberships: [],
      });

      // Asserted against a concrete record, never `can('read',
      // 'WorkspaceMembership')` — a bare subject-TYPE check ignores conditions,
      // so it is `true` for everybody via the intrinsic own-membership rule and
      // would pass with or without the guard. The instance check is the only
      // one that can tell the two apart.
      //
      // Somebody else's membership, in a workspace this user has no part in.
      // Without the guard the unconditional rule matches it.
      expect(
        ability.can(
          'read',
          taggedSubject('WorkspaceMembership', {
            workspaceId: OTHER_WORKSPACE_ID,
            userId: 'someone-else',
          }),
        ),
      ).toBe(false);
    });

    it('drops a PLATFORM permission that arrives through a membership', () => {
      const ability = build({
        platformPermissions: [],
        workspaceMemberships: [
          membership([
            {
              action: 'read',
              subject: 'WorkspaceMembership',
              scope: RoleScope.PLATFORM,
              ownership: PermissionOwnership.ANY,
            },
          ]),
        ],
      });

      expect(
        ability.can(
          'read',
          taggedSubject('WorkspaceMembership', { workspaceId: WORKSPACE_ID }),
        ),
      ).toBe(false);
    });

    it('drops a membership whose workspaceId is missing', () => {
      // A tenant rule with no tenant is not narrow, it is absent:
      // `{ workspaceId: undefined }` reaches Prisma as "no filter", and
      // `accessibleBy` then yields `{ OR: [{}] }` — which the empty-OR guard
      // does NOT catch, because the array is not empty. Every row of the table
      // would come back to a single-tenant caller.
      const ability = build({
        platformPermissions: [],
        workspaceMemberships: [
          {
            ...membership([
              {
                action: 'read',
                subject: 'Workspace',
                scope: RoleScope.WORKSPACE,
                ownership: PermissionOwnership.ANY,
              },
            ]),
            workspaceId: undefined as unknown as string,
          },
        ],
      });

      expect(
        ability.can('read', taggedSubject('Workspace', { id: WORKSPACE_ID })),
      ).toBe(false);
      expect(
        ability.can(
          'read',
          taggedSubject('Workspace', { id: OTHER_WORKSPACE_ID }),
        ),
      ).toBe(false);
    });

    it('drops a platform grant whose ownership is unrecognised', () => {
      // The old `if (OWN) … else unconditional` shape read the same for valid
      // input and treated an absent ownership as the WIDEST possible grant.
      // Grants arrive deserialized from Redis, where the type guarantees
      // nothing, so the default has to be "no rule".
      const ability = build({
        platformPermissions: [
          {
            action: 'read',
            subject: 'AuditLog',
            scope: RoleScope.PLATFORM,
            ownership: undefined as unknown as PermissionOwnership,
          },
        ],
        workspaceMemberships: [],
      });

      expect(ability.can('read', 'AuditLog')).toBe(false);
    });

    it('does not throw on a mis-scoped grant — it drops the rule', () => {
      // Failing the whole ability build would turn one bad row into an outage
      // for that account. Dropping the rule fails closed without doing that.
      expect(() =>
        build({
          platformPermissions: [
            {
              action: 'manage',
              subject: 'all',
              scope: RoleScope.WORKSPACE,
              ownership: PermissionOwnership.ANY,
            },
          ],
          workspaceMemberships: [],
        }),
      ).not.toThrow();
    });

    it('still compiles correctly-scoped grants either side of a bad one', () => {
      const ability = build({
        platformPermissions: [
          {
            action: 'read',
            subject: 'WorkspaceMembership',
            scope: RoleScope.WORKSPACE,
            ownership: PermissionOwnership.ANY,
          },
          {
            action: 'read',
            subject: 'AuditLog',
            scope: RoleScope.PLATFORM,
            ownership: PermissionOwnership.ANY,
          },
        ],
        workspaceMemberships: [],
      });

      expect(ability.can('read', 'AuditLog')).toBe(true);
      expect(
        ability.can(
          'read',
          taggedSubject('WorkspaceMembership', {
            workspaceId: OTHER_WORKSPACE_ID,
            userId: 'someone-else',
          }),
        ),
      ).toBe(false);
    });
  });

  describe('membership status', () => {
    it.each([
      WorkspaceMembershipStatus.SUSPENDED,
      WorkspaceMembershipStatus.LEFT,
    ])('compiles nothing from a %s membership', (status) => {
      const ability = build({
        platformPermissions: [],
        workspaceMemberships: [
          membership(
            [
              {
                action: 'read',
                subject: 'Workspace',
                scope: RoleScope.WORKSPACE,
                ownership: PermissionOwnership.ANY,
              },
            ],
            status,
          ),
        ],
      });

      expect(
        ability.can('read', taggedSubject('Workspace', { id: WORKSPACE_ID })),
      ).toBe(false);
    });

    it('compiles a tenant-bounded rule from an ACTIVE membership', () => {
      const ability = build({
        platformPermissions: [],
        workspaceMemberships: [
          membership([
            {
              action: 'read',
              subject: 'Workspace',
              scope: RoleScope.WORKSPACE,
              ownership: PermissionOwnership.ANY,
            },
          ]),
        ],
      });

      expect(
        ability.can('read', taggedSubject('Workspace', { id: WORKSPACE_ID })),
      ).toBe(true);
      // …and nowhere else. The tenant condition is the whole point.
      expect(
        ability.can(
          'read',
          taggedSubject('Workspace', { id: OTHER_WORKSPACE_ID }),
        ),
      ).toBe(false);
    });
  });
});
