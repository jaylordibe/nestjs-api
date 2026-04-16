import { Exclude } from 'class-transformer';
import { Role, User } from '@prisma/client';

export class UserResponseDto {
  id!: string;
  email!: string;
  firstName!: string;
  lastName!: string;
  role!: Role;
  isActive!: boolean;
  createdAt!: Date;
  updatedAt!: Date;

  @Exclude() password!: string;

  constructor(user: User) {
    Object.assign(this, user);
  }
}
