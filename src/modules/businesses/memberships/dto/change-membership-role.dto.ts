import { IsUUID } from 'class-validator';

// A DTO rather than `@Body('roleId')` so the global whitelist ValidationPipe
// still rejects unknown fields on a privilege-changing endpoint.
export class ChangeMembershipRoleDto {
  @IsUUID()
  roleId!: string;
}
