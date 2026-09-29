import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EmailService } from '../../src/common/email/email.service';
import { NotificationsQueueProcessor } from '../../src/common/queue/processors/notifications-queue.processor';
import { QueueName } from '../../src/common/queue/queue-registry';

// Account emails are queued, and `.env.test` runs no worker. These helpers run
// the queued jobs through the real processor (payload validation, handler
// dispatch) so a spec can assert on what was actually sent.

export interface SentEmail {
  to: string;
  template: string;
  vars: Record<string, unknown>;
}

/**
 * Records every templated email the app sends from now on. Call before the
 * request under test; `restore` in `afterEach`.
 */
export function captureEmails(app: INestApplication): {
  sent: SentEmail[];
  restore: () => void;
} {
  const sent: SentEmail[] = [];
  const spy = jest
    .spyOn(app.get(EmailService), 'sendTemplate')
    .mockImplementation((template, to, vars) => {
      sent.push({
        to,
        template,
        vars: vars,
      });
      return Promise.resolve();
    });
  return { sent, restore: () => spy.mockRestore() };
}

/** Runs every waiting notifications job once, oldest first, then removes it. */
export async function deliverQueuedEmails(
  app: INestApplication,
): Promise<number> {
  const queue = app.get<Queue>(getQueueToken(QueueName.NOTIFICATIONS));
  const processor = app.get(NotificationsQueueProcessor);
  const jobs = await queue.getJobs(['waiting', 'prioritized'], 0, -1, true);
  for (const job of jobs) {
    await processor.process(job);
    await job.remove();
  }
  return jobs.length;
}

/** The query parameter of a link sent in an email. */
export function linkParameter(
  email: SentEmail,
  urlVariable: string,
  parameter: string,
): string {
  const url = new URL(String(email.vars[urlVariable]));
  const value = url.searchParams.get(parameter);
  if (!value) {
    throw new Error(`No "${parameter}" in ${String(email.vars[urlVariable])}`);
  }
  return value;
}
