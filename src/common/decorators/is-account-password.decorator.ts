import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, ValidateBy, ValidationArguments } from 'class-validator';
import {
  ACCOUNT_PASSWORD_MAX_BYTES,
  ACCOUNT_PASSWORD_MIN_LENGTH,
  ACCOUNT_PASSWORD_PATTERN,
  accountPasswordMessage,
  isAccountPassword,
} from '../util/account-password.util';

// A field that sets an account password. The rule is `isAccountPassword`, run
// as is — class-validator's MaxLength counts characters, and the limit is in
// bytes — so the DTOs and the seeder can never check different things. The
// Swagger plugin reads class-validator decorators only where they are written,
// so the schema is stated here too; OpenAPI has no byte length, so `maxLength`
// is the character bound a 72-byte string can never exceed, and the
// description states the real limit.
export function IsAccountPassword(): PropertyDecorator {
  const message = (args: ValidationArguments): string =>
    accountPasswordMessage(args.property);
  return applyDecorators(
    ApiProperty({
      minLength: ACCOUNT_PASSWORD_MIN_LENGTH,
      maxLength: ACCOUNT_PASSWORD_MAX_BYTES,
      pattern: ACCOUNT_PASSWORD_PATTERN.source,
      description: `At least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters and at most ${ACCOUNT_PASSWORD_MAX_BYTES} bytes in UTF-8 (a character such as ñ takes 2, an emoji 4), with a letter and a digit.`,
    }),
    IsString(),
    ValidateBy({
      name: 'isAccountPassword',
      validator: {
        validate: (value: unknown): boolean => isAccountPassword(value),
        defaultMessage: message,
      },
    }),
  );
}
