import { Module } from '@nestjs/common';
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';
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
  ],
  exports: [
    BusinessesService,
    BusinessMembershipsService,
    BusinessInvitationsService,
  ],
})
export class BusinessesModule {}
