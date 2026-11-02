import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { UsersService } from '../../users/users.service';
import type { McpAuthExtra } from '../guards/mcp-oauth.guard';
import { structuredResult } from './tool-result';

/**
 * The signed-in user a tool call acts for: `McpOAuthGuard` puts the verified
 * user id in `authInfo.extra`, and the SDK hands it to every tool through
 * `context.http.authInfo`. The pattern for any user-aware tool: read the id here,
 * then go through the same services — and the same access checks — REST uses.
 * Never trust a user id passed as a tool argument.
 */
export function signedInUserId(context: ServerContext): string {
  const extra = context.http?.authInfo?.extra as McpAuthExtra | undefined;
  if (!extra?.userId) {
    // Unreachable behind McpOAuthGuard; a tool must never run without a user.
    throw new Error('MCP tool called without a signed-in user');
  }
  return extra.userId;
}

export function registerGetCurrentUserTool(
  server: McpServer,
  usersService: UsersService,
): void {
  server.registerTool(
    'get_current_user',
    {
      title: 'Get current user',
      description:
        'Identifies the signed-in user this connection acts for: their id, email and platform roles.',
      outputSchema: z.object({
        id: z.string(),
        email: z.string(),
        roles: z.array(z.string()),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (context) => {
      const userId = signedInUserId(context);
      const [user, roles] = await Promise.all([
        usersService.findByIdOrNull(userId),
        usersService.findPlatformRoleNames(userId),
      ]);
      if (!user) {
        // The guard re-checked the account on this request; a user deleted
        // since then reads as no longer available, never as someone else.
        throw new Error('The signed-in user is no longer available');
      }
      return structuredResult({ id: user.id, email: user.email, roles });
    },
  );
}
