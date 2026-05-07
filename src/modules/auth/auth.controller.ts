import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
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
    private readonly configService: ConfigService,
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

  // GET form — for direct clicks on the email link. Verifies the token
  // server-side, then 302-redirects to the public web app's verify
  // landing page with `?status=success` or `?status=error&reason=…` so
  // the user sees branded content instead of raw JSON. The POST sibling
  // above stays JSON for SPAs that handle the token in-app.
  //
  // `passthrough: false` (the @Res default) — we own the response fully,
  // not letting Nest serialize anything.
  @Get('verify-email')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async verifyEmailGet(
    @Query() dto: VerifyEmailDto,
    @Res() res: Response,
  ): Promise<void> {
    const baseUrl = this.configService.getOrThrow<string>(
      'emailVerifiedRedirectUrl',
    );
    try {
      await this.usersService.verifyEmailByToken(dto.token);
      res.redirect(302, `${baseUrl}?status=success`);
    } catch (err) {
      // Map known auth failures to a stable `reason` slug the frontend
      // can branch on (e.g. show "link expired" vs a generic error).
      // Any other exception falls through to a generic error so we
      // don't leak internals into the URL.
      const reason = mapVerifyEmailError(err);
      res.redirect(
        302,
        `${baseUrl}?status=error&reason=${encodeURIComponent(reason)}`,
      );
    }
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

// Frontend-stable slugs for verification failures. Keep this list in sync
// with the web app's verify-email view's switch on `?reason=`.
function mapVerifyEmailError(err: unknown): string {
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const message = err.message.toLowerCase();
    if (status === 410 || message.includes('expired')) return 'expired';
    if (status === 400 && message.includes('already'))
      return 'already-verified';
    if (status === 400 || status === 401) return 'invalid';
    if (status === 404) return 'not-found';
  }
  return 'unknown';
}
