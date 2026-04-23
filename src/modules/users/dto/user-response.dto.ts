import { Exclude } from 'class-transformer';
import { User } from '@prisma/client';
import { Gender } from '../../../common/enums/gender.enum';
import { Role } from '../../../common/enums/role.enum';

export class UserResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  createdBy!: string | null;
  updatedBy!: string | null;
  isActive!: boolean;
  firstName!: string;
  middleName!: string | null;
  lastName!: string;
  username!: string | null;
  email!: string;
  role!: Role;
  emailVerifiedAt!: Date | null;
  phoneNumber!: string | null;
  gender!: Gender | null;
  profileImageUrl!: string | null;
  birthday!: Date | null;
  timezone!: string | null;

  @Exclude() password!: string;
  @Exclude() otpHash!: string | null;
  @Exclude() otpPurpose!: string | null;
  @Exclude() otpExpiresAt!: Date | null;

  constructor(user: User) {
    Object.assign(this, user);
  }
}
