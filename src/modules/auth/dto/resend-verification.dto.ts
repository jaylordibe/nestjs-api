import { IsEmail } from 'class-validator';

export class ResendVerificationDto {
  // The endpoint always returns 200 regardless of whether this email is
  // registered or already verified — no enumeration. Strict per-IP
  // throttle guards against email-bomb abuse.
  @IsEmail()
  email!: string;
}
