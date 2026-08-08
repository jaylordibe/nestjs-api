import { OmitType, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateUserDto } from './create-user.dto';

/**
 * The administrative `PATCH /users/:id` body.
 *
 * **`password` is omitted deliberately.** Inheriting the full `CreateUserDto`
 * pulled it in, and the service wrote it — which meant a caller holding only
 * `update User` could set a password without holding `resetPassword User`, two
 * permissions the catalog separates precisely because resetting somebody's
 * credential is not editing their profile. It also skipped the current-password
 * re-authentication that `/users/me/password` demands, and let an admin change
 * their own password through a route whose dedicated sibling
 * (`PATCH /users/:id/password`) explicitly refuses self-targeting.
 *
 * Password changes now reach exactly two endpoints, each with its own
 * permission, its own guards, and its own audit event. The global
 * `forbidNonWhitelisted` ValidationPipe turns the old request shape into a 400
 * rather than silently ignoring the field.
 */
export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['password'] as const),
) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
