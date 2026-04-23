import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { OtpPurpose } from '../../common/enums/otp-purpose.enum';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateAuthUserEmailDto } from './dto/update-auth-user-email.dto';
import { UpdateAuthUserInfoDto } from './dto/update-auth-user-info.dto';
import { UpdateAuthUserPasswordDto } from './dto/update-auth-user-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// OWASP 2024+ guidance. Bumping this is safe — existing hashes already
// encode their own cost factor and continue to verify correctly.
const BCRYPT_ROUNDS = 12;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUserDto, actorId: string | null): Promise<User> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    return this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        username: dto.username?.toLowerCase(),
        password: passwordHash,
        passwordChangedAt: new Date(),
        firstName: dto.firstName,
        middleName: dto.middleName,
        lastName: dto.lastName,
        phoneNumber: dto.phoneNumber,
        gender: dto.gender,
        birthday: dto.birthday,
        timezone: dto.timezone,
        profileImageUrl: dto.profileImageUrl,
        role: dto.role,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
  }

  findAll(): Promise<User[]> {
    return this.prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findPaginated(
    query: PaginationQueryDto,
  ): Promise<{ data: User[]; meta: PaginationMeta }> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 20;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.user.count(),
    ]);
    return {
      data,
      meta: {
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
      },
    };
  }

  async findById(id: string): Promise<User> {
    const user = await this.findByIdOrNull(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  findByIdOrNull(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actorId: string | null,
  ): Promise<User> {
    await this.findById(id);

    const data: Prisma.UserUpdateInput = {
      email: dto.email?.toLowerCase(),
      username: dto.username?.toLowerCase(),
      firstName: dto.firstName,
      middleName: dto.middleName,
      lastName: dto.lastName,
      phoneNumber: dto.phoneNumber,
      gender: dto.gender,
      birthday: dto.birthday,
      timezone: dto.timezone,
      profileImageUrl: dto.profileImageUrl,
      role: dto.role,
      isActive: dto.isActive,
      updatedBy: actorId,
    };

    if (dto.password) {
      data.password = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
      data.passwordChangedAt = new Date();
    }

    return this.prisma.user.update({ where: { id }, data });
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.prisma.user.delete({ where: { id } });
  }

  async updateInfo(
    userId: string,
    dto: UpdateAuthUserInfoDto,
    actorId: string,
  ): Promise<User> {
    await this.findById(userId);
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        firstName: dto.firstName,
        middleName: dto.middleName,
        lastName: dto.lastName,
        phoneNumber: dto.phoneNumber,
        gender: dto.gender,
        birthday: dto.birthday,
        timezone: dto.timezone,
        updatedBy: actorId,
      },
    });
  }

  async softDelete(userId: string, actorId: string): Promise<void> {
    await this.findById(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { isActive: false, updatedBy: actorId },
    });
  }

  async updateUsername(
    userId: string,
    username: string,
    actorId: string,
  ): Promise<User> {
    await this.findById(userId);
    return this.prisma.user.update({
      where: { id: userId },
      data: { username: username.toLowerCase(), updatedBy: actorId },
    });
  }

  async updateEmail(
    userId: string,
    dto: UpdateAuthUserEmailDto,
    actorId: string,
  ): Promise<User> {
    const user = await this.findById(userId);
    const passwordMatches = await bcrypt.compare(
      dto.currentPassword,
      user.password,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        email: dto.newEmail.toLowerCase(),
        emailVerifiedAt: null,
        updatedBy: actorId,
      },
    });
  }

  async updateOwnPassword(
    userId: string,
    dto: UpdateAuthUserPasswordDto,
    actorId: string,
  ): Promise<User> {
    const user = await this.findById(userId);
    const passwordMatches = await bcrypt.compare(
      dto.currentPassword,
      user.password,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        password: passwordHash,
        passwordChangedAt: new Date(),
        updatedBy: actorId,
      },
    });
  }

  async updatePasswordAsAdmin(
    userId: string,
    newPassword: string,
    actorId: string,
  ): Promise<User> {
    // Refuse self-target: admins changing their own password must use
    // /me/password, which requires the current password. Prevents a
    // hijacked admin session from becoming a permanent account takeover.
    if (userId === actorId) {
      throw new ForbiddenException(
        'Use /users/me/password to change your own password',
      );
    }
    await this.findById(userId);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        password: passwordHash,
        passwordChangedAt: new Date(),
        updatedBy: actorId,
      },
    });
  }

  async updateProfileImage(
    userId: string,
    profileImageUrl: string,
    actorId: string,
  ): Promise<User> {
    await this.findById(userId);
    return this.prisma.user.update({
      where: { id: userId },
      data: { profileImageUrl, updatedBy: actorId },
    });
  }

  async verifyEmail(userId: string, otp: string): Promise<User> {
    const user = await this.findById(userId);
    if (
      !user.otpHash ||
      user.otpPurpose !== OtpPurpose.EMAIL_VERIFY ||
      !user.otpExpiresAt
    ) {
      throw new BadRequestException('No email verification in progress');
    }
    if (user.otpExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Verification code has expired');
    }
    const otpMatches = await bcrypt.compare(otp, user.otpHash);
    if (!otpMatches) {
      throw new BadRequestException('Invalid verification code');
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerifiedAt: new Date(),
        otpHash: null,
        otpPurpose: null,
        otpExpiresAt: null,
        updatedBy: userId,
      },
    });
  }
}
