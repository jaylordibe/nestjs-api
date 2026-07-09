import { ForbiddenException } from '@nestjs/common';
import { AbilityFactory } from './ability.factory';
import { AbilityScopedQueryService } from './ability-scoped-query.service';
import { PermissionOwnership } from '../../common/enums/permission-ownership.enum';
import { RoleScope } from '../../common/enums/role-scope.enum';
import type { AuthorizationGrants } from './ability.factory';

const OWN_USER_ID = '11111111-1111-1111-1111-111111111111';
const BUSINESS_ID = '22222222-2222-2222-2222-222222222222';

const NO_GRANTS: AuthorizationGrants = {
  platformPermissions: [],
  businessMemberships: [],
};

const PLATFORM_USER_GRANTS: AuthorizationGrants = {
  platformPermissions: [
    {
      action: 'read',
      subject: 'User',
      scope: RoleScope.PLATFORM,
      ownership: PermissionOwnership.OWN,
    },
  ],
  businessMemberships: [],
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
  businessMemberships: [],
};

const BUSINESS_STAFF_GRANTS: AuthorizationGrants = {
  platformPermissions: [],
  businessMemberships: [
    {
      businessId: BUSINESS_ID,
      permissions: [
        {
          action: 'read',
          subject: 'Business',
          scope: RoleScope.BUSINESS,
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
      expect(() =>
        service.buildWhere(abilityFor(NO_GRANTS), 'read', 'User'),
      ).toThrow(ForbiddenException);
    });

    it('never emits the fragment as an element of an AND array', () => {
      const where = service.buildWhere(
        abilityFor(PLATFORM_USER_GRANTS),
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
        abilityFor(PLATFORM_USER_GRANTS),
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

    it('restricts a business-scoped caller to their tenant', () => {
      const where = service.buildWhere(
        abilityFor(BUSINESS_STAFF_GRANTS),
        'read',
        'Business',
      );
      expect(where.OR).toEqual([{ id: BUSINESS_ID }]);
    });

    it('denies a business-scoped caller on an unrelated subject', () => {
      expect(() =>
        service.buildWhere(abilityFor(BUSINESS_STAFF_GRANTS), 'read', 'User'),
      ).toThrow(ForbiddenException);
    });
  });

  describe('buildRecordWhere', () => {
    it('composes the record id under AND, leaving the fragment on top', () => {
      const where = service.buildRecordWhere(
        abilityFor(PLATFORM_USER_GRANTS),
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
