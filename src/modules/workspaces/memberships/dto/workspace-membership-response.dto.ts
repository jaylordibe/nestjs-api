import { ApiHideProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { WorkspaceMembershipStatus } from '../../../../common/enums/workspace-membership-status.enum';

export class WorkspaceMembershipUserDto {
  id!: string;
  email!: string;
  firstName!: string;
  lastName!: string;
}

export class WorkspaceMembershipRoleDto {
  id!: string;
  name!: string;
  description!: string | null;
  // Exposed deliberately: a client building a role picker needs the ceiling to
  // grey out roles the caller cannot assign, and rank is not sensitive — it is
  // published in the catalog every authenticated user can already read.
  rank!: number;
}

// The service's return shape. Declared here rather than leaking Prisma's
// generated payload types outward.
export interface WorkspaceMembershipRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
  workspaceId: string;
  userId: string;
  roleId: string;
  status: string;
  joinedAt: Date | null;
  endedAt: Date | null;
  invitedBy: string | null;
  notes: string | null;
  user: WorkspaceMembershipUserDto;
  role: WorkspaceMembershipRoleDto;
}

export class WorkspaceMembershipResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;

  workspaceId!: string;
  userId!: string;
  roleId!: string;
  status!: WorkspaceMembershipStatus;
  joinedAt!: Date | null;
  endedAt!: Date | null;
  invitedBy!: string | null;
  // Staff annotation. Present in the payload for any caller who could read the
  // membership at all — which, for a member reading their OWN row, means they
  // see what staff wrote about them. That is deliberate: a note a workspace
  // would not want its member to read does not belong in a field the member's
  // own record carries. Projects needing private staff commentary should model
  // it as a separate, staff-only subject.
  notes!: string | null;

  user!: WorkspaceMembershipUserDto;
  role!: WorkspaceMembershipRoleDto;

  constructor(row: WorkspaceMembershipRow) {
    const { status, ...rest } = row;
    Object.assign(this, rest);
    // DB columns are plain `String`; cast at the single database→app boundary.
    this.status = status as WorkspaceMembershipStatus;
  }
}
