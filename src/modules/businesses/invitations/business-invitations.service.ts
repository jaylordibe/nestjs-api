import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../common/audit/audit.service';
import type { AppAbility } from '../../../common/authorization/app-ability';
import { EmailService } from '../../../common/email/email.service';
import { BusinessInvitationStatus } from '../../../common/enums/business-invitation-status.enum';
import { BusinessMembershipStatus } from '../../../common/enums/business-membership-status.enum';
import { RoleScope } from '../../../common/enums/role-scope.enum';
import { Errors } from '../../../common/errors/errors';
import { buildOrderBy, MetaQueryDto } from '../../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../../common/dto/paginated-response.dto';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../../../common/util/opaque-token.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { AbilityScopedQueryService } from '../../authorization/ability-scoped-query.service';
import { PermissionLoaderService } from '../../authorization/permission-loader.service';
import { CreateBusinessInvitationDto } from './dto/create-business-invitation.dto';
import type { BusinessInvitationRow } from './dto/business-invitation-response.dto';

const INVITATION_INCLUDE = {
  role: { select: { id: true, name: true, rank: true } },
} as const;

// Thrown out of the acceptance transaction when the conditional consume finds
// no pending row — i.e. somebody else redeemed the same token first. A private
// sentinel rather than a public error so the transaction rolls back cleanly and
// the caller-facing error is chosen once, outside it.
class InvitationAlreadyConsumedError extends Error {}

