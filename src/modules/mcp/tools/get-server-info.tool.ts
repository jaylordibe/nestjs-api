import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { structuredResult } from './tool-result';

// What the server says about itself. Deliberately only the public identity
// (package name and release version): no environment, host, commit, or
// configuration value is ever added here.
export interface ServerIdentity {
  name: string;
  version: string;
}

export function registerGetServerInfoTool(
  server: McpServer,
  identity: ServerIdentity,
): void {
  server.registerTool(
    'get_server_info',
    {
      title: 'Get server info',
      description:
        'Identifies the connected application: its name, release version and MCP status.',
      outputSchema: z.object({
        name: z.string(),
        mcp: z.literal(true),
        status: z.literal('ready'),
        version: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () =>
      structuredResult({
        name: identity.name,
        mcp: true as const,
        status: 'ready' as const,
        version: identity.version,
      }),
  );
}
