import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  IS_SIGN_IN_ATTEMPT_KEY,
  loginThrottleTracker,
  passwordSignInThrottleKey,
} from '../util/login-throttle.util';

/**
 * Both password sign-in limits, for every route that checks a password to sign
 * someone in: 5 a minute per identifier and address (`loginThrottleTracker`),
 * and 30 a minute per address alone (`signInAddressThrottler`, which counts
 * only routes carrying this). One decorator, so a new sign-in form cannot take
 * one limit and miss the other.
 */
export function ThrottleSignIn(): MethodDecorator {
  return applyDecorators(
    SetMetadata(IS_SIGN_IN_ATTEMPT_KEY, true),
    Throttle({
      default: {
        limit: 5,
        ttl: 60_000,
        getTracker: loginThrottleTracker,
        generateKey: passwordSignInThrottleKey,
      },
    }),
  );
}
