import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, User } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/errors';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../../common/util/opaque-token.util';
import {
  lockRefreshTokenFamily,
  lockUserRow,
} from '../../common/util/row-lock.util';
import { nextWholeSecond } from '../../common/util/session-cutoff.util';
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
  /**
   * When the session decision was made, INSIDE the lock.
   *
   * The caller signs its access token with this as `iat` rather than reading
   * the clock again afterwards. Both halves of the session then carry the same
   * instant, so a revocation that commits after the decision kills the access
   * token as surely as it kills the refresh row.
   *
   * Signing from a later wall-clock reading leaves a gap: if the response is
   * delayed past a second boundary — a GC pause, a starved event loop, a busy
   * CPU — the token is stamped with an `iat` NEWER than the cutoff a
   * revocation wrote in between, and survives it. Narrow, but not zero, and
   * nothing about the request path bounds that delay.
   */
  readonly issuedAt: Date;
}

/**
 * The authority on session state: refresh-token rows AND the session cutoff.
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
 *
 * ## Why `users.passwordChangedAt` is written here
 *
 * That column is the SESSION CUTOFF: `JwtStrategy` rejects any access token
 * whose `iat` predates it, and `rotate` rejects any refresh row created before
 * it. Ending every session therefore means two writes — bump the cutoff, revoke
 * the rows — and doing only one of them is a silent half-measure. Revoking rows
 * alone leaves a 30-day access token alive; bumping the cutoff alone leaves a
 * refresh row that can mint a fresh one.
 *
 * So the two are welded into {@link endAllSessionsInTransaction}, and the
 * row-only revocation is **private**. There is deliberately no public way to
 * revoke a user's tokens without moving the cutoff: the previous hardening pass
 * proved that a step callers must remember is a step callers forget.
 *
 * ## Lock protocol
 *
 * Every mutation here takes `lockUserRow` FIRST and `lockRefreshTokenFamily`
 * second, per the order documented in `src/common/util/row-lock.util.ts`. Every
 * one of them also re-reads the user under that lock — a decision made from a
 * row read before the lock is a decision made on stale data.
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

  /**
   * Starts a NEW session chain, under the same lock every revocation takes.
   *
   * `expectedSessionCutoff` is the `passwordChangedAt` the caller read when it
   * verified the password, and it is the whole point of this method. Password
   * verification happens outside any transaction — bcrypt must never run with
   * one open — so between the compare and this call, a logout-all, a password
   * change, a support revocation, or an account deletion can commit. Without the
   * precondition, that login inserts a live refresh row the revocation's
   * `updateMany` had already passed over, and mints an access token whose `iat`
   * is NEWER than the cutoff the revocation wrote. "Sign me out everywhere" then
   * leaves a fully usable 30-day session behind, which is the exact opposite of
   * what the user asked for.
   *
   * Checked under the user lock, so a revocation is either entirely before this
   * (cutoff moved → refused) or entirely after it (its cutoff strictly exceeds
   * the `iat` of the access token the caller signs on return → killed).
   *
   * A stale login raises the ordinary `INVALID_CREDENTIALS`, not a new code: the
   * caller's password may well have been correct a moment ago, and telling them
   * *which* concurrent security event beat them is a disclosure with no benefit.
   */
  async issueForNewSession(
    userId: string,
    expectedSessionCutoff: Date | null,
    context: RefreshTokenContext = {},
  ): Promise<IssuedRefreshToken> {
    return this.prisma.$transaction(async (transaction) => {
      await lockUserRow(transaction, userId);

      const owner = await this.loadEligibleSessionOwner(transaction, userId);
      if (
        !owner ||
        !sameInstant(owner.passwordChangedAt, expectedSessionCutoff)
      ) {
        throw Errors.invalidCredentials();
      }

      return this.persist(userId, randomUUID(), context, transaction);
    });
  }

  /**
   * Exchanges a refresh token for a fresh one in the same family.
   *
   * Returns the owning user alongside the new token so the caller can mint a
   * matching access token and render its response without a second lookup — and,
   * more importantly, so the eligibility decision and the token write are ONE
   * decision. Re-reading the user afterwards (as this used to) means the row
   * that authorised the new session is not the row that was checked.
   */
  async rotate(
    presentedToken: string,
    context: RefreshTokenContext = {},
  ): Promise<{ user: User; refreshToken: IssuedRefreshToken }> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashOpaqueToken(presentedToken) },
      select: {
        id: true,
        userId: true,
        familyId: true,
        createdAt: true,
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
    try {
      return await this.prisma.$transaction(async (transaction) => {
        // User first, then family — the order in `row-lock.util.ts`, which
        // every revocation path also takes, so the two can never deadlock.
        await lockUserRow(transaction, existing.userId);
        await lockRefreshTokenFamily(transaction, existing.familyId);

        // Deleted, deactivated, or unverified since this session began. Decided
        // HERE rather than after the transaction: a check that runs on a row
        // read outside the lock cannot bind the write that follows it. Nothing
        // has been written yet, so the rollback costs nothing and the sessions
        // are ended outside, where the revocation cannot roll back with it.
        const owner = await this.loadEligibleSessionOwner(
          transaction,
          existing.userId,
        );
        if (!owner) {
          throw new SessionOwnerIneligibleError();
        }

        // A credential change ends every session that predates it. Checked
        // inside the lock rather than trusting the caller: this is the backstop
        // that holds even if some future code path writes a password without
        // going through `UsersService.applyPasswordChange`.
        //
        // NOT reported as a replay, and NOT escalated into a fresh revocation.
        // The credential change already revoked this family, so reaching here
        // means some future path wrote a password without going through
        // `endAllSessionsInTransaction` — a backstop whose job is to refuse this
        // exchange, nothing more. Ending every session from here would let a
        // stale token held by anyone log the account's CURRENT sessions out,
        // turning a backstop into a denial-of-service primitive.
        if (
          owner.passwordChangedAt &&
          existing.createdAt.getTime() < owner.passwordChangedAt.getTime()
        ) {
          throw new SessionPredatesCutoffError();
        }

        // `revokedAt` and `expiresAt` are re-checked INSIDE the transaction.
        // The equivalent checks above read the row fetched before it, so a
        // revocation committing in between would otherwise still let this
        // rotation issue a live child into a revoked family — and the family
        // lock made that MORE likely, by parking the rotation until the
        // revocation committed and then resuming on stale data.
        const consumed = await transaction.refreshToken.updateMany({
          where: {
            id: existing.id,
            consumedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
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
          throw new ReplayDetectedError();
        }

        const refreshToken = await this.persist(
          existing.userId,
          existing.familyId,
          context,
          transaction,
        );
        return { user: owner, refreshToken };
      });
    } catch (error) {
      // Everything below runs OUTSIDE the transaction, which has now rolled
      // back. Ending the sessions inside it would roll that back along with the
      // failed rotation — the family would stay alive on the very evidence that
      // should have closed it.
      if (error instanceof ReplayDetectedError) {
        await this.handleReplay(existing.userId, existing.familyId, context);
      }
      if (error instanceof SessionOwnerIneligibleError) {
        // The session is real but the account is no longer eligible. Close the
        // whole chain rather than leaving tokens that fail on every use, and
        // leave nothing behind for a restore to resurrect.
        await this.endAllSessions(existing.userId, null);
        throw Errors.refreshTokenInvalid();
      }
      if (error instanceof SessionPredatesCutoffError) {
        throw Errors.refreshTokenInvalid();
      }
      throw error;
    }
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
   *
   * Deliberately does NOT move the session cutoff — that would sign the user out
   * of every OTHER device too. Per-device logout blocklists its own access token
   * by `jti` instead (see `AuthService.logout`).
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
      // The family's owner, read inside the transaction so the lock order below
      // is the same one `rotate` uses: user, then family.
      const anyTokenInFamily = await transaction.refreshToken.findFirst({
        where: { familyId },
        select: { userId: true },
      });
      if (!anyTokenInFamily) return;

      await lockUserRow(transaction, anyTokenInFamily.userId);
      await lockRefreshTokenFamily(transaction, familyId);
      await transaction.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  /**
   * THE security mutation: end every session this account holds, everywhere.
   *
   * Moves the session cutoff and revokes every family in one statement pair, so
   * neither access tokens nor refresh tokens survive. Pairs with logout-all,
   * support-driven revocation, every credential change, deactivation, deletion,
   * and erasure — all of which previously did some subset of this by hand.
   *
   * `userData` is folded into the SAME `users` update, so the reason for the
   * revocation and the revocation itself are one row version. That is what makes
   * "a password change always ends sessions" a structural property rather than a
   * rule five call sites happened to remember: there is no way to write the new
   * password without also writing the cutoff.
   *
   * The caller must already hold the user lock. It is not taken here, because
   * taking it twice in one transaction is harmless but taking it in the wrong
   * ORDER is not, and the caller is the only one who knows what else it holds.
   */
  async endAllSessionsInTransaction(
    transaction: Prisma.TransactionClient,
    userId: string,
    actorId: string | null,
    userData: Prisma.UserUpdateInput = {},
  ): Promise<User> {
    const updated = await transaction.user.update({
      where: { id: userId },
      data: {
        ...userData,
        // Rounded up to the next whole second — see `nextWholeSecond`. A raw
        // timestamp leaves a token minted in the same second as the change
        // valid, because `iat` has no sub-second precision to compare against.
        passwordChangedAt: nextWholeSecond(),
        updatedBy: actorId,
      },
    });
    await transaction.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return updated;
  }

  /** {@link endAllSessionsInTransaction} under its own transaction and lock. */
  async endAllSessions(
    userId: string,
    actorId: string | null,
    userData: Prisma.UserUpdateInput = {},
  ): Promise<User> {
    return this.prisma.$transaction(async (transaction) => {
      await lockUserRow(transaction, userId);
      return this.endAllSessionsInTransaction(
        transaction,
        userId,
        actorId,
        userData,
      );
    });
  }

  /** Locks one account's session state. Exported for credential changes. */
  async lockSessions(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await lockUserRow(transaction, userId);
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

  /**
   * The account behind a session, or null if it may no longer hold one.
   *
   * Read through the raw client with an explicit `deletedAt: null`, not through
   * `prisma.scoped`: a `$transaction` callback is the unscoped client, so the
   * soft-delete filter does not apply to it and omitting the clause would let a
   * deleted account keep rotating.
   */
  private async loadEligibleSessionOwner(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<User | null> {
    const owner = await transaction.user.findFirst({
      where: { id: userId, deletedAt: null },
    });
    if (!owner || !owner.isActive || !owner.emailVerifiedAt) {
      return null;
    }
    return owner;
  }

  private async persist(
    userId: string,
    familyId: string,
    context: RefreshTokenContext,
    transaction: Pick<PrismaService, 'refreshToken'>,
  ): Promise<IssuedRefreshToken> {
    const token = generateOpaqueToken();
    // The authoritative instant of the session decision. Captured here, under
    // the lock and alongside the row it describes, so the access token the
    // caller signs cannot drift later than the refresh token it accompanies.
    const issuedAt = new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + this.lifetimeDays * 24 * 60 * 60 * 1000,
    );
    await transaction.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashOpaqueToken(token),
        // Written explicitly rather than left to `@default(now())`, so the row
        // and the access token that accompanies it carry the SAME instant.
        //
        // The default is evaluated by Postgres when the INSERT executes, which
        // is strictly after this value was captured — so the two can land on
        // opposite sides of a second boundary. The skew is in the safe
        // direction (`iat` would be one second older than the row it describes,
        // making the access token die slightly sooner) but the two halves of
        // one session disagreeing about when it began is a fact nobody should
        // have to reason about, and `rotate` compares this column against the
        // session cutoff.
        createdAt: issuedAt,
        expiresAt,
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    });
    return { token, expiresAt, issuedAt };
  }
}

/**
 * Two nullable timestamps describe the same instant.
 *
 * `Date` equality is reference equality, and `null` is a legitimate cutoff (an
 * account that has never had one), so neither `===` nor a bare `getTime()`
 * comparison is safe on its own.
 */
function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

// Private sentinels thrown out of the rotation transaction when it must not
// commit. Distinct classes rather than one flag, because the three outcomes call
// for three different responses — revoke the family and audit a theft, end every
// session, or simply refuse — and a single sentinel is how two of them end up
// sharing the wrong one.
//
// They roll the transaction back cleanly, so the caller-facing outcome is
// decided once, outside it, where the revocation that follows cannot be rolled
// back with it.

/** The presented token had already been consumed — RFC 9700 §4.14.2 reuse. */
class ReplayDetectedError extends Error {}

/** The account was deleted, deactivated, or unverified since the session began. */
class SessionOwnerIneligibleError extends Error {}

/** The session predates the account's current session cutoff. */
class SessionPredatesCutoffError extends Error {}
