import { ApiHideProperty } from '@nestjs/swagger';
import { Workspace } from '@prisma/client';
import { Exclude } from 'class-transformer';

export class WorkspaceResponseDto {
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

  constructor(row: Workspace) {
    Object.assign(this, row);
  }
}
