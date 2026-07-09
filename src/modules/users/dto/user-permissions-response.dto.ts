import { ApiProperty } from '@nestjs/swagger';

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
    description: 'Names of the platform roles held by the caller.',
    example: ['platform_user'],
    type: [String],
  })
  platformRoles!: string[];

  @ApiProperty({
    description:
      'Business memberships held by the caller, as { businessId, roleName }.',
    example: [{ businessId: 'b7c…', roleName: 'business_owner' }],
  })
  businessMemberships!: Array<{ businessId: string; roleName: string }>;

  constructor(value: UserPermissionsResponseDto) {
    Object.assign(this, value);
  }
}
