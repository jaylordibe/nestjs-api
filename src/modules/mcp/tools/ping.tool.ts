import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { structuredResult } from './tool-result';

// Connectivity check: proves the endpoint is reachable, authenticated and
// executing tools. No input, no I/O.
export function registerPingTool(server: McpServer): void {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description:
        'Checks that the MCP server is reachable and executing tools. Returns "pong".',
      outputSchema: z.object({
        success: z.literal(true),
        message: z.literal('pong'),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () =>
      structuredResult({ success: true as const, message: 'pong' as const }),
  );
}
