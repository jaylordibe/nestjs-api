import { Injectable, Logger } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { PrismaService } from '../../../prisma/prisma.service';
import { formatErrorMessage } from '../../../common/util/error-message.util';
import { withTimeout } from '../../../common/util/promise-timeout.util';

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

// A readiness probe must FAIL on an unreachable dependency, not hang open on
// it, and `SELECT 1` has no deadline of its own.
//
// `DATABASE_CONNECTION_TIMEOUT_MS` bounds only ACQUIRING a pooled connection.
// Once a socket is established it is never re-checked, so the case this exists
// for is the one that does not close it: a database failover, a NAT or firewall
// idle-eviction, or a partition that blackholes packets. The query then waits on
// TCP retransmission — minutes on Linux defaults — while terminus, which applies
// no deadline of its own to a custom indicator, keeps the HTTP response open.
// The probe therefore times out at the load balancer rather than answering 503,
// and an instance that cannot reach its database is reported as "check timed
// out" instead of "not ready".
//
// Same 2s budget as `QueueStatusService`, deliberately: both sit on the same
// endpoint, so a longer one here would just move the ceiling without changing
// the answer. Well above a healthy round trip, well under any sane probe period.
const DATABASE_PING_TIMEOUT_MILLISECONDS = 2_000;

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
      await withTimeout(
        this.prisma.$queryRaw`SELECT 1`,
        DATABASE_PING_TIMEOUT_MILLISECONDS,
        `Database did not answer within ${DATABASE_PING_TIMEOUT_MILLISECONDS}ms`,
      );
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
