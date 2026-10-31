import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { formatErrorMessage } from '../../util/error-message.util';
import { EmailAdapter, OutgoingEmail } from './email-adapter.interface';

// SMTP adapter. Selected when EMAIL_PROVIDER=smtp. Requires SMTP_HOST,
// SMTP_PORT and EMAIL_FROM (all enforced by the Joi schema). Meant for the
// local Mailpit inbox in docker-compose.yml: plain SMTP, no auth, no TLS, so
// development and automated QA read real emails sent the normal way. Refused
// in production and under NODE_ENV=test.
@Injectable()
export class SmtpEmailAdapter implements EmailAdapter {
  private readonly logger = new Logger(SmtpEmailAdapter.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(configService: ConfigService) {
    this.transporter = createTransport({
      host: configService.getOrThrow<string>('email.smtpHost'),
      port: configService.getOrThrow<number>('email.smtpPort'),
      secure: false,
    });
    this.from = configService.getOrThrow<string>('email.from');
  }

  async send(message: OutgoingEmail): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    } catch (error) {
      // Never the address: a failing send is retried, and each try would
      // write someone's email to the logs again.
      const reason = formatErrorMessage(error).replaceAll(
        message.to,
        '[recipient]',
      );
      this.logger.error(`SMTP send failed: ${reason}`);
      throw new Error(`Email send failed: ${reason}`);
    }
  }
}
