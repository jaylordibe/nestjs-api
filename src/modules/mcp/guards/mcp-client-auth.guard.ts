import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { Errors } from '../../../common/errors/errors';
import {
  findMcpClientByToken,
  type McpClientCredential,
} from '../../../common/util/mcp-client-credentials.util';

// The request after this guard: `auth` is the field the SDK's Node adapter
// forwards to the MCP handler as `authInfo`.
export type McpAuthenticatedRequest = Request & { auth?: AuthInfo };

// Authenticates an MCP integration client before any MCP processing happens.
//
// This is a different principal from a user: the route is `@Public()` to the
// user-JWT layer (JwtAuthGuard, PermissionsGuard) and is authenticated here
// instead, by a per-client bearer token whose SHA-256 is in MCP_CLIENT_TOKENS.
// Checks, in order:
//   1. No client configured → 404, as if the route did not exist.
//   2. An `Origin` header not in MCP_ALLOWED_ORIGINS → 403 (MCP transport
//      security: a browser page must not drive the endpoint). Server-side
//      clients send no Origin and pass.
//   3. Missing or unknown bearer token → 401 with `WWW-Authenticate: Bearer`.
@Injectable()
export class McpClientAuthGuard implements CanActivate {
  private readonly clients: readonly McpClientCredential[];
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(configService: ConfigService) {
    this.clients =
      configService.getOrThrow<McpClientCredential[]>('mcp.clients');
    this.allowedOrigins = new Set(
      configService.getOrThrow<string[]>('mcp.allowedOrigins'),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<McpAuthenticatedRequest>();
    const response = http.getResponse<Response>();

    if (this.clients.length === 0) {
      throw Errors.resourceNotFound(
        'Route',
        `Cannot ${request.method} ${request.path}`,
      );
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !this.allowedOrigins.has(origin)) {
      throw Errors.permissionDenied('mcp');
    }

    // Same scheme parsing as passport-jwt: case-insensitive, any whitespace.
    const token = /^bearer\s+(\S+)\s*$/i.exec(
      request.headers.authorization ?? '',
    )?.[1];
    if (!token) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="mcp"');
      throw Errors.tokenMissing();
    }
    const client = findMcpClientByToken(token, this.clients);
    if (!client) {
      response.setHeader(
        'WWW-Authenticate',
        'Bearer realm="mcp", error="invalid_token"',
      );
      throw Errors.tokenInvalid();
    }

    // The raw token is deliberately not forwarded: tools identify the caller by
    // `clientId` and have no use for the secret.
    request.auth = { token: '', clientId: client.name, scopes: [] };
    return true;
  }
}
