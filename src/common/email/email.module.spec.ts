import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createTransport } from 'nodemailer';
import configuration from '../../config/configuration';
import { EMAIL_ADAPTER } from './adapters/email-adapter.interface';
import { MailgunEmailAdapter } from './adapters/mailgun-email.adapter';
import { ResendEmailAdapter } from './adapters/resend-email.adapter';
import { SmtpEmailAdapter } from './adapters/smtp-email.adapter';
import { StubEmailAdapter } from './adapters/stub-email.adapter';
import { EmailModule } from './email.module';
import { EmailTemplateEngine } from './template-engine';

jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({})) }));

// The provider factory, fed by the real `configuration()`: proves each
// EMAIL_PROVIDER value binds its adapter and that the env keys reach it. No
// e2e covers `smtp` — every test stack runs the stub.
describe('EmailModule provider selection', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.mocked(createTransport).mockClear();
  });

  async function adapterFor(env: Record<string, string>): Promise<unknown> {
    process.env = { ...originalEnv, ...env };
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [configuration],
        }),
        EmailModule,
      ],
    })
      .overrideProvider(EmailTemplateEngine)
      .useValue({})
      .compile();
    return moduleRef.get(EMAIL_ADAPTER);
  }

  it('binds the SMTP adapter to the configured relay for smtp', async () => {
    const adapter = await adapterFor({
      EMAIL_PROVIDER: 'smtp',
      EMAIL_FROM: 'App <noreply@app.test>',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
    });
    expect(adapter).toBeInstanceOf(SmtpEmailAdapter);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'localhost',
      port: 1025,
      secure: false,
    });
  });

  it('binds the stub when EMAIL_PROVIDER is stub', async () => {
    expect(await adapterFor({ EMAIL_PROVIDER: 'stub' })).toBeInstanceOf(
      StubEmailAdapter,
    );
  });

  it('binds Resend when EMAIL_PROVIDER is resend', async () => {
    expect(
      await adapterFor({
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test_key',
        EMAIL_FROM: 'App <noreply@app.test>',
      }),
    ).toBeInstanceOf(ResendEmailAdapter);
  });

  it('binds Mailgun when EMAIL_PROVIDER is mailgun', async () => {
    expect(
      await adapterFor({
        EMAIL_PROVIDER: 'mailgun',
        MAILGUN_API_KEY: 'key-test',
        MAILGUN_DOMAIN: 'mg.app.test',
        EMAIL_FROM: 'App <noreply@mg.app.test>',
      }),
    ).toBeInstanceOf(MailgunEmailAdapter);
  });
});
