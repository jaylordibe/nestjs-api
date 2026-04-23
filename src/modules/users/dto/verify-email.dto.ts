import { IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  @IsString()
  @Length(4, 12)
  otp!: string;
}
