import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUserDto, actorId: string | null): Promise<User> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    try {
      return await this.prisma.user.create({
        data: {
          email: dto.email.toLowerCase(),
          username: dto.username?.toLowerCase(),
          password: passwordHash,
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
    } catch (err) {
      throw this.mapKnownError(err);
    }
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
    }

    try {
      return await this.prisma.user.update({ where: { id }, data });
    } catch (err) {
      throw this.mapKnownError(err);
    }
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.prisma.user.delete({ where: { id } });
  }

  private mapKnownError(err: unknown): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const target = err.meta?.target;
      const fields = Array.isArray(target) ? target : target ? [target] : [];
      if (fields.includes('username')) {
        return new ConflictException('Username already in use');
      }
      return new ConflictException('Email already in use');
    }
    return err;
  }
}
