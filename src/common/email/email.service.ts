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

// Only used by the password-reset flow now that email verification
// switched to a JWT link.
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

  sendEmailVerificationLink(
    email: string,
    firstName: string,
    verifyUrl: string,
  ): Promise<void> {
    return this.sendTemplate('email-verification-link', email, {
      firstName,
      verifyUrl,
    });
  }

  // Sent to the owner of an EXISTING account when someone tries to sign up
  // with their email. `/auth/register` now answers a collision with the same
  // 201 as a real signup, so this email is the only thing that tells a real
  // person "you already have an account" — without it the uniform response
  // would silently strand them.
  sendDuplicateSignupAttemptNotification(
    email: string,
    firstName: string,
    signInUrl: string,
    occurredAt: Date,
  ): Promise<void> {
    return this.sendTemplate('duplicate-signup-attempt', email, {
      firstName,
      signInUrl,
      occurredAt: occurredAt.toISOString(),
    });
  }

  sendPasswordResetOtp(email: string, otp: string): Promise<void> {
    return this.sendTemplate('password-reset-otp', email, {
      otp,
      expiresInMinutes: OTP_EXPIRY_MINUTES,
    });
  }

  // Security notification sent to the user after any password mutation
  // (self-change, admin reset, password-reset-via-OTP, admin PATCH with
  // a password field). `occurredAt` is a pre-formatted ISO string so the
  // template doesn't need date-formatting helpers — caller decides UTC
  // vs. user's timezone.
  sendPasswordChangedNotification(
    email: string,
    firstName: string,
    occurredAt: Date,
  ): Promise<void> {
    return this.sendTemplate('password-changed-notification', email, {
      firstName,
      occurredAt: occurredAt.toISOString(),
    });
  }
}
