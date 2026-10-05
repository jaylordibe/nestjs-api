import {
  completedJob,
  skippedJob,
  type JobOutcome,
} from '../queue/queue-job-outcome';

/** What a worker-side `deliver*` method did with one queued message. */
export type DeliveryOutcome =
  | 'sent'
  | 'nothing-to-send'
  | 'destination-limited';

/**
 * The job outcome for a delivery. A destination at its send limit is an
 * expected outcome, so it is skipped, never thrown: a throw would burn every
 * retry against the same full window and leave a failed job — noise for
 * alerting, and one a queue administrator could retry into a send.
 */
export function deliveryJobOutcome(
  outcome: DeliveryOutcome,
  nothingToSendReason: string,
): JobOutcome {
  switch (outcome) {
    case 'sent':
      return completedJob();
    case 'nothing-to-send':
      return skippedJob(nothingToSendReason);
    case 'destination-limited':
      return skippedJob('destination limit reached');
  }
}
