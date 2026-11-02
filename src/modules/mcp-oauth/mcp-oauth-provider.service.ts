import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import Provider, {
  errors,
  interactionPolicy,
  type Configuration,
  type KoaContextWithOIDC,
} from 'oidc-provider';
import { deriveOAuthServerKeys } from '../../common/util/oauth-keys.util';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import {
  MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
  MCP_OAUTH_INTERACTION_TTL_SECONDS,
  MCP_OAUTH_PATHS,
  MCP_OAUTH_SCOPE,
} from './mcp-oauth.config';
import { OAuthPayloadAdapter } from './oauth-payload.adapter';

/** Who an MCP access token speaks for, once it has been verified. */
export interface McpTokenPrincipal {
  userId: string;
  clientId: string;
  scopes: string[];
  /** Seconds since the epoch. */
  expiresAt: number;
}

type NodeHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

/**
 * The OAuth 2.1 authorization server MCP clients sign in through, built on
 * oidc-provider (OpenID Certified; the MCP TypeScript SDK points servers at a
 * dedicated provider rather than shipping one). This service owns its
 * configuration and the two decisions the library leaves to the application:
 * who an account is (`findAccount`) and whether a presented MCP access token
 * is still good (`verifyAccessToken`).
 *
 * Both decisions apply ONE rule — `isAccountUsable` — the rule REST access
 * already follows (`JwtStrategy`): the account exists, is active, has a
 * verified email, and the credential was issued at or after the account's
 * session cutoff (`passwordChangedAt`). Every way a session ends —
 * sign-out-everywhere, a password or email change, deactivation, deletion,
 * erase — moves that cutoff or the account state, so an MCP token, code or
 * refresh token issued before it is refused at its next use without a second
 * revocation list to keep in step.
 */
@Injectable()
export class McpOAuthProviderService implements OnModuleInit {
  private readonly logger = new Logger(McpOAuthProviderService.name);
  private providerInstance!: Provider;
  private nodeHandler!: NodeHandler;

  readonly issuer: string;
  private readonly issuerHost: string;
  private readonly issuerProtocol: string;
  readonly resource: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {
    this.issuer = configService.getOrThrow<string>('mcp.oauth.issuer');
    this.issuerHost = new URL(this.issuer).host;
    this.issuerProtocol = new URL(this.issuer).protocol.replace(':', '');
    this.resource = configService.getOrThrow<string>('mcp.oauth.resource');
  }

  onModuleInit(): void {
    this.providerInstance = new Provider(
      this.issuer,
      this.buildConfiguration(),
    );
    // TLS ends at the edge; trust its X-Forwarded-Proto for cookie `Secure`
    // flags exactly when Express is told to trust a proxy.
    this.providerInstance.proxy =
      this.configService.getOrThrow<false | string>('trustProxy') !== false;
    this.providerInstance.on('server_error', (_context, error: Error) => {
      this.logger.error(`OAuth server error: ${error.message}`, error.stack);
    });
    this.nodeHandler = this.providerInstance.callback();
  }

  get provider(): Provider {
    return this.providerInstance;
  }

  /** Hands a request to the provider's own routing (authorize, token, …). */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The provider builds every URL it advertises (token, registration and
    // authorization endpoints in the discovery document, redirects) from the
    // request's host — and, behind a trusted proxy, from X-Forwarded-Host,
    // which koa believes from ANY caller. Pinning the host to the issuer's
    // means no request can make a cached discovery document point a client's
    // code and verifier at another server. The scheme is pinned the same way
    // (koa takes X-Forwarded-Proto from any caller too), which also sets the
    // cookies' Secure flag from the issuer: https wherever the issuer is.
    request.headers.host = this.issuerHost;
    delete request.headers['x-forwarded-host'];
    request.headers['x-forwarded-proto'] = this.issuerProtocol;
    return this.nodeHandler(request, response);
  }

