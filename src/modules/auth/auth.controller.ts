import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthenticatedOnly } from '../../common/decorators/authenticated-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { OperationAcknowledgementDto } from '../../common/dto/operation-acknowledgement.dto';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { EmailVerificationResponseDto } from './dto/email-verification-response.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { RegisterResponseDto } from './dto/register-response.dto';
import type { RefreshTokenContext } from './refresh-token.service';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';

// Device provenance recorded against an issued refresh token, for the audit
// trail. `request.ip` already honours `trust proxy` (set in main.ts), so this
// is the client address rather than the load balancer's. Both fields are
// best-effort: a missing header must never be a reason to fail a login.
function readRefreshTokenContext(request: Request): RefreshTokenContext {
  return {
    userAgent: request.get('user-agent') ?? null,
    ipAddress: request.ip ?? null,
  };
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  @Post('register')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    return this.authService.register(dto);
  }

  @Post('login')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: LoginResponseDto })
  login(
    @Body() dto: LoginDto,
    @Req() request: Request,
  ): Promise<LoginResponseDto> {
    return this.authService.login(dto, readRefreshTokenContext(request));
  }

  /**
   * Exchanges a refresh token for a new access + refresh pair.
   *
   * `@Public()` by necessity: a client arrives here precisely because its
   * access token has expired, so it has no bearer credential to present. The
   * refresh token in the body IS the credential.
   *
   * Throttled harder than login. A legitimate client refreshes once per access
   * token lifetime — a handful of times an hour at most — so anything
   * approaching this ceiling is either a broken retry loop or someone walking
   * stolen tokens, and neither deserves the bandwidth.
   */
  @Post('refresh')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: LoginResponseDto })
  refresh(
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
  ): Promise<LoginResponseDto> {
    return this.authService.refresh(
      dto.refreshToken,
      readRefreshTokenContext(request),
    );
  }

  // POST form — for frontends that extract the token from the email link
  // and submit it via JSON.
  @Post('verify-email')
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: EmailVerificationResponseDto })
  async verifyEmailPost(
    @Body() dto: VerifyEmailDto,
  ): Promise<EmailVerificationResponseDto> {
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
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiResponse({
    status: HttpStatus.FOUND,
    description:
      'Redirects (302) to the web app email-verification result page — ?status=success or ?status=error&reason=<slug>. No response body.',
  })
  async verifyEmailGet(
    @Query() dto: VerifyEmailDto,
    @Res() response: Response,
  ): Promise<void> {
    const baseUrl = this.configService.getOrThrow<string>(
      'emailVerifiedRedirectUrl',
    );
    try {
      await this.usersService.verifyEmailByToken(dto.token);
      response.redirect(302, `${baseUrl}?status=success`);
    } catch (error) {
      // Map known auth failures to a stable `reason` slug the frontend
      // can branch on (e.g. show "link expired" vs a generic error).
      // Any other exception falls through to a generic error so we
      // don't leak internals into the URL.
      const reason = mapVerifyEmailError(error);
      response.redirect(
        302,
        `${baseUrl}?status=error&reason=${encodeURIComponent(reason)}`,
      );
    }
  }

  // Resend the verification link. Strictly throttled and silent about
  // whether the email exists or is already verified — always 200.
  @Post('resend-verification')
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OperationAcknowledgementDto })
  async resendVerification(
    @Body() dto: ResendVerificationDto,
  ): Promise<{ ok: true }> {
    await this.usersService.resendEmailVerification(dto.email);
    return { ok: true };
  }

  // Ends THIS device's session: blocklists the access token this request
  // arrived on and revokes the refresh chain it belongs to. Other devices stay
  // signed in. The client should also discard both tokens locally.
  //
  // Sending `refreshToken` is optional but strongly recommended — without it
  // only the access token dies, and the refresh token can mint a new one.
  @Post('logout')
  @AuthenticatedOnly()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: LogoutDto,
  ): Promise<void> {
    await this.authService.logout(currentUser, dto.refreshToken);
  }

  // "Sign me out everywhere" — invalidates every active access token via the
  // passwordChangedAt mechanism AND revokes every refresh token the user holds.
  // Use when the user suspects their account is compromised but isn't ready to
  // change their password yet.
  @Post('logout-all')
  @AuthenticatedOnly()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<void> {
    await this.authService.logoutAll(currentUser.id);
  }
}

// Frontend-stable slugs for verification failures. Keep this list in sync
// with the web app's verify-email view's switch on `?reason=`.
function mapVerifyEmailError(error: unknown): string {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const message = error.message.toLowerCase();
    if (status === 410 || message.includes('expired')) return 'expired';
    if (status === 400 && message.includes('already'))
      return 'already-verified';
    if (status === 400 || status === 401) return 'invalid';
    if (status === 404) return 'not-found';
  }
  return 'unknown';
}
