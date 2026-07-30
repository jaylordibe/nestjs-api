import { Injectable, Logger } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { PrismaService } from '../../../prisma/prisma.service';
import { formatErrorMessage } from '../../../common/util/error-message.util';

// `/api/health/readiness` is @Public(), so anything this indicator puts in its
// result is world-readable. Prisma's connection errors are not safe to hand
// out: P1001 quotes the internal host and port ("Can't reach database server at
// `postgres:5432`") and P1000 quotes the database username. Those surface only
// while the database is already down — exactly when handing a stranger internal
// topology is least welcome (CWE-209).
//
// So the reason is split in two: the real error goes to the logs, and the
// response carries a fixed string that tells an outsider nothing the 503 status
// didn't already. Same posture as QueueHealthIndicator; the two must not drift.
//
// The explicit log call below is load-bearing, not decoration. Terminus reports
// a failed check by serializing `result.details` — i.e. only what this indicator
// returns — so removing the message from the result would also remove it from
// the logs and leave a database outage undiagnosable.
const PUBLIC_FAILURE_MESSAGE = 'Database unreachable';

@Injectable()
export class PrismaHealthIndicator {
  private readonly logger = new Logger(PrismaHealthIndicator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return indicator.up();
    } catch (error) {
      // formatErrorMessage unwraps `cause`, so a driver-level failure logs its
      // errno (ECONNREFUSED / ENOTFOUND) rather than Prisma's prose alone.
      this.logger.error(
        `Database health check failed: ${formatErrorMessage(error)}`,
      );
      return indicator.down({ message: PUBLIC_FAILURE_MESSAGE });
    }
  }
}
