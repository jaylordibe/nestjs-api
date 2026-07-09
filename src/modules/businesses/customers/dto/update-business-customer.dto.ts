import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

// Staff-facing. A customer edits nothing here — their side of the relationship
// is create-or-delete.
export class UpdateBusinessCustomerDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
