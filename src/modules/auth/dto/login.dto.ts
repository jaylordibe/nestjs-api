import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  // Email address OR username — both are accepted. Usernames can never
  // contain '@' (enforced by CreateUserDto's pattern), so the two namespaces
  // can't collide. Matched case-insensitively (both are stored lowercase).
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  identifier!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
