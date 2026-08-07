import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedOnly } from '../../../common/decorators/authenticated-only.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../../common/decorators/current-user.decorator';
import { BusinessInvitationsService } from './business-invitations.service';
import { AcceptedInvitationResponseDto } from './dto/accepted-invitation-response.dto';
import { AcceptBusinessInvitationDto } from './dto/accept-business-invitation.dto';

/**
 * Redemption lives on its own path, not under `/businesses/:businessId/…`.
 *
 * The redeemer does not yet belong to the business, so there is nothing for
 * `PermissionsGuard` to evaluate a tenant condition against — and requiring the
 * client to supply the `businessId` would mean trusting a tenant selector from
 * the very caller who has no authority in that tenant. The token names the
 * business; the URL must not.
 */
@ApiTags('Business Invitations')
@ApiBearerAuth()
@Controller('invitations')
export class BusinessInvitationAcceptanceController {
  constructor(private readonly service: BusinessInvitationsService) {}

  /**
   * `@AuthenticatedOnly()`, not `@Public()`.
   *
   * An invitee without an account registers through the ordinary
   * `POST /auth/register` first — which is what keeps ONE registration policy
   * (disposable-email blocking, verification, lockout) instead of forking a
   * second, less-guarded account-creation path behind a bearer token.
   *
   * No permission is required because there is none that could apply: authority
   * inside the business is precisely what this call grants.
   */
  @Post('accept')
  // 200, not Nest's default 201. A membership IS created, but not at this URL —
  // the response is an acknowledgement carrying the ids to navigate to, there
  // is no `Location` header, and repeating the call is an error rather than
  // another create. `@ApiOkResponse` below has to agree with the wire.
  @HttpCode(HttpStatus.OK)
  @AuthenticatedOnly()
  // The token is a bearer credential presented by an authenticated but
  // unauthorized caller, so brute force is bounded here rather than by the
  // global budget alone.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOkResponse({ type: AcceptedInvitationResponseDto })
  async accept(
    @Body() dto: AcceptBusinessInvitationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AcceptedInvitationResponseDto> {
    const { businessId, membershipId } = await this.service.accept(dto.token, {
      id: user.id,
      email: user.email,
    });
    return new AcceptedInvitationResponseDto(businessId, membershipId);
  }
}
