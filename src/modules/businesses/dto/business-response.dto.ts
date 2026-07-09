import { ApiHideProperty } from '@nestjs/swagger';
import { Business } from '@prisma/client';
import { Exclude } from 'class-transformer';

export class BusinessResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  // Audit-trail columns hidden from the frontend — see CLAUDE.md.
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;
  @ApiHideProperty() @Exclude() deletedAt!: Date | null;
  @ApiHideProperty() @Exclude() deletedBy!: string | null;
  name!: string;
  slug!: string;
  description!: string | null;
  isActive!: boolean;

  constructor(row: Business) {
    Object.assign(this, row);
  }
}
