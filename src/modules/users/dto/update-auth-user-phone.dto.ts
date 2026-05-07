import { IsString, Matches, MaxLength } from 'class-validator';
import {
  E164_PHONE_MAX_LENGTH,
  E164_PHONE_MESSAGE,
  E164_PHONE_PATTERN,
} from './create-user.dto';

// Body for `PATCH /users/me/phone` — updates the phone number directly
// WITHOUT verification. Callers that need a verified number should use
// the OTP flow instead:
//   1. POST /users/me/request-phone-verification   (sends OTP to the number)
//   2. PATCH /users/me/verify-phone                 (consumes OTP, stamps phoneNumberVerifiedAt)
// The service clears `phoneNumberVerifiedAt` when this endpoint runs —
// the new number hasn't been proven owned by anyone, so any prior
// "verified" state is no longer meaningful.
export class UpdateAuthUserPhoneDto {
  @IsString()
  @MaxLength(E164_PHONE_MAX_LENGTH)
  @Matches(E164_PHONE_PATTERN, { message: E164_PHONE_MESSAGE })
  phoneNumber!: string;
}
