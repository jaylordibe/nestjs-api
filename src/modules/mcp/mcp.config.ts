// Static settings of the MCP endpoint. They are limits, not deployment
// choices, so they live here rather than in env.

// Per-IP budget on `/api/mcp`, counted before authentication so a token-guessing
// flood is capped too. Generous for one automation client; a workflow that
// genuinely needs more is a reason to review this limit, not to raise it blind.
export const MCP_THROTTLE = { limit: 60, ttl: 60_000 } as const;

// Longest `message` the `echo` tool accepts.
export const ECHO_MESSAGE_MAX_LENGTH = 1000;
