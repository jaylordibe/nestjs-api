import { Gender } from '../../../common/enums/gender.enum';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// 8+ chars, at least one letter and one digit. Composed with MaxLength(72)
// to prevent bcrypt's silent 72-byte truncation.
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const PASSWORD_MESSAGE =
  'password must be at least 8 characters and contain a letter and a digit';

// E.164: leading `+`, country code starting 1-9, then up to 14 more digits.
// Hard cap is 15 digits per the standard, so the full string is 16 chars
// max (`+` + 15 digits). Exported so the phone-update / phone-verify DTOs
// can reuse the exact same shape — the SmsService adapter (e.g. Twilio)
// rejects anything that isn't E.164, so accepting looser formats here just
// pushes the failure to send-time.
export const E164_PHONE_PATTERN = /^\+[1-9]\d{1,14}$/;
export const E164_PHONE_MESSAGE =
  'phoneNumber must be in E.164 format (e.g. +14155551234)';
export const E164_PHONE_MAX_LENGTH = 16;

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message:
      'username may only contain letters, numbers, dot, underscore, dash',
  })
  username?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE })
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  middleName?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(E164_PHONE_MAX_LENGTH)
  @Matches(E164_PHONE_PATTERN, { message: E164_PHONE_MESSAGE })
  phoneNumber?: string;

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  birthday?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  profileImageUrl?: string;
}
