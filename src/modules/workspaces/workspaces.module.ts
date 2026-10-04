import { Module } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceOwnershipPolicy } from './workspace-ownership.policy';
import { WorkspaceRoleAssignmentPolicy } from './workspace-role-assignment.policy';
import { WorkspaceInvitationsController } from './invitations/workspace-invitations.controller';
import { WorkspaceInvitationAcceptanceController } from './invitations/workspace-invitation-acceptance.controller';
import { WorkspaceInvitationsService } from './invitations/workspace-invitations.service';
import { WorkspaceInvitationEmailJobHandler } from './invitations/jobs/workspace-invitation-email.handler';
import { WorkspaceMembershipsController } from './memberships/workspace-memberships.controller';
import { WorkspaceMembershipsService } from './memberships/workspace-memberships.service';

@Module({
  controllers: [
    WorkspacesController,
    WorkspaceMembershipsController,
    WorkspaceInvitationsController,
    WorkspaceInvitationAcceptanceController,
  ],
  providers: [
    WorkspacesService,
    WorkspaceMembershipsService,
    WorkspaceInvitationsService,
    WorkspaceInvitationEmailJobHandler,
    WorkspaceOwnershipPolicy,
    // Not exported: role assignment is entirely a workspace-module concern, and
    // exporting a policy nothing outside needs invites it being reached for.
    WorkspaceRoleAssignmentPolicy,
  ],
  // `WorkspaceOwnershipPolicy` is exported for `UsersModule`: account deletion
  // and erasure are the other half of the ownership invariant, and the rule has
  // to be the same object in both places rather than a second copy of the query.
  exports: [
    WorkspacesService,
    WorkspaceMembershipsService,
    WorkspaceInvitationsService,
    WorkspaceOwnershipPolicy,
  ],
})
export class WorkspacesModule {}