@Injectable()
export class BusinessInvitationsService {
  private readonly logger = new Logger(BusinessInvitationsService.name);
  private readonly expiresInDays: number;
  private readonly webBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly abilityScopedQueryService: AbilityScopedQueryService,
    private readonly permissionLoaderService: PermissionLoaderService,
    private readonly emailService: EmailService,
    configService: ConfigService,
  ) {
    this.expiresInDays = configService.getOrThrow<number>(
      'businessInvitation.expiresInDays',
    );
    this.webBaseUrl = configService.getOrThrow<string>('webBaseUrl');
  }

  /**
   * Invites an email address to a business.
   *
   * The address need not belong to a user — that is the entire reason this is a
   * separate model from `BusinessMembership`, whose `userId` is NOT NULL.
   *
   * When the address DOES already have an account, an INVITED membership row is
   * written alongside the invitation. That reserves the (business, user) slot,
   * so the roster shows the person as pending and a second invitation cannot be
   * raised behind the first.
   */
  async create(
    businessId: string,
    dto: CreateBusinessInvitationDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<{ invitation: BusinessInvitationRow; token: string }> {
    const role = await this.loadAssignableBusinessRole(dto.roleId);
    await this.assertRankPermits(businessId, actorId, role.rank, ability);

    const business = await this.prisma.scoped.business.findFirst({
      where: { id: businessId },
      select: { id: true, name: true },
    });
    if (!business) {
      throw Errors.resourceNotFound('Business');
    }

    // May be absent — inviting a stranger is the normal case.
    const existingUser = await this.prisma.scoped.user.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });

    const token = generateOpaqueToken();
    const expiresAt = new Date(
      Date.now() + this.expiresInDays * 24 * 60 * 60 * 1000,
    );

    const invitation = await this.prisma.$transaction(async (transaction) => {
      if (existingUser) {
        const membership = await transaction.businessMembership.findUnique({
          where: {
            businessId_userId: { businessId, userId: existingUser.id },
          },
          select: { id: true, status: true },
        });
        const status = membership?.status as
          | BusinessMembershipStatus
          | undefined;
        if (
          membership &&
          status !== BusinessMembershipStatus.LEFT &&
          status !== BusinessMembershipStatus.INVITED
        ) {
          throw Errors.resourceConflict(
            'That person already has a membership in this business',
          );
        }

        // Reserve the slot. `joinedAt` stays null — the DB CHECK requires it
        // absent for INVITED, and they have not joined anything yet.
        await transaction.businessMembership.upsert({
          where: {
            businessId_userId: { businessId, userId: existingUser.id },
          },
          create: {
            businessId,
            userId: existingUser.id,
            roleId: role.id,
            status: BusinessMembershipStatus.INVITED,
            invitedBy: actorId,
            createdBy: actorId,
            updatedBy: actorId,
          },
          update: {
            roleId: role.id,
            status: BusinessMembershipStatus.INVITED,
            joinedAt: null,
            endedAt: null,
            invitedBy: actorId,
            updatedBy: actorId,
          },
        });
      }

      try {
        return await transaction.businessInvitation.create({
          data: {
            businessId,
            email: dto.email,
            roleId: role.id,
            tokenHash: hashOpaqueToken(token),
            status: BusinessInvitationStatus.PENDING,
            invitedBy: actorId,
            expiresAt,
            createdBy: actorId,
            updatedBy: actorId,
          },
          include: INVITATION_INCLUDE,
        });
      } catch (error) {
        // The partial unique index on (business_id, email) WHERE status =
        // 'pending' is what makes "one outstanding invitation per address"
        // true under concurrency. Translate it rather than letting the global
        // filter report a raw UNIQUE_CONSTRAINT_VIOLATION on a column pair the
        // client never sent as a pair.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw Errors.resourceConflict(
            'That address already has a pending invitation to this business',
          );
        }
        throw error;
      }
    });

    await this.sendInvitationEmail(
      dto.email,
      business.name,
      role.name,
      actorId,
      token,
    );
    await this.auditService.record({
      action: 'business_invitation.created',
      actorId,
      targetUserId: existingUser?.id ?? null,
      // The token is NOT recorded, not even hashed: an audit log is read by
      // more people than the invitations table is.
      metadata: {
        businessId,
        invitationId: invitation.id,
        roleId: role.id,
        roleName: role.name,
      },
    });

    return { invitation, token };
  }

  async findPaginated(
    businessId: string,
    query: MetaQueryDto,
    ability: AppAbility,
  ): Promise<{ data: BusinessInvitationRow[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const where = this.abilityScopedQueryService.buildWhereOrEmpty(
      ability,
      'read',
      'BusinessInvitation',
      { businessId },
    );

    const [data, total] = await this.prisma.$transaction([
      this.prisma.businessInvitation.findMany({
        where,
        include: INVITATION_INCLUDE,
        orderBy: buildOrderBy(
          query,
          ['createdAt', 'expiresAt'] as const,
          'createdAt',
        ),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.businessInvitation.count({ where }),
    ]);
    return {
      data,
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  /** Withdraws a pending invitation. Accepted ones are history and immutable. */
  async revoke(
    businessId: string,
    invitationId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<void> {
    const existing = await this.prisma.businessInvitation.findFirst({
      where: this.abilityScopedQueryService.buildWhereOrEmpty(
        ability,
        'read',
        'BusinessInvitation',
        { id: invitationId, businessId },
      ),
      select: { id: true, status: true, email: true },
    });
    if (!existing) {
      throw Errors.resourceNotFound('Business invitation');
    }

    // Conditional, not a read-then-write: revoking and accepting race, and the
    // loser must not silently overwrite the winner.
    const revoked = await this.prisma.businessInvitation.updateMany({
      where: { id: invitationId, status: BusinessInvitationStatus.PENDING },
      data: {
        status: BusinessInvitationStatus.REVOKED,
        revokedAt: new Date(),
        revokedBy: actorId,
        updatedBy: actorId,
      },
    });
    if (revoked.count !== 1) {
      throw Errors.resourceConflict(
        'That invitation is no longer pending and cannot be revoked',
      );
    }

    // Drop the placeholder membership if one was reserved and never accepted.
    const invitedUser = await this.prisma.scoped.user.findFirst({
      where: { email: existing.email },
      select: { id: true },
    });
    if (invitedUser) {
      await this.prisma.businessMembership.deleteMany({
        where: {
          businessId,
          userId: invitedUser.id,
          status: BusinessMembershipStatus.INVITED,
        },
      });
    }

    await this.auditService.record({
      action: 'business_invitation.revoked',
      actorId,
      targetUserId: invitedUser?.id ?? null,
      metadata: { businessId, invitationId },
    });
  }

  /**
   * Redeems an invitation.
   *
   * Requires an authenticated caller, which is what lets this reuse the
   * platform's ONE registration policy rather than forking it: someone without
   * an account registers through `POST /auth/register` (disposable-email
   * blocking, verification, lockout, all of it), verifies, and then presents
   * the same still-valid token here. An acceptance endpoint that minted
   * accounts would be a second, less-guarded front door into user creation.
   *
   * The caller's email must MATCH the invited address. Without that check the
   * token alone would be sufficient, and a forwarded invitation would let
   * anyone join a business that invited somebody else specifically.
   *
   * Replay safety is a conditional UPDATE out of `pending` inside the same
   * transaction that writes the membership: two simultaneous redemptions of one
   * token both attempt it, exactly one matches a row, and the loser's entire
   * transaction — membership included — rolls back.
   */
  async accept(
    token: string,
    actor: { id: string; email: string },
  ): Promise<{ businessId: string; membershipId: string }> {
    const invitation = await this.prisma.businessInvitation.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: {
        id: true,
        businessId: true,
        email: true,
        roleId: true,
        status: true,
        expiresAt: true,
        invitedBy: true,
        business: { select: { id: true, deletedAt: true } },
      },
    });

    // Unknown, consumed, or revoked — one indistinguishable answer, so a token
    // cannot be probed for existence.
    if (
      !invitation ||
      (invitation.status as BusinessInvitationStatus) !==
        BusinessInvitationStatus.PENDING
    ) {
      throw Errors.invitationInvalid();
    }
    // A soft-deleted business grants nothing, so joining one is meaningless.
    if (invitation.business.deletedAt) {
      throw Errors.invitationInvalid();
    }
    if (invitation.email !== actor.email.toLowerCase()) {
      throw Errors.invitationInvalid();
    }
    // Distinguishable on purpose: the holder already proved possession of a
    // real token, so this leaks nothing, and their remedy differs.
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw Errors.invitationExpired();
    }

    const now = new Date();
    let membershipId: string;
    try {
      membershipId = await this.prisma.$transaction(async (transaction) => {
        const consumed = await transaction.businessInvitation.updateMany({
          where: {
            id: invitation.id,
            status: BusinessInvitationStatus.PENDING,
            expiresAt: { gt: now },
          },
          data: {
            status: BusinessInvitationStatus.ACCEPTED,
            acceptedAt: now,
            acceptedBy: actor.id,
            updatedBy: actor.id,
          },
        });
        if (consumed.count !== 1) {
          throw new InvitationAlreadyConsumedError();
        }

        // Upsert, because the invitation may already have reserved an INVITED
        // row — and because someone who previously LEFT still owns the only row
        // `@@unique([businessId, userId])` will ever allow.
        const membership = await transaction.businessMembership.upsert({
          where: {
            businessId_userId: {
              businessId: invitation.businessId,
              userId: actor.id,
            },
          },
          create: {
            businessId: invitation.businessId,
            userId: actor.id,
            roleId: invitation.roleId,
            status: BusinessMembershipStatus.ACTIVE,
            joinedAt: now,
            invitedBy: invitation.invitedBy,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
          update: {
            roleId: invitation.roleId,
            status: BusinessMembershipStatus.ACTIVE,
            joinedAt: now,
            endedAt: null,
            updatedBy: actor.id,
          },
          select: { id: true },
        });
        return membership.id;
      });
    } catch (error) {
      if (error instanceof InvitationAlreadyConsumedError) {
        throw Errors.invitationInvalid();
      }
      throw error;
    }

    // Their authority changed the instant the transaction committed.
    await this.permissionLoaderService.invalidateUser(actor.id);
    await this.auditService.record({
      action: 'business_invitation.accepted',
      actorId: actor.id,
      targetUserId: actor.id,
      metadata: {
        businessId: invitation.businessId,
        invitationId: invitation.id,
        membershipId,
      },
    });

    return { businessId: invitation.businessId, membershipId };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async sendInvitationEmail(
    email: string,
    businessName: string,
    roleName: string,
    actorId: string,
    token: string,
  ): Promise<void> {
    const inviter = await this.prisma.scoped.user.findUnique({
      where: { id: actorId },
      select: { firstName: true, lastName: true },
    });
    const inviterName = inviter
      ? `${inviter.firstName} ${inviter.lastName}`.trim()
      : 'Someone';

    try {
      await this.emailService.sendTemplate('business-invitation', email, {
        businessName,
        inviterName,
        roleName,
        acceptUrl: `${this.webBaseUrl}/invitations/accept?token=${encodeURIComponent(token)}`,
        expiresInDays: this.expiresInDays,
      });
    } catch (error) {
      // Best-effort, matching every other transactional send in this codebase.
      // The invitation row is already committed and the token is already in the
      // response, so a provider outage must not roll back a successful invite —
      // the business can resend.
      this.logger.error(
        `Failed to send business invitation email: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async loadAssignableBusinessRole(roleId: string) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, name: true, rank: true, scope: true },
    });
    if (!role) {
      throw Errors.resourceNotFound('Role');
    }
    if ((role.scope as RoleScope) !== RoleScope.BUSINESS) {
      throw Errors.roleNotAssignable();
    }
    return role;
  }

  /**
   * The same ceiling `BusinessMembershipsService` enforces, applied at INVITE
   * time.
   *
   * Checking only at acceptance would be too late in the way that matters: the
   * invitation email would already have gone out promising a role the inviter
   * was never allowed to grant, and the refusal would land on the invitee.
   */
  private async assertRankPermits(
    businessId: string,
    actorId: string,
    targetRank: number,
    ability: AppAbility,
  ): Promise<void> {
    if (ability.can('manage', 'all')) return;

    const actorMembership = await this.prisma.businessMembership.findUnique({
      where: { businessId_userId: { businessId, userId: actorId } },
      select: { status: true, role: { select: { rank: true } } },
    });
    if (
      !actorMembership ||
      (actorMembership.status as BusinessMembershipStatus) !==
        BusinessMembershipStatus.ACTIVE
    ) {
      throw Errors.roleNotAssignable();
    }
    if (targetRank > actorMembership.role.rank) {
      throw Errors.roleNotAssignable();
    }
  }
}
