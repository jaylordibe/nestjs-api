import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  E164_PHONE_MAX_LENGTH,
  E164_PHONE_MESSAGE,
  E164_PHONE_PATTERN,
} from './create-user.dto';

// Body for `POST /users/me/request-phone-verification`. Sends a one-time
// code via SMS to the supplied number; consumed by
// `PATCH /users/me/verify-phone` which checks the OTP + phoneNumber match
// before stamping `phoneNumberVerifiedAt`.
//
// `currentPassword` is required: a stolen JWT alone shouldn't be enough to
// kick off a phone change to an attacker-controlled number. This mirrors
// the email-change request endpoint's hijack-takeover defense — re-auth
// gates the privileged kickoff.
export class RequestPhoneVerificationDto {
  @IsString()
  @MaxLength(E164_PHONE_MAX_LENGTH)
  @Matches(E164_PHONE_PATTERN, { message: E164_PHONE_MESSAGE })
  phoneNumber!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  currentPassword!: string;
}
