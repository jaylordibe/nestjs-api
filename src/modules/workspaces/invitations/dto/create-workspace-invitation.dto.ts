import { Transform } from 'class-transformer';
import { IsEmail, IsUUID } from 'class-validator';

export class CreateWorkspaceInvitationDto {
  // Normalised here so the partial unique index on (workspace_id, email) WHERE
  // status = 'pending' actually catches duplicates — `Alice@x.com` and
  // `alice@x.com` must not be two outstanding invitations.
  @IsEmail()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @IsUUID()
  roleId!: string;
}