  /**
   * The user an MCP access token speaks for, or `null` when the token is
   * unknown, expired, issued for another resource, or its account may no
   * longer be used.
   */
  async verifyAccessToken(token: string): Promise<McpTokenPrincipal | null> {
    const accessToken = await this.providerInstance.AccessToken.find(token);
    if (
      !accessToken?.accountId ||
      !accessToken.clientId ||
      accessToken.isExpired
    ) {
      return null;
    }
    // RFC 8707 audience: a token is honoured only by the resource it was
    // issued for. The provider issues tokens for no other resource, so this is
    // the check that keeps it that way.
    if (accessToken.aud !== this.resource) return null;
    const account = await this.findUsableAccount(
      accessToken.accountId,
      accessToken.iat,
    );
    if (!account) return null;
    return {
      userId: account.id,
      clientId: accessToken.clientId,
      scopes: [...accessToken.scopes],
      expiresAt: accessToken.exp ?? 0,
    };
  }

  /**
   * When the browser session behind an interaction signed in (seconds since
   * the epoch), or `undefined` when that session no longer exists.
   */
  async sessionSignedInAt(
    sessionCookie: string | undefined,
  ): Promise<number | undefined> {
    if (!sessionCookie) return undefined;
    const session = await this.providerInstance.Session.find(sessionCookie);
    return session?.authTime();
  }

  /** The account a successful sign-in hands the provider, after the same checks. */
  async findUsableAccount(
    userId: string,
    issuedAt: number | undefined,
  ): Promise<User | null> {
    const user = await this.usersService.findByIdOrNull(userId);
    return user && isAccountUsable(user, issuedAt) ? user : null;
  }

  private buildConfiguration(): Configuration {
    const keys = deriveOAuthServerKeys(
      this.configService.getOrThrow<string>('jwt.secret'),
    );
    const accessTokenTtl = this.configService.getOrThrow<number>(
      'mcp.oauth.accessTokenTtlSeconds',
    );
    const refreshTokenTtl = this.configService.getOrThrow<number>(
      'mcp.oauth.refreshTokenTtlSeconds',
    );
    const resource = this.resource;

    return {
      adapter: (name: string) => new OAuthPayloadAdapter(name, this.prisma),
      jwks: { keys: [keys.signingJwk] },
      cookies: {
        keys: keys.cookieKeys,
        // Scoped to the OAuth paths, and Lax so a cross-site POST never
        // carries them: a forged form submission finds no interaction.
        long: { httpOnly: true, sameSite: 'lax', path: '/oauth' },
        short: { httpOnly: true, sameSite: 'lax', path: '/oauth' },
      },
      findAccount: async (context, sub, token) => {
        // Judged by when the user SIGNED IN, not when this credential was
        // minted: a code or refresh token carries the sign-in time
        // (`authTime`), and without a token the browser session does. A
        // sign-in left open across sign-out-everywhere or a password change
        // would otherwise mint a fresh, post-cutoff code on approval. With no
        // sign-in time at all there is nothing to judge, so it is refused.
        const signedInAt = token
          ? ((token as { authTime?: number }).authTime ?? token.iat)
          : context.oidc?.session?.authTime();
        if (signedInAt === undefined) return undefined;
        const user = await this.findUsableAccount(sub, signedInAt);
        if (!user) return undefined;
        return { accountId: user.id, claims: () => ({ sub: user.id }) };
      },
      scopes: [MCP_OAUTH_SCOPE],
      claims: { openid: ['sub'] },
      responseTypes: ['code'],
      // Every client registers itself as a public client and proves
      // possession with PKCE (S256 only — the library's default).
      clientAuthMethods: ['none'],
      clientDefaults: {
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        id_token_signed_response_alg: 'EdDSA',
      },
      pkce: { required: () => true },
      allowOmittingSingleRegisteredRedirectUri: false,
      routes: {
        authorization: MCP_OAUTH_PATHS.authorization,
        token: MCP_OAUTH_PATHS.token,
        registration: MCP_OAUTH_PATHS.registration,
        jwks: MCP_OAUTH_PATHS.jwks,
      },
      features: {
        devInteractions: { enabled: false },
        dPoP: { enabled: false },
        pushedAuthorizationRequests: { enabled: false },
        rpInitiatedLogout: { enabled: false },
        userinfo: { enabled: false },
        registration: { enabled: true, issueRegistrationAccessToken: false },
        resourceIndicators: {
          enabled: true,
          // A client that names no resource gets this server's MCP endpoint;
          // one that names any other is refused (`invalid_target`).
          defaultResource: () => resource,
          useGrantedResource: () => true,
          getResourceServerInfo: (_context, indicator) => {
            if (indicator !== resource) throw new errors.InvalidTarget();
            return {
              scope: MCP_OAUTH_SCOPE,
              audience: resource,
              accessTokenTTL: accessTokenTtl,
              accessTokenFormat: 'opaque',
            };
          },
        },
      },
      ttl: {
        AccessToken: accessTokenTtl,
        AuthorizationCode: MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
        Interaction: MCP_OAUTH_INTERACTION_TTL_SECONDS,
        Session: MCP_OAUTH_INTERACTION_TTL_SECONDS,
        Grant: refreshTokenTtl,
        // Absolute: a rotated refresh token inherits what is left of the one it
        // replaced, so renewing never extends a sign-in past its lifetime.
        RefreshToken: (context) =>
          context?.oidc?.entities.RotatedRefreshToken?.remainingTTL ??
          refreshTokenTtl,
      },
      // Refresh tokens for every client allowed the grant — without requiring
      // `offline_access`, which the MCP spec says servers should not advertise
      // — and tokens that outlive the short browser session.
      issueRefreshToken: (_context, client) =>
        Promise.resolve(client.grantTypeAllowed('refresh_token')),
      expiresWithSession: () => Promise.resolve(false),
      rotateRefreshToken: () => true,
      interactions: {
        url: (_context, interaction) =>
          `${MCP_OAUTH_PATHS.interaction}/${interaction.uid}`,
        policy: buildInteractionPolicy(),
      },
    };
  }
}

