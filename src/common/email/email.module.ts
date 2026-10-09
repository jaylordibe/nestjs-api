import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EMAIL_ADAPTER,
  EmailAdapter,
} from './adapters/email-adapter.interface';
import { MailgunEmailAdapter } from './adapters/mailgun-email.adapter';
import { ResendEmailAdapter } from './adapters/resend-email.adapter';
import { StubEmailAdapter } from './adapters/stub-email.adapter';
import { EmailService } from './email.service';
import { EmailTemplateEngine } from './template-engine';

// Provider selection is driven by `EMAIL_PROVIDER` in env (validated by
// Joi to one of: stub, resend, mailgun). Tests and local dev use `stub` by
// default — no real emails get sent, and links surface in the app logs so
// you can complete flows manually. Staging/prod set `EMAIL_PROVIDER` to
// `resend` or `mailgun`, plus that provider's settings and EMAIL_FROM.
//
// Only the selected adapter is instantiated — the unselected ones'
// constructors never run. This matters because each real adapter reads
// required config at construction time; if it were always built, the
// stub path would fail at boot whenever its key isn't set.
@Global()
@Module({
  providers: [
    EmailTemplateEngine,
    {
      provide: EMAIL_ADAPTER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): EmailAdapter => {
        const provider = configService.get<string>('email.provider');
        const logger = new Logger('EmailModule');
        if (provider === 'resend') {
          logger.log('Email provider: resend');
          return new ResendEmailAdapter(configService);
        }
        if (provider === 'mailgun') {
          logger.log('Email provider: mailgun');
          return new MailgunEmailAdapter(configService);
        }
        logger.log('Email provider: stub (no real emails sent)');
        return new StubEmailAdapter();
      },
    },
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}
