import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  forwardRef,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { Public } from '../../common/decorators/public.decorator';
import { Role } from '../../common/enums/role.enum';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthService, LoginResponse } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { SignUpDto } from './dto/sign-up.dto';
import { UpdateAuthUserEmailDto } from './dto/update-auth-user-email.dto';
import { UpdateAuthUserInfoDto } from './dto/update-auth-user-info.dto';
import { UpdateAuthUserPasswordDto } from './dto/update-auth-user-password.dto';
import { UpdateAuthUserProfileImageDto } from './dto/update-auth-user-profile-image.dto';
import { UpdateAuthUsernameDto } from './dto/update-auth-username.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
  ) {
  }

  @Post('sign-up')
  @Public()
  signUp(@Body() dto: SignUpDto): Promise<LoginResponse> {
    return this.authService.register(dto);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const user = await this.usersService.verifyEmail(current.id, dto.otp);
    return new UserResponseDto(user);
  }

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
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<UserResponseDto>> {
    const { data, meta } = await this.usersService.findPaginated(query);
    return {
      data: data.map((u) => new UserResponseDto(u)),
      meta,
    };
  }

  @Get('all')
  @Roles(Role.ADMIN)
  async findAll(): Promise<UserResponseDto[]> {
    const users = await this.usersService.findAll();
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
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.usersService.remove(id);
  }
}
