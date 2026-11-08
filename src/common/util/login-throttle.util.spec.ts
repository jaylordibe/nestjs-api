import {
  loginThrottleTracker,
  passwordSignInThrottleKey,
} from './login-throttle.util';

describe('loginThrottleTracker', () => {
  it('keys by lower-cased identifier and IP', () => {
    expect(
      loginThrottleTracker({
        body: { identifier: ' Alice@Example.com ' },
        ip: '203.0.113.7',
      }),
    ).toBe('alice@example.com|203.0.113.7');
  });

  it('treats the same identifier from another IP as a different bucket', () => {
    const first = loginThrottleTracker({
      body: { identifier: 'alice' },
      ip: '203.0.113.7',
    });
    const second = loginThrottleTracker({
      body: { identifier: 'alice' },
      ip: '198.51.100.9',
    });
    expect(first).not.toBe(second);
  });

  it('falls back to the IP alone when the body has no string identifier', () => {
    expect(loginThrottleTracker({ body: undefined, ip: '203.0.113.7' })).toBe(
      '|203.0.113.7',
    );
    expect(
      loginThrottleTracker({ body: { identifier: 42 }, ip: '203.0.113.7' }),
    ).toBe('|203.0.113.7');
  });

  // One IPv6 host holds a whole /64; keyed on the raw address it would get a
  // fresh bucket for every address in it.
  it('gives every address in one IPv6 /64 the same bucket', () => {
    const first = loginThrottleTracker({
      body: { identifier: 'alice' },
      ip: '2001:db8:1:2:3:4:5:6',
    });
    const second = loginThrottleTracker({
      body: { identifier: 'alice' },
      ip: '2001:db8:1:2:ffff::1',
    });
    expect(first).toBe(second);
    expect(first).toBe('alice|2001:db8:1:2::/64');
  });

  it('keys an IPv4-mapped IPv6 address as its IPv4 address', () => {
    expect(
      loginThrottleTracker({
        body: { identifier: 'alice' },
        ip: '::ffff:203.0.113.7',
      }),
    ).toBe('alice|203.0.113.7');
  });
});

describe('passwordSignInThrottleKey', () => {
  it('gives every sign-in route the same key for one identifier and IP', () => {
    const restLogin = { getClass: () => 'AuthController' };
    const mcpSignIn = { getClass: () => 'OAuthInteractionController' };
    expect(
      passwordSignInThrottleKey(restLogin, 'a@b.c|1.2.3.4', 'default'),
    ).toBe(passwordSignInThrottleKey(mcpSignIn, 'a@b.c|1.2.3.4', 'default'));
  });

  it('keeps identifiers and throttlers apart', () => {
    const key = passwordSignInThrottleKey(null, 'a@b.c|1.2.3.4', 'default');
    expect(
      passwordSignInThrottleKey(null, 'x@b.c|1.2.3.4', 'default'),
    ).not.toBe(key);
    expect(passwordSignInThrottleKey(null, 'a@b.c|1.2.3.4', 'other')).not.toBe(
      key,
    );
  });
});
