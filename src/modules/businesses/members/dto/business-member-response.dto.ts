import { ApiHideProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';

export class BusinessMemberUserDto {
  id!: string;
  email!: string;
  firstName!: string;
  lastName!: string;
}

export class BusinessMemberRoleDto {
  id!: string;
  name!: string;
  description!: string | null;
  rank!: number;
}

export interface BusinessMemberRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
  businessId: string;
  userId: string;
  user: BusinessMemberUserDto;
  role: BusinessMemberRoleDto;
}

export class BusinessMemberResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;
  businessId!: string;
  userId!: string;
  user!: BusinessMemberUserDto;
  role!: BusinessMemberRoleDto;

  constructor(row: BusinessMemberRow) {
    Object.assign(this, row);
  }
}
