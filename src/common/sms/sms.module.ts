import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SMS_ADAPTER, SmsAdapter } from './adapters/sms-adapter.interface';
import { StubSmsAdapter } from './adapters/stub-sms.adapter';
import { TwilioSmsAdapter } from './adapters/twilio-sms.adapter';
import { SmsService } from './sms.service';

// Provider selection is driven by `SMS_PROVIDER` in env (validated by
// Joi to one of: stub, twilio). Tests and local dev use `stub` by
// default — no real SMS gets sent, and OTPs surface in the app logs so
// you can complete flows manually. Staging/prod set `SMS_PROVIDER=twilio`
// (plus TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM) to route
// through Twilio.
//
// Only the selected adapter is instantiated — the unselected one's
// constructor never runs. This matters because TwilioSmsAdapter reads
// required config at construction time; if it were always built, the
// stub path would fail at boot whenever Twilio creds aren't set.
@Global()
@Module({
  providers: [
    {
      provide: SMS_ADAPTER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): SmsAdapter => {
        const provider = configService.get<string>('sms.provider');
        const logger = new Logger('SmsModule');
        if (provider === 'twilio') {
          logger.log('SMS provider: twilio');
          return new TwilioSmsAdapter(configService);
        }
        logger.log('SMS provider: stub (no real SMS sent)');
        return new StubSmsAdapter();
      },
    },
    SmsService,
  ],
  exports: [SmsService],
})
export class SmsModule {}
