import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class AddBusinessCustomerDto {
  // Omit to register YOURSELF as a customer of this business (the self-join
  // path, granted to every user by `create BusinessCustomer (own)`).
  //
  // Supply an email to register SOMEONE ELSE — which requires the business's
  // own `create BusinessCustomer` grant. The service re-checks against the
  // resolved target, so a customer cannot enrol a third party.
  @IsOptional()
  @IsEmail()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  email?: string;

  // Staff-only annotation. Ignored unless the caller may `update` the record.
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
