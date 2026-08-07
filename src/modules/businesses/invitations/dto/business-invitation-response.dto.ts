import { ApiHideProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { BusinessInvitationStatus } from '../../../../common/enums/business-invitation-status.enum';

export class BusinessInvitationRoleDto {
  id!: string;
  name!: string;
  rank!: number;
}

export interface BusinessInvitationRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
  businessId: string;
  email: string;
  roleId: string;
  tokenHash: string;
  status: string;
  invitedBy: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  role: BusinessInvitationRoleDto;
}

export class BusinessInvitationResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;

  // The digest of a live credential. `@Exclude()` keeps it out of the JSON and
  // `@ApiHideProperty()` keeps it out of the schema — class-transformer and the
  // Swagger plugin are independent layers, so both are required. Publishing it
  // would let anyone who can list invitations mount an offline search for the
  // token: SHA-256 over a known 43-character alphabet is not a slow hash.
  @ApiHideProperty() @Exclude() tokenHash!: string;

  businessId!: string;
  email!: string;
  roleId!: string;
  status!: BusinessInvitationStatus;
  invitedBy!: string | null;
  expiresAt!: Date;
  acceptedAt!: Date | null;
  acceptedBy!: string | null;
  revokedAt!: Date | null;
  revokedBy!: string | null;
  role!: BusinessInvitationRoleDto;

  constructor(row: BusinessInvitationRow) {
    const { status, ...rest } = row;
    Object.assign(this, rest);
    this.status = status as BusinessInvitationStatus;
  }
}
