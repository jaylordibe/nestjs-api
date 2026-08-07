import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// Adds someone who ALREADY has an account. To bring in an address that may not
// be registered yet, use the invitation flow
// (`POST /businesses/:businessId/invitations`) — this endpoint deliberately
// 404s on an unknown email rather than silently creating an account, because a
// business must not be able to mint user records for arbitrary addresses.
export class AddBusinessMembershipDto {
  @IsEmail()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @IsUUID()
  roleId!: string;

  // Staff annotation, applied at creation. Silently ignored unless the caller
  // may `update` the membership — enforced in the service, not here, because
  // the DTO cannot see the ability.
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
