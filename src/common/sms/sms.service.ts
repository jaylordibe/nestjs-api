import { Inject, Injectable } from '@nestjs/common';
import { SMS_ADAPTER } from './adapters/sms-adapter.interface';
import type { OutgoingSms, SmsAdapter } from './adapters/sms-adapter.interface';

const OTP_EXPIRY_MINUTES = 15;

// Facade used by the rest of the app. Renders any templated copy here so
// adapters only ever see a final body. Call sites should not care which
// adapter is active — that decision lives in SmsModule's provider factory.
@Injectable()
export class SmsService {
  constructor(@Inject(SMS_ADAPTER) private readonly adapter: SmsAdapter) {}

  // Escape hatch for ad-hoc messages. New flows should prefer one of the
  // typed helpers below so the body lives in one place per template.
  send(message: OutgoingSms): Promise<void> {
    return this.adapter.send(message);
  }

  sendPhoneVerificationOtp(to: string, otp: string): Promise<void> {
    return this.adapter.send({
      to,
      body: `Your phone verification code is ${otp}. It expires in ${OTP_EXPIRY_MINUTES} minutes.`,
    });
  }
}
