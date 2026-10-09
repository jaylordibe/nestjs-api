import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatErrorMessage } from '../../util/error-message.util';
import { EmailAdapter, OutgoingEmail } from './email-adapter.interface';

const MAILGUN_API_BASE_URLS = {
  us: 'https://api.mailgun.net',
  eu: 'https://api.eu.mailgun.net',
} as const;
const REQUEST_TIMEOUT_MS = 10_000;

export type MailgunRegion = keyof typeof MAILGUN_API_BASE_URLS;

// Mailgun adapter. Selected when EMAIL_PROVIDER=mailgun; requires
// MAILGUN_API_KEY, MAILGUN_DOMAIN and EMAIL_FROM (all enforced by the Joi
// schema), and MAILGUN_REGION picks the US or EU API. The key should be a
// domain sending key, which can only send, and EMAIL_FROM must be on the
// domain verified in Mailgun.
//
// One multipart POST per message to `/v3/{domain}/messages`, no SDK, with
// Basic auth as `api:<key>`. Mailgun answers a queued send with 200 and
// `{ id, message }`; anything else is a failed send.
//
// Mailgun's send API takes no idempotency key: a retry after a try that was
// delivered but timed out sends the message twice.
@Injectable()
export class MailgunEmailAdapter implements EmailAdapter {
  private readonly logger = new Logger(MailgunEmailAdapter.name);
  private readonly messagesUrl: string;
  private readonly authorization: string;
  private readonly from: string;

  constructor(configService: ConfigService) {
    const domain = configService.getOrThrow<string>('email.mailgunDomain');
    const region = configService.getOrThrow<MailgunRegion>(
      'email.mailgunRegion',
    );
    this.messagesUrl = `${MAILGUN_API_BASE_URLS[region]}/v3/${encodeURIComponent(domain)}/messages`;
    const apiKey = configService.getOrThrow<string>('email.mailgunApiKey');
    this.authorization = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;
    this.from = configService.getOrThrow<string>('email.from');
  }

  async send(message: OutgoingEmail): Promise<void> {
    const form = new FormData();
    form.set('from', this.from);
    form.set('to', message.to);
    form.set('subject', message.subject);
    form.set('text', message.text);
    form.set('html', message.html);

    let reason: string;
    try {
      const response = await fetch(this.messagesUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization,
        },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return;
      const body: unknown = await response.json().catch(() => null);
      reason = `status ${response.status}: ${describeError(body)}`;
    } catch (error) {
      reason = formatErrorMessage(error);
    }
    // Never the address: a failing send is retried, and each try would write
    // someone's email to the logs again — even inside Mailgun's own message.
    reason = reason.replaceAll(message.to, '[recipient]');
    this.logger.error(`Mailgun send failed: ${reason}`);
    throw new Error(`Email send failed: ${reason}`);
  }
}

function describeError(body: unknown): string {
  const text =
    typeof body === 'object' && body !== null
      ? (body as { message?: unknown }).message
      : undefined;
  return typeof text === 'string' ? text : 'no message';
}
