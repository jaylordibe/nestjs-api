import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EMAIL_ADAPTER,
  EmailAdapter,
} from './adapters/email-adapter.interface';
import { ResendEmailAdapter } from './adapters/resend-email.adapter';
import { StubEmailAdapter } from './adapters/stub-email.adapter';
import { EmailService } from './email.service';
import { EmailTemplateEngine } from './template-engine';

// Provider selection is driven by `EMAIL_PROVIDER` in env (validated by
// Joi to one of: stub, resend). Tests and local dev use `stub` by
// default — no real emails get sent, and OTPs surface in the app logs so
// you can complete flows manually. Staging/prod set `EMAIL_PROVIDER=resend`
// (plus RESEND_API_KEY + EMAIL_FROM) to route through Resend.
//
// Only the selected adapter is instantiated — the unselected one's
// constructor never runs. This matters because ResendEmailAdapter reads
// required config at construction time; if it were always built, the
// stub path would fail at boot whenever RESEND_API_KEY isn't set.
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
        logger.log('Email provider: stub (no real emails sent)');
        return new StubEmailAdapter();
      },
    },
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}
