import { loginThrottleTracker } from './login-throttle.util';

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
});
