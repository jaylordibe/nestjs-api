import { ApiHideProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';

export class BusinessCustomerUserDto {
  id!: string;
  email!: string;
  firstName!: string;
  lastName!: string;
}

export interface BusinessCustomerRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
  businessId: string;
  userId: string;
  notes: string | null;
  isActive: boolean;
  user: BusinessCustomerUserDto;
}

export class BusinessCustomerResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;
  businessId!: string;
  userId!: string;
  notes!: string | null;
  isActive!: boolean;
  user!: BusinessCustomerUserDto;

  constructor(row: BusinessCustomerRow) {
    Object.assign(this, row);
  }
}
