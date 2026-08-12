import { JobOutcomeStatus } from '../../common/queue/queue-job-outcome';
import { JobName } from '../../common/queue/job-registry';
import { RefreshTokenRetentionHandler } from './refresh-token-retention.handler';
import type { RefreshTokenService } from './refresh-token.service';

// This sweep was an `@Cron` service with no test at all; converting it to a
// BullMQ recurring job made the gap matter more, not less. The old path ran
// once per process from one call site and no-op'd in test; the new one is
// driven by a scheduler that lives in REDIS and outlives every process, retries
// up to three times, and deletes rows from a security-relevant table.
//
// The invariant worth protecting is stated in three comments and was enforced
// by nothing: revoked-but-unexpired tokens are KEPT deliberately, because they
// are what makes replay detectable — delete a consumed token early and a replay
// reads as merely "unknown", silently downgrading a theft signal to a shrug.
describe('RefreshTokenRetentionHandler', () => {
  function buildHandler(deletedCount: number) {
    const purgeCalls: number[] = [];
    const refreshTokenService = {
      purgeExpired: () => {
        purgeCalls.push(1);
        // Idempotent by construction: the predicate is `expiresAt < now`, so a
        // second run finds nothing left.
        return Promise.resolve(purgeCalls.length === 1 ? deletedCount : 0);
      },
    } as unknown as RefreshTokenService;

    return {
      handler: new RefreshTokenRetentionHandler(refreshTokenService),
      purgeCalls,
    };
  }

  it('claims the registered job name', () => {
    expect(buildHandler(0).handler.jobName).toBe(
      JobName.AUTH_REFRESH_TOKEN_RETENTION_V1,
    );
  });

  it('delegates to the one purge the auth module owns', async () => {
    const { handler, purgeCalls } = buildHandler(7);

    await handler.handle();

    expect(purgeCalls).toHaveLength(1);
  });

  it('reports how many rows it removed', async () => {
    const outcome = await buildHandler(412).handler.handle();

    expect(outcome.status).toBe(JobOutcomeStatus.COMPLETED);
    expect(outcome.reason).toContain('412');
  });

  // A scheduler tick is at-least-once and the job retries, so a replay must be
  // a no-op rather than an error or a second round of deletions.
  it('is safe to replay — a second run deletes nothing and still completes', async () => {
    const { handler } = buildHandler(3);

    const first = await handler.handle();
    const second = await handler.handle();

    expect(first.status).toBe(JobOutcomeStatus.COMPLETED);
    expect(second.status).toBe(JobOutcomeStatus.COMPLETED);
    // Nothing to report the second time, so the stored return value stays the
    // bare `{ status: 'completed' }` shape.
    expect(second.reason).toBeUndefined();
  });

  it('completes quietly when there was nothing to purge', async () => {
    const outcome = await buildHandler(0).handler.handle();

    expect(outcome).toEqual({ status: JobOutcomeStatus.COMPLETED });
  });

  // The seam the file advertises, so a runbook or a spec can drive the sweep
  // without going near the queue.
  it('exposes runOnce as a directly drivable seam returning the count', async () => {
    await expect(buildHandler(9).handler.runOnce()).resolves.toBe(9);
  });
});
