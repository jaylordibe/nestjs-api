import type { CallToolResult } from '@modelcontextprotocol/server';

// A tool result carrying the same object twice: as `structuredContent`, which
// the SDK validates against the tool's `outputSchema`, and as JSON text for
// clients that read only `content`.
export function structuredResult<T extends Record<string, unknown>>(
  output: T,
): CallToolResult & { structuredContent: T } {
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
  };
}
