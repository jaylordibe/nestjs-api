import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { SmtpEmailAdapter } from './smtp-email.adapter';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

function config(): ConfigService {
  const values: Record<string, string | number> = {
    'email.from': 'App <noreply@app.test>',
    'email.smtpHost': 'localhost',
    'email.smtpPort': 1025,
  };
  return { getOrThrow: (key: string) => values[key] } as ConfigService;
}

const MESSAGE = {
  to: 'owner@example.com',
  subject: 'Verify your email',
  html: '<p>Hi</p>',
  text: 'Hi',
};

describe('SmtpEmailAdapter', () => {
  const createTransportMock = jest.mocked(createTransport);
  let sendMail: jest.Mock;
  let logged: jest.SpyInstance;

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({ messageId: '<1@localhost>' });
    createTransportMock.mockReturnValue({ sendMail } as never);
    logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    createTransportMock.mockReset();
    logged.mockRestore();
  });

  it('connects to the configured relay over plain SMTP', () => {
    new SmtpEmailAdapter(config());
    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'localhost',
      port: 1025,
      secure: false,
    });
  });

  it('sends the message from EMAIL_FROM', async () => {
    await new SmtpEmailAdapter(config()).send(MESSAGE);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'App <noreply@app.test>',
      to: 'owner@example.com',
      subject: 'Verify your email',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
  });

  it('throws on a refusal and never logs the address', async () => {
    sendMail.mockRejectedValue(
      new Error('Mailbox owner@example.com unavailable'),
    );
    await expect(new SmtpEmailAdapter(config()).send(MESSAGE)).rejects.toThrow(
      'Email send failed: Mailbox [recipient] unavailable',
    );
    expect(logged).toHaveBeenCalledWith(
      'SMTP send failed: Mailbox [recipient] unavailable',
    );
  });
});
