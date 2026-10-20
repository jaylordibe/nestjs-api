import type { IncomingMessage } from 'node:http';
import { HTTP_INSTRUMENTATION_CONFIG } from './http-instrumentation.config';

const incoming = (url: string) => ({ url }) as IncomingMessage;

describe('HTTP_INSTRUMENTATION_CONFIG', () => {
  it('records no search text or credential in an incoming span', () => {
    expect(
      HTTP_INSTRUMENTATION_CONFIG.startIncomingSpanHook(
        incoming('/api/users?search=juan%200917&page=2'),
      ),
    ).toEqual({ 'url.query': 'search=[redacted]&page=2' });
    expect(
      HTTP_INSTRUMENTATION_CONFIG.startIncomingSpanHook(
        incoming('/api/auth/verify-email?token=secret'),
      ),
    ).toEqual({ 'url.query': 'token=[redacted]' });
  });

  it('ignores health probes', () => {
    expect(
      HTTP_INSTRUMENTATION_CONFIG.ignoreIncomingRequestHook(
        incoming('/api/health/live'),
      ),
    ).toBe(true);
    expect(
      HTTP_INSTRUMENTATION_CONFIG.ignoreIncomingRequestHook(
        incoming('/api/users'),
      ),
    ).toBe(false);
  });
});
