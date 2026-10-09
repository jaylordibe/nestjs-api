import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PHONE_OTP_LENGTH } from '../../common/constants/phone-otp.constants';
import { UsersService } from './users.service';

const PHONE_NUMBER = '+15551234567';
const PASSWORD = 'correct horse battery staple';

// Only the dependencies requestPhoneVerification reaches are real fakes; the
// rest are never called on this path.
async function build(fixedCode?: string) {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const update = jest.fn(() => Promise.resolve({}));
  const prisma = { user: { update } };
  const destinationSendLimit = {
    reserve: () => Promise.resolve({}),
    sendReserved: (_: unknown, send: () => Promise<void>) => send(),
  };
  const sendPhoneVerificationOtp = jest.fn(() => Promise.resolve());
  const configService = {
    get: (key: string) =>
      key === 'phoneCodes.fixedCode' ? fixedCode : undefined,
  } as ConfigService;
  const unused = {} as never;
  const service = new UsersService(
    prisma as never,
    unused,
    { sendPhoneVerificationOtp } as never,
    destinationSendLimit as never,
    unused,
    unused,
    configService,
    unused,
    unused,
    unused,
    unused,
  );
  jest
    .spyOn(service, 'findById')
    .mockResolvedValue({ id: 'user-1', password: passwordHash } as never);
  return { service, update, sendPhoneVerificationOtp };
}

function textedCode(sendPhoneVerificationOtp: jest.Mock): string {
  return (sendPhoneVerificationOtp.mock.calls[0] as unknown[])[1] as string;
}

describe('UsersService phone verification code value', () => {
  let warned: jest.SpyInstance;

  beforeEach(() => {
    warned = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => warned.mockRestore());

  it('texts a random code by default', async () => {
    const { service, sendPhoneVerificationOtp } = await build();
    await service.requestPhoneVerification('user-1', PASSWORD, PHONE_NUMBER);
    expect(textedCode(sendPhoneVerificationOtp)).toMatch(
      new RegExp(`^\\d{${PHONE_OTP_LENGTH}}$`),
    );
    expect(warned).not.toHaveBeenCalled();
  });

  it('texts PHONE_CODE_FIXED, stored as a hash like any code, and warns at boot', async () => {
    const { service, update, sendPhoneVerificationOtp } = await build('123456');
    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining('PHONE_CODE_FIXED'),
    );
    await service.requestPhoneVerification('user-1', PASSWORD, PHONE_NUMBER);
    expect(textedCode(sendPhoneVerificationOtp)).toBe('123456');
    const { otpHash } = (
      update.mock.calls[0] as unknown as [{ data: { otpHash: string } }]
    )[0].data;
    await expect(
      bcrypt.compare(`123456:${PHONE_NUMBER}`, otpHash),
    ).resolves.toBe(true);
  });
});
