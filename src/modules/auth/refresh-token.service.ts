import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/errors';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../../common/util/opaque-token.util';
import { PrismaService } from '../../prisma/prisma.service';

// Where a refresh token came from, captured at issue for the audit trail.
// Optional throughout: tokens are also issued outside an HTTP context (tests,
// future service-to-service flows), and a missing user agent must never be a
// reason to fail a login.
export interface RefreshTokenContext {
  readonly userAgent?: string | null;
  readonly ipAddress?: string | null;
}

export interface IssuedRefreshToken {
  // The only time the plaintext exists. It is returned to the caller and then
  // forgotten — the database holds a digest.
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Issues, rotates, and revokes refresh tokens.
 *
 * The model is OAuth 2.0's, and the reason is worth stating because it is the
 * whole justification for this file's existence: an access token is a signed
 * assertion, so it cannot be taken back before it expires. Making it
 * short-lived bounds that. But short-lived access tokens are only usable if
 * something long-lived can mint fresh ones — hence a refresh token, which is
 * stored server-side precisely so it CAN be withdrawn.
 *
 * Rotation with reuse detection follows RFC 9700 §4.14.2 (OAuth 2.0 Security
 * Best Current Practice): every exchange consumes the presented token and
 * issues a new one in the same family, and re-presenting a consumed token is
 * treated as evidence of theft — the entire family is revoked, logging out both
 * the attacker and the legitimate holder. That is the intended outcome: the
 * alternative is letting a thief ride a stolen token indefinitely while the
 * real user notices nothing.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly lifetimeDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.lifetimeDays = configService.getOrThrow<number>(
      'jwt.refreshExpiresInDays',
    );
  }

  /** Starts a NEW session chain. Use at login, never at rotation. */
  async issue(
    userId: string,
    context: RefreshTokenContext = {},
  ): Promise<IssuedRefreshToken> {
    return this.persist(userId, randomUUID(), context);
  }

  /**
   * Exchanges a refresh token for a fresh one in the same family.
   *
   * Returns the owning user id alongside the new token so the caller can mint a
   * matching access token without a second lookup.
   */
  async rotate(
    presentedToken: string,
    context: RefreshTokenContext = {},
  ): Promise<{ userId: string; refreshToken: IssuedRefreshToken }> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(presentedToken) },
      select: {
        id: true,
        userId: true,
        familyId: true,
        expiresAt: true,
        consumedAt: true,
        revokedAt: true,
      },
    });

    // Unknown token. No family to revoke, nothing to audit against a user.
    if (!existing) {
      throw Errors.refreshTokenInvalid();
    }

    // ── the SEQUENTIAL replay branch ─────────────────────────────────────
    // A correct client discards a refresh token the moment it exchanges it, so
    // a second presentation means the token was captured. We cannot tell which
    // of the two presenters is the thief, so we trust neither and end the whole
    // chain. The legitimate user is forced to sign in again — an inconvenience
    // that is strictly preferable to an attacker holding a renewable session.
    if (existing.consumedAt) {
      await this.handleReplay(existing.userId, existing.familyId, context);
    }

    if (existing.revokedAt || existing.expiresAt.getTime() <= Date.now()) {
      throw Errors.refreshTokenInvalid();
    }

    // Consume-then-issue in one transaction: a crash between the two must not
    // leave a session that is neither usable nor closeable.
    //
    // The family lock is what makes the CONCURRENT case correct. Without it,
    // `revokeFamily` running elsewhere cannot see the replacement row this
    // transaction has inserted but not yet committed, so a family revoked on
    // confirmed theft evidence would leave one live token behind. Taking the
    // same lock in both places makes rotation and revocation mutually
    // exclusive.
    let lostTheConsumeRace = false;
    try {
      const refreshToken = await this.prisma.$transaction(
        async (transaction) => {
          await lockFamily(transaction, existing.familyId);

          const consumed = await transaction.refreshToken.updateMany({
            where: { id: existing.id, consumedAt: null },
            data: { consumedAt: new Date() },
          });
          if (consumed.count !== 1) {
            // ── the CONCURRENT replay branch ───────────────────────────
            // Both racers read `existing` OUTSIDE this transaction, so both
            // saw `consumedAt: null` and both skipped the branch above. From
            // the server's side this is indistinguishable from a sequential
            // replay and must be treated identically.
            //
            // It previously returned a bare 401 here. That silently defeated
            // RFC 9700 §4.14.2 reuse detection about half the time: an
            // attacker racing the legitimate client won often enough to keep a
            // live renewable family, while the real user — told only "your
            // session has expired" — simply signed in again, and no audit row,
            // log line, or revocation ever recorded that a token had been
            // presented twice.
            lostTheConsumeRace = true;
            throw new LostConsumeRaceError();
          }
          return this.persist(
            existing.userId,
            existing.familyId,
            context,
            transaction,
          );
        },
      );
      return { userId: existing.userId, refreshToken };
    } catch (error) {
      if (!lostTheConsumeRace) throw error;
    }

    // Deliberately OUTSIDE the transaction, which has now rolled back. Revoking
    // the family inside it would roll the revocation back along with the failed
    // rotation — the family would stay alive on the very evidence that should
    // have ended it.
    await this.handleReplay(existing.userId, existing.familyId, context);
    // `handleReplay` always throws; this is unreachable and exists only to
    // satisfy the compiler's return analysis.
    throw Errors.refreshTokenInvalid();
  }

  /**
   * Ends a family on evidence of token theft, and records it.
   *
   * One implementation for both replay paths — the sequential re-presentation
   * and the lost consume race. They are the same event and must produce the
   * same revocation, the same audit row, and the same opaque 401; keeping them
   * as two code paths is how one of them ends up missing a step.
   *
   * Always throws.
   */
  private async handleReplay(
    userId: string,
    familyId: string,
    context: RefreshTokenContext,
  ): Promise<never> {
    await this.revokeFamily(familyId);
    this.logger.warn(
      `Refresh token replay detected for user ${userId}; ` +
        `revoked session family ${familyId}`,
    );
    await this.auditService.record({
      action: 'auth.refresh_token.replay_detected',
      actorId: userId,
      targetUserId: userId,
      metadata: {
        familyId,
        // The presented token is NOT recorded, even hashed: an audit log is
        // read by more people than the tokens table is.
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    });
    throw Errors.refreshTokenInvalid();
  }

  /**
   * Ends one session chain — the device that presented this token.
   *
   * Takes the plaintext rather than a family id so `POST /auth/logout` can hand
   * over exactly what the client holds. An unknown token is a no-op, not an
   * error: logout must never be the endpoint that reveals whether a token is
   * genuine, and a client trying to sign out has already got what it wanted.
   */
  async revokeByToken(presentedToken: string): Promise<void> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(presentedToken) },
      select: { familyId: true },
    });
    if (!existing) return;
    await this.revokeFamily(existing.familyId);
  }

  /**
   * Every chain in a family — used on replay detection and per-device logout.
   *
   * Takes the same family lock `rotate` does. A bare `updateMany` cannot see a
   * replacement row that a concurrent, still-open rotation has inserted, so
   * that row would commit afterwards with `revokedAt: null` and survive a
   * revocation issued on confirmed theft evidence. Serialising the two closes
   * the window: either the rotation finishes first and its replacement is swept,
   * or the revocation lands first and the rotation's own guard rejects it.
   */
  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await lockFamily(transaction, familyId);
      await transaction.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  /** Every session this user has anywhere. Pairs with logout-all. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Retention sweep. Expired rows authorize nothing, but they still hold a
   * user id and a device fingerprint, so they are deleted rather than kept.
   * Revoked-but-unexpired rows are retained until their natural expiry — they
   * are what makes replay detectable.
   */
  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  }

  private async persist(
    userId: string,
    familyId: string,
    context: RefreshTokenContext,
    transaction?: Pick<PrismaService, 'refreshToken'>,
  ): Promise<IssuedRefreshToken> {
    const token = generateOpaqueToken();
    const expiresAt = new Date(
      Date.now() + this.lifetimeDays * 24 * 60 * 60 * 1000,
    );
    await (transaction ?? this.prisma).refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashOpaqueToken(token),
        expiresAt,
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    });
    return { token, expiresAt };
  }
}

// Serialises every operation touching one session family.
//
// The lock is taken on the family's EXISTING rows rather than on a single
// token, because the invariant being protected spans the chain: "a revoked
// family gains no new children". Two transactions touching different tokens in
// the same family would never contend on a per-row lock.
async function lockFamily(
  transaction: Prisma.TransactionClient,
  familyId: string,
): Promise<void> {
  await transaction.$queryRaw`SELECT id FROM refresh_tokens WHERE family_id = ${familyId}::uuid FOR UPDATE`;
}

// Thrown out of the rotation transaction when the conditional consume finds no
// unconsumed row — i.e. a concurrent request won the race. A private sentinel,
// so the transaction rolls back cleanly and the caller-facing outcome is
// decided once, outside it, where the family revocation cannot be rolled back
// with it.
class LostConsumeRaceError extends Error {}
