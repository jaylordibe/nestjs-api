import {
  loginThrottleTracker,
  passwordSignInThrottleKey,
} from '../../common/util/login-throttle.util';
import { AuthController } from '../auth/auth.controller';
import { MCP_THROTTLE } from '../mcp/mcp.config';
import { McpController } from '../mcp/mcp.controller';
import { MCP_OAUTH_THROTTLE } from './mcp-oauth.config';
import { OAuthInteractionController } from './oauth-interaction.controller';
import { OAuthProtocolController } from './oauth-protocol.controller';

// The e2e suite runs with throttling skipped (`skipIf: isTest` in AppModule),
// so the MCP and MCP OAuth limits are pinned here, as
// users-controller-throttle.spec.ts does for its routes. The keys are
// @nestjs/throttler's own metadata names; a rename reads `undefined` and fails.
const LIMIT_KEY = 'THROTTLER:LIMITdefault';
const TRACKER_KEY = 'THROTTLER:TRACKERdefault';
const KEY_GENERATOR_KEY = 'THROTTLER:KEY_GENERATORdefault';

function metadataOf(
  target: object,
  key: string,
  handlerName?: string,
): unknown {
  const holder = handlerName
    ? (Object.getOwnPropertyDescriptor(
        (target as { prototype: object }).prototype,
        handlerName,
      )?.value as object)
    : target;
  return Reflect.getMetadata(key, holder) as unknown;
}

describe('MCP OAuth throttles', () => {
  it('limits the sign-in post like the REST login: 5 a minute per identifier and IP', () => {
    expect(metadataOf(OAuthInteractionController, LIMIT_KEY, 'login')).toBe(5);
    expect(metadataOf(OAuthInteractionController, TRACKER_KEY, 'login')).toBe(
      loginThrottleTracker,
    );
  });

  it('shares one budget with the REST login, so alternating them gains nothing', () => {
    expect(
      metadataOf(OAuthInteractionController, KEY_GENERATOR_KEY, 'login'),
    ).toBe(passwordSignInThrottleKey);
    expect(metadataOf(AuthController, KEY_GENERATOR_KEY, 'login')).toBe(
      passwordSignInThrottleKey,
    );
  });

  it.each(['show', 'confirm', 'abort'] as const)(
    'limits the %s page step per IP',
    (handlerName) => {
      expect(
        metadataOf(OAuthInteractionController, LIMIT_KEY, handlerName),
      ).toBe(MCP_OAUTH_THROTTLE.page.limit);
    },
  );

  it('limits open client registration the most tightly', () => {
    expect(metadataOf(OAuthProtocolController, LIMIT_KEY, 'register')).toBe(
      MCP_OAUTH_THROTTLE.registration.limit,
    );
  });

  it.each([
    'authorizationServerMetadata',
    'protectedResourceMetadata',
    'authorize',
    'token',
    'jwks',
  ] as const)('limits the %s endpoint per IP', (handlerName) => {
    expect(metadataOf(OAuthProtocolController, LIMIT_KEY, handlerName)).toBe(
      MCP_OAUTH_THROTTLE.protocol.limit,
    );
  });

  it('limits /api/mcp per IP before authentication', () => {
    expect(metadataOf(McpController, LIMIT_KEY)).toBe(MCP_THROTTLE.limit);
  });
});
