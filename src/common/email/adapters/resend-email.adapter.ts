import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { EmailAdapter, OutgoingEmail } from './email-adapter.interface';

// Resend adapter. Selected when EMAIL_PROVIDER=resend. Requires
// RESEND_API_KEY and EMAIL_FROM (both enforced by the Joi schema). The
// `from` address must be on a domain you've verified in Resend's
// dashboard (DKIM + SPF + DMARC set in DNS) — otherwise sends land in
// spam or get bounced outright.
@Injectable()
export class ResendEmailAdapter implements EmailAdapter {
  private readonly logger = new Logger(ResendEmailAdapter.name);
  private readonly client: Resend;
  private readonly from: string;

  constructor(configService: ConfigService) {
    this.client = new Resend(
      configService.getOrThrow<string>('email.resendApiKey'),
    );
    this.from = configService.getOrThrow<string>('email.from');
  }

  async send(message: OutgoingEmail): Promise<void> {
    const result = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    if (result.error) {
      this.logger.error(
        `Resend send failed for ${message.to}: ${result.error.message}`,
      );
      throw new Error(`Email send failed: ${result.error.message}`);
    }
  }
}
