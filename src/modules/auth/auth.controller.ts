import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UsersService } from '../users/users.service';
import { AuthService, LoginResponse, RegisterResponse } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(@Body() dto: RegisterDto): Promise<RegisterResponse> {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<LoginResponse> {
    return this.authService.login(dto);
  }

  // POST form — for frontends that extract the token from the email link
  // and submit it via JSON.
  @Post('verify-email')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async verifyEmailPost(
    @Body() dto: VerifyEmailDto,
  ): Promise<{ verified: true }> {
    await this.usersService.verifyEmailByToken(dto.token);
    return { verified: true };
  }

  // GET form — for direct clicks on the email link (no frontend page
  // needed). Same handler semantics as the POST.
  @Get('verify-email')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async verifyEmailGet(
    @Query() dto: VerifyEmailDto,
  ): Promise<{ verified: true }> {
    await this.usersService.verifyEmailByToken(dto.token);
    return { verified: true };
  }

  // Resend the verification link. Strictly throttled and silent about
  // whether the email exists or is already verified — always 200.
  @Post('resend-verification')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async resendVerification(
    @Body() dto: ResendVerificationDto,
  ): Promise<{ ok: true }> {
    await this.usersService.resendEmailVerification(dto.email);
    return { ok: true };
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async me(
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.findById(current.id);
    return new UserResponseDto(user);
  }

  // Revoke the exact token this request arrived on. Other sessions (other
  // devices) stay active. Client should also discard its local copy.
  @Post('logout')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentUser() current: AuthenticatedUser): Promise<void> {
    await this.authService.logout(current);
  }

  // "Sign me out everywhere" — invalidates every active token for the user
  // via the passwordChangedAt mechanism. Use when the user suspects their
  // account is compromised but isn't ready to change their password yet.
  @Post('logout-all')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(@CurrentUser() current: AuthenticatedUser): Promise<void> {
    await this.authService.logoutAll(current.id);
  }
}
