import type { Request } from 'express';
import { AppPlatform } from '../enums/app-platform.enum';
import { clientPlatformOf } from './client-platform.util';

const requestWith = (origin: string | undefined): Request =>
  ({
    header: (name: string) =>
      name.toLowerCase() === 'origin' ? origin : undefined,
  }) as unknown as Request;

describe('clientPlatformOf', () => {
  it('reads a request with an Origin as the website', () => {
    expect(clientPlatformOf(requestWith('https://app.example.com'))).toBe(
      AppPlatform.WEB,
    );
  });

  it('reads a request with no Origin as the app', () => {
    expect(clientPlatformOf(requestWith(undefined))).toBe(AppPlatform.MOBILE);
  });

  it('reads an empty Origin as the app', () => {
    expect(clientPlatformOf(requestWith(''))).toBe(AppPlatform.MOBILE);
  });
});
