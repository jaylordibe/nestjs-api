import { Inject, Injectable } from '@nestjs/common';
import { EMAIL_ADAPTER } from './adapters/email-adapter.interface';
import type {
  EmailAdapter,
  OutgoingEmail,
} from './adapters/email-adapter.interface';
import {
  EmailTemplateEngine,
  EmailTemplateKey,
  EmailTemplates,
} from './template-engine';

const OTP_EXPIRY_MINUTES = 15;

// Facade used by the rest of the app. Resolves templates through the
// Handlebars engine, then hands a fully-rendered message to whichever
// adapter is bound (stub in dev/test, Resend in staging/prod). Call sites
// should not care which adapter is active — that decision lives in
// EmailModule's provider factory.
@Injectable()
export class EmailService {
  constructor(
    @Inject(EMAIL_ADAPTER) private readonly adapter: EmailAdapter,
    private readonly templates: EmailTemplateEngine,
  ) {}

  // Escape hatch for ad-hoc plain-text messages. New flows should prefer
  // sendTemplate — it keeps the subject/body/style in a versionable file
  // and ensures the plain-text fallback is always generated.
  send(message: OutgoingEmail): Promise<void> {
    return this.adapter.send(message);
  }

  sendTemplate<K extends EmailTemplateKey>(
    key: K,
    to: string,
    vars: EmailTemplates[K],
  ): Promise<void> {
    const rendered = this.templates.render(key, vars);
    return this.adapter.send({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }

  sendEmailVerificationOtp(email: string, otp: string): Promise<void> {
    return this.sendTemplate('email-verification-otp', email, {
      otp,
      expiresInMinutes: OTP_EXPIRY_MINUTES,
    });
  }

  sendPasswordResetOtp(email: string, otp: string): Promise<void> {
    return this.sendTemplate('password-reset-otp', email, {
      otp,
      expiresInMinutes: OTP_EXPIRY_MINUTES,
    });
  }
}
