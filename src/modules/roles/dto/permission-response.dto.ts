import { PermissionOwnership } from '../../../common/enums/permission-ownership.enum';
import { RoleScope } from '../../../common/enums/role-scope.enum';

// The raw shape Prisma returns. Enum-like columns are `String` in the database
// (this codebase declares no Postgres enums), so they arrive as `string` and are
// cast at this boundary — the one place the conversion belongs.
export interface PermissionRow {
  id: string;
  name: string;
  action: string;
  subject: string;
  scope: string;
  ownership: string;
  description: string;
}

export class PermissionResponseDto {
  id!: string;
  name!: string;
  action!: string;
  subject!: string;
  scope!: RoleScope;
  ownership!: PermissionOwnership;
  description!: string;

  constructor(row: PermissionRow) {
    this.id = row.id;
    this.name = row.name;
    this.action = row.action;
    this.subject = row.subject;
    this.scope = row.scope as RoleScope;
    this.ownership = row.ownership as PermissionOwnership;
    this.description = row.description;
  }
}
