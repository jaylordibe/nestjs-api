import { IsUUID } from 'class-validator';

// A DTO rather than `@Body('roleId')` so the global whitelist ValidationPipe
// still rejects unknown fields on this, the most privileged endpoint we have.
export class AssignPlatformRoleDto {
  @IsUUID()
  roleId!: string;
}
