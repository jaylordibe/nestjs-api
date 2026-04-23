import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './strategies/jwt.strategy';

export interface LoginResponse {
  accessToken: string;
  user: UserResponseDto;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService {
  // Constant dummy hash used when the email doesn't exist, so login timing
  // doesn't leak whether an account is registered. Lazily computed on first
  // use so it matches BCRYPT_ROUNDS without hardcoding the value.
  private dummyHash: string | null = null;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async register(dto: RegisterDto): Promise<LoginResponse> {
    const user = await this.usersService.create(dto, null);
    return this.buildLoginResponse(user);
  }

  async login(dto: LoginDto): Promise<LoginResponse> {
    const user = await this.usersService.findByEmail(dto.email);

    // findByEmail uses the scoped client — soft-deleted users return null,
    // so this branch treats them identically to "email doesn't exist"
    // (down to the dummy bcrypt compare for timing).

    // Check lockout *before* doing work. Still do a dummy compare so locked
    // accounts can't be distinguished from wrong-password by timing either.
    if (user && user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await bcrypt.compare(dto.password, await this.getDummyHash());
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.password ?? (await this.getDummyHash()),
    );

    if (!user || !user.isActive || !passwordMatches) {
      if (user) {
        await this.registerFailedAttempt(user.id, user.failedLoginCount);
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    }

    return this.buildLoginResponse(user);
  }

  private async registerFailedAttempt(
    userId: string,
    previousCount: number,
  ): Promise<void> {
    const nextCount = previousCount + 1;
    const reachedThreshold = nextCount >= MAX_FAILED_ATTEMPTS;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: reachedThreshold ? 0 : nextCount,
        lockedUntil: reachedThreshold
          ? new Date(Date.now() + LOCKOUT_DURATION_MS)
          : undefined,
      },
    });
  }

  private async getDummyHash(): Promise<string> {
    if (!this.dummyHash) {
      // 12 rounds matches UsersService.BCRYPT_ROUNDS. Duplicated as a const
      // here to avoid coupling this module to the users module's internals.
      this.dummyHash = await bcrypt.hash('dummy-password-for-timing', 12);
    }
    return this.dummyHash;
  }

  private buildLoginResponse(
    user: Awaited<ReturnType<UsersService['findById']>>,
  ): LoginResponse {
    const payload: JwtPayload = { sub: user.id };
    return {
      accessToken: this.jwtService.sign(payload),
      user: new UserResponseDto(user),
    };
  }
}
