import { IsString, Length, Matches, MaxLength } from 'class-validator';
import {
  E164_PHONE_MAX_LENGTH,
  E164_PHONE_MESSAGE,
  E164_PHONE_PATTERN,
} from './create-user.dto';

// Body for `PATCH /users/me/verify-phone`. Carries the OTP that was sent
// via `POST /users/me/request-phone-verification` plus the phone number it
// was bound to. The service rejects any mismatch on either field with the
// same opaque "Invalid or expired" error so callers can't enumerate
// (i.e. can't distinguish "wrong code" from "wrong number" from "expired").
export class VerifyAuthUserPhoneDto {
  @IsString()
  @MaxLength(E164_PHONE_MAX_LENGTH)
  @Matches(E164_PHONE_PATTERN, { message: E164_PHONE_MESSAGE })
  phoneNumber!: string;

  @IsString()
  @Length(4, 12)
  otp!: string;
}
