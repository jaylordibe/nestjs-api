import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUserDto): Promise<User> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    try {
      return await this.prisma.user.create({
        data: {
          email: dto.email.toLowerCase(),
          password: passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          role: dto.role,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Email already in use');
      }
      throw err;
    }
  }

  findAll(): Promise<User[]> {
    return this.prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
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

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    await this.findById(id);

    const data: Prisma.UserUpdateInput = {
      email: dto.email?.toLowerCase(),
      firstName: dto.firstName,
      lastName: dto.lastName,
      role: dto.role,
      isActive: dto.isActive,
    };

    if (dto.password) {
      data.password = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    }

    try {
      return await this.prisma.user.update({ where: { id }, data });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Email already in use');
      }
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.prisma.user.delete({ where: { id } });
  }
}
