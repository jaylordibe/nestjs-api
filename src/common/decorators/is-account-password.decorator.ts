import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidationArguments,
} from 'class-validator';
import {
  ACCOUNT_PASSWORD_MAX_LENGTH,
  ACCOUNT_PASSWORD_MIN_LENGTH,
  ACCOUNT_PASSWORD_PATTERN,
  accountPasswordMessage,
} from '../util/account-password.util';

// A field that sets an account password; `account-password.util` holds the
// rule. The Swagger plugin reads class-validator decorators only where they
// are written, so the schema is stated here too.
export function IsAccountPassword(): PropertyDecorator {
  const message = (args: ValidationArguments): string =>
    accountPasswordMessage(args.property);
  return applyDecorators(
    ApiProperty({
      minLength: ACCOUNT_PASSWORD_MIN_LENGTH,
      maxLength: ACCOUNT_PASSWORD_MAX_LENGTH,
      pattern: ACCOUNT_PASSWORD_PATTERN.source,
    }),
    IsString(),
    MinLength(ACCOUNT_PASSWORD_MIN_LENGTH, { message }),
    MaxLength(ACCOUNT_PASSWORD_MAX_LENGTH, { message }),
    Matches(ACCOUNT_PASSWORD_PATTERN, { message }),
  );
}
