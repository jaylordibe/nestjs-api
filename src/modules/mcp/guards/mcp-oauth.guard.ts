import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AuthInfo,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { Errors } from '../../../common/errors/errors';
import { MCP_OAUTH_SCOPE } from '../../mcp-oauth/mcp-oauth.config';
import { McpOAuthProviderService } from '../../mcp-oauth/mcp-oauth-provider.service';

/** What tools receive as `authInfo.extra`: the signed-in user. */
export interface McpAuthExtra extends Record<string, unknown> {
  userId: string;
}

// The request after this guard: `auth` is the field the SDK's Node adapter
// forwards to the MCP handler as `authInfo`.
export type McpAuthenticatedRequest = Request & { auth?: AuthInfo };

// Authenticates the user an MCP client acts for, before any MCP processing.
//
// The route is `@Public()` to the REST user layer (JwtAuthGuard,
// PermissionsGuard) because an MCP token is a different credential: one
// issued by the MCP OAuth authorization server (src/modules/mcp-oauth) for
// this endpoint alone. Checks, in order:
//   1. An `Origin` header not in MCP_ALLOWED_ORIGINS → 403 (MCP transport
//      security: a browser page must not drive the endpoint). Server-side
//      clients send no Origin and pass.
//   2. No bearer token → 401 `TOKEN_MISSING`.
//   3. A token that is not a live MCP access token for THIS resource, or whose
//      account may no longer be used → 401 `TOKEN_INVALID`. A REST access
//      token is not an MCP token and fails here; an MCP token is not a REST
//      token and fails JwtStrategy.
// Both 401s carry `WWW-Authenticate: Bearer` with `resource_metadata` — what
// tells a client where to sign in (RFC 9728 §5.1), and how a refused client
// starts the flow again.
@Injectable()
export class McpOAuthGuard implements CanActivate {
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly challenge: string;

  constructor(
    configService: ConfigService,
    private readonly oauthProvider: McpOAuthProviderService,
  ) {
    this.allowedOrigins = new Set(
      configService.getOrThrow<string[]>('mcp.allowedOrigins'),
    );
    const metadataUrl = getOAuthProtectedResourceMetadataUrl(
      new URL(oauthProvider.resource),
    );
    this.challenge = `Bearer realm="mcp", resource_metadata="${metadataUrl}", scope="${MCP_OAUTH_SCOPE}"`;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<McpAuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const origin = request.headers.origin;
    if (origin !== undefined && !this.allowedOrigins.has(origin)) {
      throw Errors.permissionDenied('mcp');
    }

    // Same scheme parsing as passport-jwt: case-insensitive, any whitespace.
    const token = /^bearer\s+(\S+)\s*$/i.exec(
      request.headers.authorization ?? '',
    )?.[1];
    if (!token) {
      response.setHeader('WWW-Authenticate', this.challenge);
      throw Errors.tokenMissing();
    }
    const principal = await this.oauthProvider.verifyAccessToken(token);
    if (!principal) {
      response.setHeader(
        'WWW-Authenticate',
        `${this.challenge}, error="invalid_token"`,
      );
      throw Errors.tokenInvalid();
    }

    // The raw token is deliberately not forwarded: tools identify the caller
    // by `extra.userId` and have no use for the secret.
    const extra: McpAuthExtra = { userId: principal.userId };
    request.auth = {
      token: '',
      clientId: principal.clientId,
      scopes: principal.scopes,
      expiresAt: principal.expiresAt,
      resource: new URL(this.oauthProvider.resource),
      extra,
    };
    return true;
  }
}
