import { IsUUID } from 'class-validator';

// The only mutable field on a roster entry is the role. Changing it is
// `assignRole`, a distinct permission from `update` — see the catalog.
export class UpdateBusinessMemberDto {
  @IsUUID()
  roleId!: string;
}
