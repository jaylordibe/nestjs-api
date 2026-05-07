import { ApiHideProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { User } from '@prisma/client';
import { Gender } from '../../../common/enums/gender.enum';
import { Role } from '../../../common/enums/role.enum';

export class UserResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  // Audit-trail columns are scrubbed from the frontend response — only
  // `createdAt`/`updatedAt` are exposed. `createdBy`/`updatedBy`/
  // `deletedAt`/`deletedBy` stay in the DB for reporting + forensics
  // but are never surfaced via the API. Pattern applies to every
  // resource — see CLAUDE.md "Response DTO" under "Generating a new
  // resource".
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;
  @ApiHideProperty() @Exclude() deletedAt!: Date | null;
  @ApiHideProperty() @Exclude() deletedBy!: string | null;
  isActive!: boolean;
  firstName!: string;
  middleName!: string | null;
  lastName!: string;
  username!: string | null;
  email!: string;
  role!: Role;
  @ApiHideProperty() @Exclude() emailVerifiedAt!: Date | null;
  phoneNumber!: string | null;
  phoneNumberVerifiedAt!: Date | null;
  gender!: Gender | null;
  profileImageUrl!: string | null;
  birthday!: Date | null;
  timezone!: string | null;

  // `@Exclude()` strips these from the JSON response at runtime (via
  // ClassSerializerInterceptor). `@ApiHideProperty()` hides them from
  // the Swagger schema at build time — the two layers are independent,
  // so both decorators are needed to keep the docs honest.
  @ApiHideProperty() @Exclude() password!: string;
  @ApiHideProperty() @Exclude() passwordChangedAt!: Date | null;
  @ApiHideProperty() @Exclude() failedLoginCount!: number;
  @ApiHideProperty() @Exclude() lockedUntil!: Date | null;
  @ApiHideProperty() @Exclude() otpHash!: string | null;
  @ApiHideProperty() @Exclude() otpPurpose!: string | null;
  @ApiHideProperty() @Exclude() otpExpiresAt!: Date | null;

  constructor(user: User) {
    Object.assign(this, user);
  }
}
