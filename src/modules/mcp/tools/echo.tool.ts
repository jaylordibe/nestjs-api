import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ECHO_MESSAGE_MAX_LENGTH } from '../mcp.config';
import { structuredResult } from './tool-result';

// Argument round-trip check: proves structured arguments arrive validated and
// come back unchanged.
export function registerEchoTool(server: McpServer): void {
  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description:
        'Returns the given message unchanged, to check that tool arguments are passed through correctly.',
      inputSchema: z
        .object({
          message: z
            .string()
            .max(ECHO_MESSAGE_MAX_LENGTH)
            .refine((message) => message.trim().length > 0, {
              message: 'message must not be empty or whitespace only',
            })
            .describe(
              `The text to echo back: 1 to ${ECHO_MESSAGE_MAX_LENGTH} characters, not only whitespace.`,
            ),
        })
        .strict(),
      outputSchema: z.object({
        success: z.literal(true),
        message: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ message }) => structuredResult({ success: true as const, message }),
  );
}
