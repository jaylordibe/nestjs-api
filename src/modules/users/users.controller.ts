import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { MetaQueryDto } from '../../common/dto/meta-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { Public } from '../../common/decorators/public.decorator';
import { Role } from '../../common/enums/role.enum';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { GdprEraseDto } from './dto/gdpr-erase.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { RequestPhoneVerificationDto } from './dto/request-phone-verification.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateAuthUserEmailDto } from './dto/update-auth-user-email.dto';
import { UpdateAuthUserInfoDto } from './dto/update-auth-user-info.dto';
import { UpdateAuthUserPasswordDto } from './dto/update-auth-user-password.dto';
import { UpdateAuthUserPhoneDto } from './dto/update-auth-user-phone.dto';
import { UpdateAuthUserProfileImageDto } from './dto/update-auth-user-profile-image.dto';
import { UpdateAuthUsernameDto } from './dto/update-auth-username.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { VerifyAuthUserPhoneDto } from './dto/verify-auth-user-phone.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('request-password-reset')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestPasswordReset(
    @Body() dto: RequestPasswordResetDto,
  ): Promise<{ ok: true }> {
    await this.usersService.requestPasswordReset(dto.email);
    // Constant response — do not reveal whether the email is registered.
    return { ok: true };
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ ok: true }> {
    await this.usersService.resetPassword(dto);
    return { ok: true };
  }

  // Email verification is now handled by POST /auth/verify-email (link-
  // based) and POST /auth/resend-verification (public, no auth needed
  // since unverified users can't log in). The old /users/verify-email
  // and /users/me/request-email-verification endpoints were removed
  // when the OTP flow was replaced with a JWT link.

  @Get('me')
  async getAuthUser(
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.findById(current.id);
    return new UserResponseDto(user);
  }

  @Patch('me')
  async updateAuthUserInfo(
    @Body() dto: UpdateAuthUserInfoDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.updateInfo(
      current.id,
      dto,
      current.id,
    );
    return new UserResponseDto(user);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAuthUser(
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<void> {
    await this.usersService.softDelete(current.id, current.id);
  }

  // Right-to-be-forgotten / GDPR erase. Distinct from DELETE /me (which is
  // "close my account"): this also anonymizes every PII column so the row
  // can stay for FK integrity without carrying identifying data. Requires
  // re-auth via currentPassword to prevent stolen-token erasure.
  @Post('me/gdpr-erase')
  @HttpCode(HttpStatus.NO_CONTENT)
  async gdprErase(
    @Body() dto: GdprEraseDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<void> {
    await this.usersService.gdprErase(current.id, dto.currentPassword);
  }

  // Minimal GDPR "right to access" — returns the user's full row as JSON.
  // Extend this as new tables are added (bookings, messages, etc.) so the
  // dump stays complete.
  @Get('me/export')
  async exportAuthUser(
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.findById(current.id);
    return new UserResponseDto(user);
  }

  @Patch('me/username')
  async updateAuthUsername(
    @Body() dto: UpdateAuthUsernameDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.updateUsername(
      current.id,
      dto.username,
      current.id,
    );
    return new UserResponseDto(user);
  }

  @Patch('me/email')
  async updateAuthUserEmail(
    @Body() dto: UpdateAuthUserEmailDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.updateEmail(
      current.id,
      dto,
      current.id,
    );
    return new UserResponseDto(user);
  }

  @Patch('me/password')
  async updateAuthUserPassword(
    @Body() dto: UpdateAuthUserPasswordDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.updateOwnPassword(
      current.id,
      dto,
      current.id,
    );
    return new UserResponseDto(user);
  }

  @Patch('me/profile-image')
  async updateAuthUserProfileImage(
    @Body() dto: UpdateAuthUserProfileImageDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.updateProfileImage(
      current.id,
      dto.profileImageUrl,
      current.id,
    );
    return new UserResponseDto(user);
  }

  // Step 1 of the verified-phone flow — re-auth with the current password,
  // then send a one-time code via SMS to the new number. Throttled per-IP
  // (matches the password-reset request) to limit abuse of the SMS
  // provider's send budget.
  @Post('me/request-phone-verification')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestPhoneVerification(
    @Body() dto: RequestPhoneVerificationDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<{ ok: true }> {
    await this.usersService.requestPhoneVerification(
      current.id,
      dto.currentPassword,
      dto.phoneNumber,
    );
    return { ok: true };
  }

  // Step 2 of the verified-phone flow — verify the OTP and apply the new
  // number. Stamps `phoneNumberVerifiedAt = now` on success. Throttled at
  // 5/60s/IP — a 6-digit OTP with a 15-min expiry needs the rate limit to
  // bound brute-force on the verify endpoint.
  @Patch('me/verify-phone')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async verifyAuthUserPhone(
    @Body() dto: VerifyAuthUserPhoneDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.verifyAndUpdatePhoneNumber(
      current.id,
      dto,
      current.id,
    );
    return new UserResponseDto(user);
  }

  // Plain phone update — no OTP, no verification. Sets the new number and
  // clears `phoneNumberVerifiedAt` so the row no longer claims a verified
  // phone. Use the OTP flow above when you need verification.
  @Patch('me/phone')
  async updateAuthUserPhone(
    @Body() dto: UpdateAuthUserPhoneDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.updatePhoneNumber(
      current.id,
      dto.phoneNumber,
      current.id,
    );
    return new UserResponseDto(user);
  }

  @Post()
  @Roles(Role.ADMIN)
  async create(
    @Body() dto: CreateUserDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.create(dto, current.id);
    return new UserResponseDto(user);
  }

  @Get()
  @Roles(Role.ADMIN)
  async findPaginated(
    @Query() query: MetaQueryDto,
  ): Promise<PaginatedResponseDto<UserResponseDto>> {
    const { data, meta } = await this.usersService.findPaginated(query);
    return {
      data: data.map((u) => new UserResponseDto(u)),
      meta,
    };
  }

  @Get('all')
  @Roles(Role.ADMIN)
  async findAll(@Query() query: MetaQueryDto): Promise<UserResponseDto[]> {
    const users = await this.usersService.findAll(query);
    return users.map((u) => new UserResponseDto(u));
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.findById(id);
    return new UserResponseDto(user);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.update(id, dto, current.id);
    return new UserResponseDto(user);
  }

  @Patch(':id/password')
  @Roles(Role.ADMIN)
  async updatePassword(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePasswordDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.updatePasswordAsAdmin(
      id,
      dto.newPassword,
      current.id,
    );
    return new UserResponseDto(user);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<void> {
    await this.usersService.remove(id, current.id);
  }
}
