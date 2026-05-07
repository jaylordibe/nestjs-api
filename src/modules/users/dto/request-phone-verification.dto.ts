import { IsString, Matches, MaxLength } from 'class-validator';
import {
  E164_PHONE_MAX_LENGTH,
  E164_PHONE_MESSAGE,
  E164_PHONE_PATTERN,
} from './create-user.dto';

// Body for `POST /users/me/request-phone-verification`. Sends a one-time
// code via SMS to the supplied number; consumed by
// `PATCH /users/me/verify-phone` which checks the OTP + phoneNumber match
// before stamping `phoneNumberVerifiedAt`.
export class RequestPhoneVerificationDto {
  @IsString()
  @MaxLength(E164_PHONE_MAX_LENGTH)
  @Matches(E164_PHONE_PATTERN, { message: E164_PHONE_MESSAGE })
  phoneNumber!: string;
}
