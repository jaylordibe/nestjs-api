import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RefreshTokenService } from './refresh-token.service';

/**
 * Deletes refresh tokens that are past their expiry.
 *
 * Lives in the auth module rather than `common/scheduled-jobs` because it is
 * feature-owned — it sweeps a table this module alone writes to.
 *
 * Why bother, when an expired token already authorizes nothing: the row still
 * holds a user id, an IP address, and a user-agent string. That is a device
 * fingerprint per session, accumulating forever, serving no purpose once the
 * token is dead. Deleting it is data minimisation, not housekeeping.
 *
 * Revoked-but-unexpired rows are deliberately KEPT until their natural expiry.
 * They are what makes replay detectable — delete a consumed token early and a
 * replay of it reads as merely "unknown", which silently downgrades a theft
 * signal into a shrug.
 *
 * A sweep over every matching row on a fixed cadence, safe to miss and safe to
 * repeat: exactly what `@Cron` is for, per the decision table in
 * `src/common/queue/README.md`.
 */
@Injectable()
export class RefreshTokenRetentionService {
  private readonly logger = new Logger(RefreshTokenRetentionService.name);

  constructor(
    private readonly refreshTokenService: RefreshTokenService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  handleCron(): void {
    if (this.configService.get<string>('nodeEnv') === 'test') {
      return;
    }
    void this.runOnce();
  }

  // The testable seam: drivable directly from a spec or a runbook without
  // going near the scheduler. Idempotent — a second run finds nothing left.
  async runOnce(): Promise<number> {
    const deletedCount = await this.refreshTokenService.purgeExpired();
    if (deletedCount > 0) {
      this.logger.log(`Purged ${deletedCount} expired refresh token(s)`);
    }
    return deletedCount;
  }
}
