import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../common/audit/audit.service';
import type { AppAbility } from '../../../common/authorization/app-ability';
import { EmailService } from '../../../common/email/email.service';
import { BusinessInvitationStatus } from '../../../common/enums/business-invitation-status.enum';
import { BusinessMembershipStatus } from '../../../common/enums/business-membership-status.enum';
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
import { BusinessOwnershipPolicy } from '../business-ownership.policy';
import { BusinessRoleAssignmentPolicy } from '../business-role-assignment.policy';
import {
  describeTenure,
  type MembershipTenureSnapshot,
} from '../memberships/business-memberships.service';
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
    private readonly businessOwnershipPolicy: BusinessOwnershipPolicy,
    private readonly businessRoleAssignmentPolicy: BusinessRoleAssignmentPolicy,
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
   * **No membership row is written here.** When the address already has an
   * account, the account is recorded on the invitation as `invitedUserId` and
   * nothing else changes. Writing a placeholder membership instead consumed the
   * ONE row `@@unique([businessId, userId])` allows, so re-inviting a former
   * member overwrote their `joinedAt`/`endedAt` — a manager could silently
   * rewrite somebody's employment history by sending an invitation.
   */
  async create(
    businessId: string,
    dto: CreateBusinessInvitationDto,
    ability: AppAbility,
    actorId: string,
  ): Promise<{ invitation: BusinessInvitationRow; token: string }> {
    const role = await this.businessRoleAssignmentPolicy.loadAssignableRole(
      dto.roleId,
    );
    // The SAME two bounds the roster path applies. An invitation IS a role
    // assignment, merely deferred, so enforcing this only on `POST
    // /memberships` would make the rule whichever endpoint the caller picked.
    await this.businessRoleAssignmentPolicy.assertMayAssign(
      businessId,
      actorId,
      role,
      ability,
    );

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
    const expiresAt = this.expiryFromNow();

    const { created: invitation, supersededCount } =
      await this.prisma.$transaction(async (transaction) => {
        // The same business-row lock every membership mutation takes. An invite
        // does not change the roster, but it reads it to decide whether the
        // person is already on it, and that read must not race a concurrent
        // removal or role change.
        //
        // The reads after this lock are correct only because this transaction
        // runs at READ COMMITTED. Do NOT add an `isolationLevel` here — see the
        // isolation section in `src/common/util/row-lock.util.ts`, which explains
        // why REPEATABLE READ breaks it silently, and why SERIALIZABLE breaks it
        // loudly enough to need a retry loop this codebase does not have.
        await this.businessOwnershipPolicy.lockBusiness(
          transaction,
          businessId,
        );

        // Release the partial unique index on `(business_id, email) WHERE status
        // = 'pending'` from invitations that are already dead.
        //
        // Expiry is a timestamp, not a status, so an unattended invitation stays
        // `pending` for ever. `accept` correctly refuses it on `expiresAt`, but
        // the index does not know that — it counts the row as an outstanding
        // invitation, so the INSERT below fails with P2002 and the address can
        // never be invited to this business again. Retiring it here, under the
        // lock we already hold, is what makes re-invitation possible. Done lazily
        // rather than in a sweep: a row stays `pending` after it lapses, but there
        // is no window in which `create` FAILS because of that staleness, which is
        // the only symptom that ever mattered.
        //
        // Scoped to already-lapsed rows on purpose: a LIVE pending invitation must
        // still collide, because "one outstanding invitation per address" is a
        // real rule and the P2002 handler below is what reports it. `lte` matches
        // `accept`'s definition of expired (`expiresAt <= now`) so the two cannot
        // disagree about a row on the boundary.
        const supersededExpiredInvitations =
          await transaction.businessInvitation.updateMany({
            where: {
              businessId,
              email: dto.email,
              status: BusinessInvitationStatus.PENDING,
              expiresAt: { lte: new Date() },
            },
            data: {
              status: BusinessInvitationStatus.EXPIRED,
              updatedBy: actorId,
            },
          });

        if (existingUser) {
          const membership = await transaction.businessMembership.findUnique({
            where: {
              businessId_userId: { businessId, userId: existingUser.id },
            },
            select: { status: true },
          });
          // A former member may be invited back; anyone currently attached —
          // active or suspended — is already here.
          if (
            membership &&
            (membership.status as BusinessMembershipStatus) !==
              BusinessMembershipStatus.LEFT
          ) {
            throw Errors.resourceConflict(
              'That person already has a membership in this business',
            );
          }
        }

        try {
          const created = await transaction.businessInvitation.create({
            data: {
              businessId,
              email: dto.email,
              invitedUserId: existingUser?.id ?? null,
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
          return {
            created,
            supersededCount: supersededExpiredInvitations.count,
          };
        } catch (error) {
          // The partial unique index on (business_id, email) WHERE status =
          // 'pending' is what makes "one outstanding invitation per address"
          // true under concurrency — and, now that no placeholder membership
          // exists, it is the ONLY thing that makes it true. Translate it rather
          // than letting the global filter report a raw
          // UNIQUE_CONSTRAINT_VIOLATION on a column pair the client never sent
          // as a pair.
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
        // How many already-lapsed invitations to this address this call retired
        // to make room. Normally 0.
        //
        // Who retired them and when is already durable on the rows themselves
        // (`updated_by` / `updated_at`, written by the `updateMany` above), so a
        // second audit write inside the transaction would add nothing an
        // investigator cannot already reach. What the row cannot say is that a
        // retirement happened at all without knowing to go looking — this count
        // is what puts that in the log, and it answers "why can I no longer
        // resend the invitation I sent three weeks ago?".
        supersededExpiredInvitations: supersededCount,
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

  /**
   * Withdraws a pending invitation. Accepted ones are history and immutable.
   *
   * One statement against one table. It used to be three across two, with the
   * membership deletion keyed off a SECOND lookup of the invited address — so a
   * crash between them left a business with a membership nobody had invited,
   * and a re-registered address had somebody else's membership deleted and the
   * audit event attributed to them. `invitedUserId` is resolved once, at invite
   * time, and never re-derived from a mutable string.
   */
  async revoke(
    businessId: string,
    invitationId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<void> {
    const existing = await this.findVisibleInvitation(
      businessId,
      invitationId,
      ability,
    );

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

    await this.auditService.record({
      action: 'business_invitation.revoked',
      actorId,
      targetUserId: existing.invitedUserId,
      metadata: { businessId, invitationId },
    });
  }

  /**
   * Re-sends a pending invitation on a FRESH token, invalidating the old one.
   *
   * The recovery path a business actually needs: the mail was lost, filtered,
   * or is about to expire. Without it the only remedy was revoke-then-invite,
   * which needs `delete BusinessInvitation` on top of `create` — a manager
   * holding one and not the other could raise an invitation they could never
   * repair.
   *
   * The token is ROTATED rather than re-sent, and that is the security-relevant
   * part: re-mailing the same secret would leave every earlier copy of it live
   * in every inbox and mail log it ever passed through. After a resend, exactly
   * one token opens this invitation.
   */
  async resend(
    businessId: string,
    invitationId: string,
    ability: AppAbility,
    actorId: string,
  ): Promise<BusinessInvitationRow> {
    const existing = await this.findVisibleInvitation(
      businessId,
      invitationId,
      ability,
    );
    // Re-checked at resend time, not just at invite time: the actor may have
    // been demoted since, or had `assignRole` withdrawn, and a resend re-issues
    // the same role.
    await this.businessRoleAssignmentPolicy.assertMayAssign(
      businessId,
      actorId,
      existing.role,
      ability,
    );

    const business = await this.prisma.scoped.business.findFirst({
      where: { id: businessId },
      select: { name: true },
    });
    if (!business) {
      throw Errors.resourceNotFound('Business');
    }

    const token = generateOpaqueToken();
    // Conditional on PENDING for the same reason revoke is: a resend racing an
    // acceptance must not resurrect a consumed invitation with a working token.
    const rotated = await this.prisma.businessInvitation.updateMany({
      where: { id: invitationId, status: BusinessInvitationStatus.PENDING },
      data: {
        tokenHash: hashOpaqueToken(token),
        expiresAt: this.expiryFromNow(),
        updatedBy: actorId,
      },
    });
    if (rotated.count !== 1) {
      throw Errors.resourceConflict(
        'That invitation is no longer pending and cannot be resent',
      );
    }

    await this.sendInvitationEmail(
      existing.email,
      business.name,
      existing.role.name,
      actorId,
      token,
    );
    await this.auditService.record({
      action: 'business_invitation.resent',
      actorId,
      targetUserId: existing.invitedUserId,
      // No token material, hashed or otherwise — same rule as `create`.
      metadata: { businessId, invitationId },
    });

    return this.prisma.businessInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      include: INVITATION_INCLUDE,
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
   * The caller must be the person who was invited. Without that check the token
   * alone would be sufficient, and a forwarded invitation would let anyone join
   * a business that invited somebody else specifically. Identity is established
   * two ways, and which one applies is decided by what was true at INVITE time:
   *
   *   - `invitedUserId` set — the address already had an account, so identity
   *     is the account id. Not the address: the invitee may have changed their
   *     email since, and somebody else may since have registered the old one.
   *   - `invitedUserId` null — nobody held the address, so the address IS the
   *     identity, and the caller must have PROVEN they control it. An
   *     unverified match is not proof: changing your own email needs only your
   *     password, and `emailVerifiedAt` is cleared by that change while the
   *     access token issued beforehand keeps working. Without this check, a
   *     forwarded token plus an email change is a complete bypass.
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
        invitedUserId: true,
        roleId: true,
        status: true,
        expiresAt: true,
        invitedBy: true,
        business: { select: { id: true, deletedAt: true } },
      },
    });

    // Unknown, consumed, or revoked — one indistinguishable answer, so a token
    // cannot be probed for existence.
    //
    // `EXPIRED` is deliberately NOT collapsed in here. It is only ever written
    // by `create` retiring a row that had already lapsed, so it means exactly
    // what a past `expiresAt` means — and that case is reported separately
    // below, on purpose, because the remedy differs. Folding it in here would
    // make the answer depend on whether some unrelated actor happened to
    // re-invite the same address: the same lapsed token would say "expired"
    // before the re-invite and "invalid" after it, and the *less* actionable
    // message would be the one sent at the exact moment a fresh invitation was
    // sitting in the recipient's inbox.
    const invitationStatus = invitation?.status as
      | BusinessInvitationStatus
      | undefined;
    if (
      !invitation ||
      (invitationStatus !== BusinessInvitationStatus.PENDING &&
        invitationStatus !== BusinessInvitationStatus.EXPIRED)
    ) {
      throw Errors.invitationInvalid();
    }
    // A soft-deleted business grants nothing, so joining one is meaningless.
    if (invitation.business.deletedAt) {
      throw Errors.invitationInvalid();
    }
    await this.assertIsInvitee(invitation, actor);
    // Distinguishable on purpose: the holder already proved possession of a
    // real token AND that they are the invitee, so this leaks nothing, and
    // their remedy differs. Reached only after `assertIsInvitee`, which is what
    // keeps "expired" from being observable by a mere token holder — so the
    // `EXPIRED` status is answered here rather than in the gate above.
    if (
      invitationStatus === BusinessInvitationStatus.EXPIRED ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw Errors.invitationExpired();
    }

    const now = new Date();
    let accepted: {
      membershipId: string;
      previousTenure: MembershipTenureSnapshot | null;
    };
    try {
      accepted = await this.prisma.$transaction(async (transaction) => {
        // An invitation carries a `roleId`, so acceptance is an owner-creation
        // path like any other. The caller's account was checked by `JwtStrategy`
        // one request ago and by `assertIsInvitee` a moment ago — neither under a
        // lock, so a deletion or deactivation committing in between would leave
        // an ACTIVE membership on an account that can never use it.
        //
        // User row, then business row: the order in `row-lock.util.ts`. The
        // business lock is what serialises this against every roster mutation;
        // acceptance previously took no lock at all.
        await this.businessOwnershipPolicy.assertUserMayHoldActiveMembership(
          transaction,
          actor.id,
        );
        await this.businessOwnershipPolicy.lockBusiness(
          transaction,
          invitation.businessId,
        );

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

        // Read BEFORE the upsert: this is the last moment the tenure about to be
        // overwritten is still readable, and `audit_logs` is where this template
        // keeps membership history.
        const previous = await transaction.businessMembership.findUnique({
          where: {
            businessId_userId: {
              businessId: invitation.businessId,
              userId: actor.id,
            },
          },
          select: {
            status: true,
            joinedAt: true,
            endedAt: true,
            role: { select: { name: true } },
          },
        });

        // Upsert, because someone who previously LEFT still owns the only row
        // `@@unique([businessId, userId])` will ever allow. `joinedAt` is
        // rewritten on that path deliberately — this IS the day they joined
        // again — where an invitation that was merely SENT must never touch it.
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
        return {
          membershipId: membership.id,
          previousTenure: previous ? describeTenure(previous) : null,
        };
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
        membershipId: accepted.membershipId,
        roleId: invitation.roleId,
        // Accepting an invitation is a JOIN, and a former member accepting one
        // re-uses their existing row. Same reasoning as
        // `business_membership.added`: the row is current state, so the tenure
        // it replaces only survives here.
        isRejoin: accepted.previousTenure !== null,
        previousTenure: accepted.previousTenure,
      },
    });

    return {
      businessId: invitation.businessId,
      membershipId: accepted.membershipId,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private expiryFromNow(): Date {
    return new Date(Date.now() + this.expiresInDays * 24 * 60 * 60 * 1000);
  }

  /**
   * Loads an invitation the caller is allowed to see, or 404s.
   *
   * Scoped through the ability so a caller who cannot read the invitation is
   * told it does not exist rather than that they may not touch it — a 403 here
   * would confirm that a given address was invited to a given business.
   */
  private async findVisibleInvitation(
    businessId: string,
    invitationId: string,
    ability: AppAbility,
  ) {
    const invitation = await this.prisma.businessInvitation.findFirst({
      where: this.abilityScopedQueryService.buildWhereOrEmpty(
        ability,
        'read',
        'BusinessInvitation',
        { id: invitationId, businessId },
      ),
      select: {
        id: true,
        status: true,
        email: true,
        invitedUserId: true,
        // `id` included so the row satisfies `AssignableBusinessRole` — a
        // resend re-issues this exact role and is re-checked against it.
        role: { select: { id: true, name: true, rank: true } },
      },
    });
    if (!invitation) {
      throw Errors.resourceNotFound('Business invitation');
    }
    return invitation;
  }

  /**
   * Establishes that the caller is the invitee. See `accept` for the reasoning.
   *
   * Every failure raises the SAME error the unknown-token path raises, so a
   * holder of somebody else's token learns nothing about whose it is.
   */
  private async assertIsInvitee(
    invitation: { email: string; invitedUserId: string | null },
    actor: { id: string; email: string },
  ): Promise<void> {
    if (invitation.invitedUserId) {
      if (invitation.invitedUserId !== actor.id) {
        throw Errors.invitationInvalid();
      }
      return;
    }

    if (invitation.email !== actor.email.toLowerCase()) {
      throw Errors.invitationInvalid();
    }
    const caller = await this.prisma.scoped.user.findUnique({
      where: { id: actor.id },
      select: { emailVerifiedAt: true },
    });
    if (!caller?.emailVerifiedAt) {
      throw Errors.invitationInvalid();
    }
  }

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
}