/**
 * The account rule every MCP credential is held to; see the service comment.
 * `iat` is whole seconds, and every cutoff write is rounded up to the next
 * whole second (`nextWholeSecond`), so a plain floor comparison is exact —
 * the same comparison `JwtStrategy` makes.
 */
export function isAccountUsable(
  user: Pick<User, 'isActive' | 'emailVerifiedAt' | 'passwordChangedAt'>,
  issuedAt: number | undefined,
): boolean {
  if (!user.isActive || !user.emailVerifiedAt) return false;
  if (user.passwordChangedAt && issuedAt !== undefined) {
    return issuedAt >= Math.floor(user.passwordChangedAt.getTime() / 1000);
  }
  return true;
}

/**
 * The library's default prompts, plus two checks that make every
 * authorization ask for the password and for consent again. A browser session
 * left behind by an earlier sign-in therefore authorizes nothing on its own —
 * the property that lets sign-out-everywhere and a password change end MCP
 * access for good, rather than until the client next asks.
 */
function buildInteractionPolicy(): interactionPolicy.Prompt[] {
  const { Check, base } = interactionPolicy;
  const policy = base();
  const signedInThisInteraction = (context: KoaContextWithOIDC) =>
    context.oidc.result?.login ? Check.NO_NEED_TO_PROMPT : Check.REQUEST_PROMPT;
  const consentedThisInteraction = (context: KoaContextWithOIDC) =>
    context.oidc.result?.consent
      ? Check.NO_NEED_TO_PROMPT
      : Check.REQUEST_PROMPT;
  policy
    .get('login')
    ?.checks.add(
      new Check(
        'sign_in_every_time',
        'The password is asked for on every authorization',
        signedInThisInteraction,
      ),
    );
  policy
    .get('consent')
    ?.checks.add(
      new Check(
        'consent_every_time',
        'Consent is asked for on every authorization',
        consentedThisInteraction,
      ),
    );
  return policy;
}
