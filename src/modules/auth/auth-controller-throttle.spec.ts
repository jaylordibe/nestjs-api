import {
  IS_SIGN_IN_ATTEMPT_KEY,
  loginThrottleTracker,
  passwordSignInThrottleKey,
} from '../../common/util/login-throttle.util';
import { OAuthInteractionController } from '../mcp-oauth/oauth-interaction.controller';
import { AuthController } from './auth.controller';

// The e2e suite runs with throttling skipped (`skipIf: isTest` in AppModule),
// so per-route limits are pinned here instead. The keys are
// @nestjs/throttler's own metadata names; if the library renames them, these
// read `undefined` and fail loudly rather than pass.
const THROTTLER_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_KEY = 'THROTTLER:TTLdefault';
const THROTTLER_TRACKER_KEY = 'THROTTLER:TRACKERdefault';
const THROTTLER_KEY_GENERATOR_KEY = 'THROTTLER:KEY_GENERATORdefault';

function metadataOf(
  key: string,
  handlerName: string,
  controller: { prototype: object } = AuthController,
): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    controller.prototype,
    handlerName,
  )?.value as object;
  return Reflect.getMetadata(key, handler) as unknown;
}

describe('AuthController throttles', () => {
  it('password sign-in allows 5 a minute per identifier and address, in the budget shared by every sign-in form', () => {
    expect(metadataOf(THROTTLER_LIMIT_KEY, 'login')).toBe(5);
    expect(metadataOf(THROTTLER_TTL_KEY, 'login')).toBe(60_000);
    expect(metadataOf(THROTTLER_TRACKER_KEY, 'login')).toBe(
      loginThrottleTracker,
    );
    expect(metadataOf(THROTTLER_KEY_GENERATOR_KEY, 'login')).toBe(
      passwordSignInThrottleKey,
    );
  });

  // `signInAddressThrottler` counts only routes carrying this flag.
  it.each([
    ['the REST login', AuthController],
    ['the MCP OAuth sign-in', OAuthInteractionController],
  ])('%s counts toward the per-address sign-in limit', (_label, controller) => {
    expect(metadataOf(IS_SIGN_IN_ATTEMPT_KEY, 'login', controller)).toBe(true);
    expect(metadataOf(THROTTLER_LIMIT_KEY, 'login', controller)).toBe(5);
    expect(metadataOf(THROTTLER_TRACKER_KEY, 'login', controller)).toBe(
      loginThrottleTracker,
    );
  });
});
