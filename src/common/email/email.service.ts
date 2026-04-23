import { Injectable, Logger } from '@nestjs/common';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

// Swap this class (or re-bind the provider in EmailModule) when wiring a
// real SMTP/SES/SendGrid/Postmark/Resend adapter. The contract is
// intentionally minimal — templates and HTML rendering are layered above
// in a real deployment.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  async send(message: EmailMessage): Promise<void> {
    // Dev/test adapter: log the message so test assertions and local flows
    // can observe what would have been sent. Returns immediately so the
    // caller's latency matches a real "enqueue to SES" pattern.
    this.logger.log(
      `[email:stub] to=${message.to} subject="${message.subject}"\n${message.text}`,
    );
    return Promise.resolve();
  }

  sendEmailVerificationOtp(email: string, otp: string): Promise<void> {
    return this.send({
      to: email,
      subject: 'Verify your email',
      text: `Your email verification code is: ${otp}\n\nThis code expires in 15 minutes.`,
    });
  }

  sendPasswordResetOtp(email: string, otp: string): Promise<void> {
    return this.send({
      to: email,
      subject: 'Reset your password',
      text: `Your password reset code is: ${otp}\n\nThis code expires in 15 minutes.\n\nIf you didn't request this, ignore this email.`,
    });
  }
}
