import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio, { Twilio } from 'twilio';
import { OutgoingSms, SmsAdapter } from './sms-adapter.interface';

// Twilio adapter. Selected when SMS_PROVIDER=twilio. Requires
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM (all enforced
// by the Joi schema). TWILIO_FROM may be either an E.164 phone number
// you've provisioned in the Twilio console (e.g. "+15551234567") or a
// Messaging Service SID starting with "MG…" — the SDK accepts either as
// the `from` field. Sender numbers must be provisioned + verified in
// the destination country, otherwise the carrier rejects the message.
@Injectable()
export class TwilioSmsAdapter implements SmsAdapter {
  private readonly logger = new Logger(TwilioSmsAdapter.name);
  private readonly client: Twilio;
  private readonly from: string;

  constructor(configService: ConfigService) {
    const accountSid = configService.getOrThrow<string>('sms.twilioAccountSid');
    const authToken = configService.getOrThrow<string>('sms.twilioAuthToken');
    this.from = configService.getOrThrow<string>('sms.twilioFrom');
    this.client = twilio(accountSid, authToken);
  }

  async send(message: OutgoingSms): Promise<void> {
    try {
      await this.client.messages.create({
        from: this.from,
        to: message.to,
        body: message.body,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Twilio send failed for ${message.to}: ${reason}`);
      throw new Error(`SMS send failed: ${reason}`);
    }
  }
}
