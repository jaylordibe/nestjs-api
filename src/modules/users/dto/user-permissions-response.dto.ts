import { ApiProperty } from '@nestjs/swagger';
import type { BusinessMembershipStatus } from '../../../common/enums/business-membership-status.enum';

/**
 * The caller's authorization, in a form the client can evaluate itself.
 *
 * `rules` is the output of CASL's `packRules(ability.rules)`. A web or mobile
 * client feeds it straight back in:
 *
 *   import { createMongoAbility } from '@casl/ability';
 *   import { unpackRules } from '@casl/ability/extra';
 *
 *   const ability = createMongoAbility(unpackRules(response.rules));
 *   ability.can('update', subject('Business', business));   // same answer as the server
 *
 * One catalog, both sides. Without this, every frontend re-implements
 * permission logic by hand and drifts from the backend the first time a role
 * changes — which is exactly the class of bug this whole subsystem exists to
 * prevent.
 *
 * The rules are the caller's OWN grants. They reveal nothing about other users,
 * and any decision made from them is re-checked server-side on every request.
 */
export class UserPermissionsResponseDto {
  @ApiProperty({
    description:
      'CASL rules, packed. Feed to `createMongoAbility(unpackRules(rules))`.',
    example: [
      ['read', 'User', { id: 'e1a…' }],
      ['manage', 'Business', { id: 'b7c…' }],
    ],
    type: 'array',
    items: { type: 'array', items: {} },
  })
  rules!: unknown[];

  @ApiProperty({
    description:
      'Names of the platform roles held by the caller. Empty for most accounts — platform roles are STAFF roles, and self-service capability comes from the intrinsic authenticated-user grants rather than from a role. An empty array is normal, not an error state.',
    example: [],
    type: [String],
  })
  platformRoles!: string[];

  @ApiProperty({
    description:
      'Every business membership the caller holds, in ANY status. Only `active` ones contribute to `rules`; the rest are context so a client can show a pending invitation or a suspended membership rather than silently omitting it. Never infer authority from this list — read `rules`.',
    example: [
      {
        membershipId: 'm3f…',
        businessId: 'b7c…',
        roleName: 'business_owner',
        status: 'active',
      },
    ],
  })
  businessMemberships!: Array<{
    membershipId: string;
    businessId: string;
    roleName: string;
    status: BusinessMembershipStatus;
  }>;

  constructor(value: UserPermissionsResponseDto) {
    Object.assign(this, value);
  }
}
