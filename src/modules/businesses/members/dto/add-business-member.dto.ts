import { Transform } from 'class-transformer';
import { IsEmail, IsUUID } from 'class-validator';

export class AddBusinessMemberDto {
  // Adding a member requires an EXISTING account. There is no pending-invite
  // flow in this template — see `src/common/authorization/README.md` for the
  // recommended way to add one.
  @IsEmail()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  email!: string;

  // The business-scoped role to grant. Bounded by the rank guard: you may
  // never grant a role at or above your own.
  @IsUUID()
  roleId!: string;
}
