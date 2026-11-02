import { All, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import {
  isLoopbackRedirectUri,
  isPermittedMcpRedirectUri,
} from '../../common/util/mcp-config.util';
import {
  MCP_OAUTH_PATHS,
  MCP_OAUTH_REGISTRATION_LIMITS,
  MCP_OAUTH_SCOPE,
  MCP_OAUTH_THROTTLE,
} from './mcp-oauth.config';

/** The client metadata a registration may set (RFC 7591); the rest is dropped. */
const REGISTRATION_METADATA = [
  'redirect_uris',
  'client_name',
  'grant_types',
  'response_types',
  'token_endpoint_auth_method',
  'application_type',
  'scope',
] as const;
import { McpOAuthProviderService } from './mcp-oauth-provider.service';

/**
 * The OAuth 2.1 protocol endpoints MCP clients call, at the origin root
 * (outside `/api`; see MCP_OAUTH_PREFIX_EXCLUSIONS). Each handler hands the
 * request to oidc-provider, which owns the protocol — the same shape as
 * `McpController` handing `/api/mcp` to the MCP SDK. They answer in OAuth's own
 * error format (`{ error, error_description }`), not the API envelope, because
 * that is what OAuth clients parse.
 *
 * `@Public()`: these endpoints are how a client obtains a credential, so no
 * user token can be required. Each carries its own per-IP `@Throttle`.
 * Excluded from Swagger: OAuth clients read the RFC 8414 document, not
 * OpenAPI.
 */
@ApiExcludeController()
@Controller()
@Public()
export class OAuthProtocolController {
  private readonly redirectOrigins: string[];

  constructor(
    private readonly oauthProvider: McpOAuthProviderService,
    configService: ConfigService,
  ) {
    this.redirectOrigins = configService.getOrThrow<string[]>(
      'mcp.oauth.redirectOrigins',
    );
  }

  /** RFC 8414 metadata: served by the provider from its own discovery route. */
  @Get('.well-known/oauth-authorization-server')
  @Throttle({ default: MCP_OAUTH_THROTTLE.protocol })
  authorizationServerMetadata(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    request.url = MCP_OAUTH_PATHS.providerDiscovery;
    return this.oauthProvider.handle(request, response);
  }

  /**
   * RFC 9728 protected resource metadata for `/api/mcp`, at the path-inserted
   * location MCP clients try first and at the root, which they fall back to.
   * `resource` must equal the URL the user entered, path included.
   */
  @Get([
    '.well-known/oauth-protected-resource',
    '.well-known/oauth-protected-resource/api/mcp',
  ])
  @Throttle({ default: MCP_OAUTH_THROTTLE.protocol })
  protectedResourceMetadata(@Res() response: Response): void {
    response.json({
      resource: this.oauthProvider.resource,
      authorization_servers: [this.oauthProvider.issuer],
      scopes_supported: [MCP_OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
    });
  }

  /**
   * RFC 7591 dynamic client registration, open as the MCP spec expects: any
   * client may register, and registering grants nothing until a user signs in
   * and approves it. Two rules are applied before the provider sees the
   * request: at most 10 redirects, each loopback or an allowed https origin;
   * only the metadata fields below are kept; a
   * client whose redirects are all loopback is registered as `native`, so the
   * port its local listener picks may change between sign-ins (RFC 8252 §7.3);
   * and a client that names no token endpoint auth method is public (`none`).
   */
  @Post('oauth/register')
  @Throttle({ default: MCP_OAUTH_THROTTLE.registration })
  async register(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const submitted = (request.body ?? {}) as Record<string, unknown>;
    const redirectUris = submitted.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > MCP_OAUTH_REGISTRATION_LIMITS.redirectUris ||
      !redirectUris.every(
        (uri): uri is string =>
          typeof uri === 'string' &&
          uri.length <= MCP_OAUTH_REGISTRATION_LIMITS.redirectUriLength &&
          isPermittedMcpRedirectUri(uri, this.redirectOrigins),
      )
    ) {
      response.status(400).json({
        error: 'invalid_redirect_uri',
        error_description:
          'Between 1 and 10 redirect URIs, each http://localhost (or 127.0.0.1, [::1]) or an https URL this server allows.',
      });
      return;
    }
    const clientName = submitted.client_name;
    if (
      clientName !== undefined &&
      (typeof clientName !== 'string' ||
        clientName.length > MCP_OAUTH_REGISTRATION_LIMITS.clientNameLength)
    ) {
      response.status(400).json({
        error: 'invalid_client_metadata',
        error_description:
          'client_name must be a string of at most 255 characters.',
      });
      return;
    }
    // Only the metadata an MCP client needs reaches the provider; everything
    // else is dropped. That keeps a registration from turning on behaviour the
    // provider would act on — `sector_identifier_uri` and `jwks_uri` make it
    // fetch an attacker-chosen URL — and bounds what each row stores.
    const metadata: Record<string, unknown> = {};
    for (const key of REGISTRATION_METADATA) {
      if (submitted[key] !== undefined) metadata[key] = submitted[key];
    }
    if (
      metadata.application_type === undefined &&
      redirectUris.every((uri: string) => isLoopbackRedirectUri(uri))
    ) {
      metadata.application_type = 'native';
    }
    // Every client here is public. One that names no method (n8n does not)
    // is registered as `none` explicitly: the provider would otherwise mint a
    // client_secret it can never use, which a client may then try to send.
    if (metadata.token_endpoint_auth_method === undefined) {
      metadata.token_endpoint_auth_method = 'none';
    }
    request.body = metadata;
    await this.oauthProvider.handle(request, response);
  }

  @All(['oauth/authorize', 'oauth/authorize/{*path}'])
  @Throttle({ default: MCP_OAUTH_THROTTLE.protocol })
  authorize(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.oauthProvider.handle(request, response);
  }

  @Post('oauth/token')
  @Throttle({ default: MCP_OAUTH_THROTTLE.protocol })
  token(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.oauthProvider.handle(request, response);
  }

  @Get('oauth/jwks')
  @Throttle({ default: MCP_OAUTH_THROTTLE.protocol })
  jwks(@Req() request: Request, @Res() response: Response): Promise<void> {
    return this.oauthProvider.handle(request, response);
  }
}
