import { ForbiddenException } from '@nestjs/common';
import type { AppAbility } from '../../../common/authorization/app-ability';
import { ErrorCode } from '../../../common/errors/error-code.enum';
import { RoleScope } from '../../../common/enums/role-scope.enum';
import { SeededRoleName } from '../../../common/enums/seeded-role-name.enum';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { PermissionLoaderService } from '../../authorization/permission-loader.service';
import { BusinessMembersService } from './business-members.service';

/**
 * The rank guard must FAIL CLOSED.
 *
 * `assertMayAssignRole` bounds role assignment by the actor's own rank inside
 * the business. Platform admins are exempt and return early on `manage all`;
 * every other caller is measured against their membership row. The question
 * this spec pins down is what happens when that row is not there.
 *
 * It used to mean "unbounded" — the code defaulted a missing membership to
 * `Number.POSITIVE_INFINITY` on the assumption that only a platform admin
 * could reach it without one. That assumption is not enforced anywhere. Two
 * ways it breaks:
 *
 *   1. a future platform-scoped role granted `assignRole` on BusinessMember
 *      would clear the guard, hold no membership, and inherit an infinite
 *      ceiling — able to mint a BUSINESS_OWNER in any business on the platform;
 *   2. today, a member whose row is revoked between the guard's check and this
 *      query lands in the same branch mid-request.
 *
 * Neither is reachable through the seeded catalog right now, which is exactly
 * why it needs a test: nothing else would notice the fallback coming back.
 */
describe('BusinessMembersService — privilege-escalation rank guard', () => {
  const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
  const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
  const TARGET_USER_ID = '33333333-3333-4333-8333-333333333333';
  const OWNER_ROLE_ID = '44444444-4444-4444-8444-444444444444';

  const addOwnerDto = { email: 'target@example.com', roleId: OWNER_ROLE_ID };

  // A caller who is NOT a platform admin: `manage all` is the only rule the
  // guard consults before reaching for the actor's rank.
  const abilityWithoutManageAll = {
    can: jest.fn().mockReturnValue(false),
  } as unknown as AppAbility;

  let prisma: {
    scoped: { user: { findFirst: jest.Mock } };
    role: { findUnique: jest.Mock };
    businessMember: { findUnique: jest.Mock; create: jest.Mock };
  };
  let service: BusinessMembersService;

  beforeEach(() => {
    prisma = {
      scoped: {
        user: {
          findFirst: jest.fn().mockResolvedValue({ id: TARGET_USER_ID }),
        },
      },
      role: {
        findUnique: jest.fn().mockResolvedValue({
          id: OWNER_ROLE_ID,
          name: SeededRoleName.BUSINESS_OWNER,
          rank: 100,
          scope: RoleScope.BUSINESS,
        }),
      },
      businessMember: {
        // The branch under test: the actor holds no membership in this business.
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };

    service = new BusinessMembersService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
      { invalidateUser: jest.fn() } as unknown as PermissionLoaderService,
    );
  });

  it('denies an actor holding no membership in the target business', async () => {
    await expect(
      service.add(BUSINESS_ID, addOwnerDto, abilityWithoutManageAll, ACTOR_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies with PERMISSION_DENIED rather than a generic 403', async () => {
    await expect(
      service.add(BUSINESS_ID, addOwnerDto, abilityWithoutManageAll, ACTOR_ID),
    ).rejects.toMatchObject({
      response: { errorCode: ErrorCode.PERMISSION_DENIED },
    });
  });

  // The assertion that would have caught the original defect: the guard must
  // refuse BEFORE the roster is written, not merely return an error afterwards.
  it('writes no roster row when the actor has no rank', async () => {
    await expect(
      service.add(BUSINESS_ID, addOwnerDto, abilityWithoutManageAll, ACTOR_ID),
    ).rejects.toThrow();

    expect(prisma.businessMember.create).not.toHaveBeenCalled();
  });
});
