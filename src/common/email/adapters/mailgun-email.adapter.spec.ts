import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MailgunEmailAdapter } from './mailgun-email.adapter';

function config(region: 'us' | 'eu' = 'us'): ConfigService {
  const values: Record<string, string> = {
    'email.from': 'Lysta <alerts@mg.lysta.test>',
    'email.mailgunApiKey': 'key-test',
    'email.mailgunDomain': 'mg.lysta.test',
    'email.mailgunRegion': region,
  };
  return { getOrThrow: (key: string) => values[key] } as ConfigService;
}

const MESSAGE = {
  to: 'owner@example.com',
  subject: 'New booking request',
  html: '<p>Hi</p>',
  text: 'Hi',
};

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MailgunEmailAdapter', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let logged: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchMock.mockRestore();
    logged.mockRestore();
  });

  it('posts the message to the domain with Basic auth as api:<key>', async () => {
    fetchMock.mockResolvedValue(
      answer(200, { id: '<1@mg.lysta.test>', message: 'Queued. Thank you.' }),
    );
    await new MailgunEmailAdapter(config()).send(MESSAGE);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mailgun.net/v3/mg.lysta.test/messages');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('api:key-test').toString('base64')}`,
    );
    const form = init.body as FormData;
    expect(Object.fromEntries(form.entries())).toEqual({
      from: 'Lysta <alerts@mg.lysta.test>',
      to: 'owner@example.com',
      subject: 'New booking request',
      text: 'Hi',
      html: '<p>Hi</p>',
    });
  });

  it('uses the EU API for an EU account', async () => {
    fetchMock.mockResolvedValue(answer(200, { id: 'x', message: 'Queued' }));
    await new MailgunEmailAdapter(config('eu')).send(MESSAGE);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.eu.mailgun.net/v3/mg.lysta.test/messages',
    );
  });

  it('throws on a refusal and never logs the address', async () => {
    fetchMock.mockResolvedValue(
      answer(400, { message: "to parameter 'owner@example.com' is invalid" }),
    );
    await expect(
      new MailgunEmailAdapter(config()).send(MESSAGE),
    ).rejects.toThrow('status 400');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(
      'owner@example.com',
    );
  });

  it('throws when Mailgun cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('connect ETIMEDOUT'));
    await expect(
      new MailgunEmailAdapter(config()).send(MESSAGE),
    ).rejects.toThrow('ETIMEDOUT');
  });
});
