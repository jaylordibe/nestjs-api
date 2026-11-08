import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, ValidateBy, ValidationArguments } from 'class-validator';
import {
  ACCOUNT_PASSWORD_MAX_BYTES,
  ACCOUNT_PASSWORD_MIN_LENGTH,
  checkedPasswordMessage,
  isWithinAccountPasswordBounds,
} from '../util/account-password.util';

// A field that carries a password to CHECK against the stored one (sign-in, a
// `currentPassword` field), not one being set — that is `@IsAccountPassword()`.
// Bounded only, by `isWithinAccountPasswordBounds`; the letter-and-digit rule
// is never applied here, so a wrong guess is answered by the credential check,
// not by validation. As in `@IsAccountPassword()`, `maxLength` is the character
// bound a 72-byte string can never exceed, and the description states the real
// limit.
export function IsCheckedPassword(): PropertyDecorator {
  return applyDecorators(
    ApiProperty({
      minLength: ACCOUNT_PASSWORD_MIN_LENGTH,
      maxLength: ACCOUNT_PASSWORD_MAX_BYTES,
      description: `At least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters and at most ${ACCOUNT_PASSWORD_MAX_BYTES} bytes in UTF-8.`,
    }),
    IsString(),
    ValidateBy({
      name: 'isCheckedPassword',
      validator: {
        validate: (value: unknown): boolean =>
          isWithinAccountPasswordBounds(value),
        defaultMessage: (args: ValidationArguments): string =>
          checkedPasswordMessage(args.property),
      },
    }),
  );
}
