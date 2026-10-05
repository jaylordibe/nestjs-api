import { isAccessTokenPayload } from './access-token.util';

describe('isAccessTokenPayload', () => {
  it('accepts a payload without a purpose', () => {
    expect(isAccessTokenPayload({})).toBe(true);
  });

  it('refuses a payload signed for another purpose', () => {
    expect(isAccessTokenPayload({ purpose: 'email_verify' })).toBe(false);
  });
});
