import { ApiHideProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { RoleScope } from '../../../common/enums/role-scope.enum';
import {
  PermissionResponseDto,
  PermissionRow,
} from './permission-response.dto';

export interface RoleRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
  name: string;
  scope: string;
  rank: number;
  description: string | null;
  isSystem: boolean;
  permissions?: Array<{ permission: PermissionRow }>;
}

export class RoleResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;
  name!: string;
  scope!: RoleScope;
  // Orders roles for the privilege-escalation guard: you may not grant a role
  // ranked above your own. It does NOT imply inherited permissions.
  rank!: number;
  description!: string | null;
  // Seeded, catalog-owned roles are immutable through the API.
  isSystem!: boolean;
  permissions!: PermissionResponseDto[];

  constructor(row: RoleRow) {
    const { permissions, scope, ...rest } = row;
    Object.assign(this, rest);
    this.scope = scope as RoleScope;
    this.permissions = (permissions ?? []).map(
      (link) => new PermissionResponseDto(link.permission),
    );
  }
}
