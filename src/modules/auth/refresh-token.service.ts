import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/errors';
import { PrismaService } from '../../prisma/prisma.service';

// 256 bits of CSPRNG output, base64url so it survives headers, JSON, and query
// strings without escaping. Long enough that guessing is not a threat model.
const TOKEN_BYTES = 32;

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
      where: { tokenHash: hashToken(presentedToken) },
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

    // ── the replay branch ────────────────────────────────────────────────
    // A correct client discards a refresh token the moment it exchanges it, so
    // a second presentation means the token was captured. We cannot tell which
    // of the two presenters is the thief, so we trust neither and end the whole
    // chain. The legitimate user is forced to sign in again — an inconvenience
    // that is strictly preferable to an attacker holding a renewable session.
    if (existing.consumedAt) {
      await this.revokeFamily(existing.familyId);
      this.logger.warn(
        `Refresh token replay detected for user ${existing.userId}; ` +
          `revoked session family ${existing.familyId}`,
      );
      await this.auditService.record({
        action: 'auth.refresh_token.replay_detected',
        actorId: existing.userId,
        targetUserId: existing.userId,
        metadata: {
          familyId: existing.familyId,
          // The presented token is NOT recorded, even hashed: an audit log is
          // read by more people than the tokens table is.
          userAgent: context.userAgent ?? null,
          ipAddress: context.ipAddress ?? null,
        },
      });
      throw Errors.refreshTokenInvalid();
    }

    if (existing.revokedAt || existing.expiresAt.getTime() <= Date.now()) {
      throw Errors.refreshTokenInvalid();
    }

    // Consume-then-issue in one transaction: a crash between the two must not
    // leave a session that is neither usable nor closeable. The conditional
    // `updateMany` is the concurrency guard — two simultaneous exchanges of the
    // same token race here, and exactly one sees a row count of 1. The loser is
    // treated as a replay on its next attempt, which is the correct reading:
    // from the server's side it is indistinguishable from one.
    const refreshToken = await this.prisma.$transaction(async (transaction) => {
      const consumed = await transaction.refreshToken.updateMany({
        where: { id: existing.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw Errors.refreshTokenInvalid();
      }
      return this.persist(
        existing.userId,
        existing.familyId,
        context,
        transaction,
      );
    });

    return { userId: existing.userId, refreshToken };
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
      where: { tokenHash: hashToken(presentedToken) },
      select: { familyId: true },
    });
    if (!existing) return;
    await this.revokeFamily(existing.familyId);
  }

  /** Every chain in a family — used on replay detection and per-device logout. */
  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
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
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.lifetimeDays * 24 * 60 * 60 * 1000,
    );
    await (transaction ?? this.prisma).refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashToken(token),
        expiresAt,
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    });
    return { token, expiresAt };
  }
}

// SHA-256, hex. Not a password hash and deliberately not bcrypt: the input is
// 256 bits of randomness, so there is no dictionary to slow down, and a slow
// digest on the refresh path would hand callers a CPU-exhaustion lever.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
