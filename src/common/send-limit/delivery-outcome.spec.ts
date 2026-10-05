import { JobOutcomeStatus } from '../queue/queue-job-outcome';
import { deliveryJobOutcome } from './delivery-outcome';

describe('deliveryJobOutcome', () => {
  it('completes a sent delivery', () => {
    expect(deliveryJobOutcome('sent', 'unused').status).toBe(
      JobOutcomeStatus.COMPLETED,
    );
  });

  it('skips with the caller reason when there is nothing to send', () => {
    expect(deliveryJobOutcome('nothing-to-send', 'account gone')).toEqual(
      expect.objectContaining({
        status: JobOutcomeStatus.SKIPPED,
        reason: 'account gone',
      }),
    );
  });

  // A throw would be retried and land once the window resets, so the cap
  // would become a delay. A limited send must resolve, never throw.
  it('skips — never fails — a destination at its limit', () => {
    expect(deliveryJobOutcome('destination-limited', 'unused')).toEqual(
      expect.objectContaining({
        status: JobOutcomeStatus.SKIPPED,
        reason: 'destination limit reached',
      }),
    );
  });
});
