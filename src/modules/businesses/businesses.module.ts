import { Module } from '@nestjs/common';
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';
import { BusinessOwnershipPolicy } from './business-ownership.policy';
import { BusinessRoleAssignmentPolicy } from './business-role-assignment.policy';
import { BusinessInvitationsController } from './invitations/business-invitations.controller';
import { BusinessInvitationAcceptanceController } from './invitations/business-invitation-acceptance.controller';
import { BusinessInvitationsService } from './invitations/business-invitations.service';
import { BusinessMembershipsController } from './memberships/business-memberships.controller';
import { BusinessMembershipsService } from './memberships/business-memberships.service';

@Module({
  controllers: [
    BusinessesController,
    BusinessMembershipsController,
    BusinessInvitationsController,
    BusinessInvitationAcceptanceController,
  ],
  providers: [
    BusinessesService,
    BusinessMembershipsService,
    BusinessInvitationsService,
    BusinessOwnershipPolicy,
    // Not exported: role assignment is entirely a business-module concern, and
    // exporting a policy nothing outside needs invites it being reached for.
    BusinessRoleAssignmentPolicy,
  ],
  // `BusinessOwnershipPolicy` is exported for `UsersModule`: account deletion
  // and erasure are the other half of the ownership invariant, and the rule has
  // to be the same object in both places rather than a second copy of the query.
  exports: [
    BusinessesService,
    BusinessMembershipsService,
    BusinessInvitationsService,
    BusinessOwnershipPolicy,
  ],
})
export class BusinessesModule {}
