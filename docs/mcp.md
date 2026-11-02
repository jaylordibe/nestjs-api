# MCP endpoint

The API exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server at **`/api/mcp`** so MCP clients (n8n, Claude Code, MCP Inspector, other
agents) can connect to it. Today it serves only three connectivity tools; it is
the foundation domain tools are added to later.

## 1. Purpose and architecture

- **Where:** `src/modules/mcp/` — `McpController` (route), `McpClientAuthGuard`
  (authentication), `McpService` (the SDK handler), `tools/` (one file per
  tool). It lives in the API process; there is no separate service or gateway.
- **SDK:** the official TypeScript SDK v2 — `@modelcontextprotocol/server` with
  the Node adapter `@modelcontextprotocol/node`.
- **Transport:** Streamable HTTP, **stateless**. Every HTTP request gets a fresh
  `McpServer`; nothing is kept between requests, so there is no session store
  and any instance can answer any request.
- **Protocol versions:** the 2026-07-28 revision (`server/discover`,
  per-request `_meta`, no sessions) and 2025-era clients (`initialize`
  handshake, revisions 2025-11-25 and earlier) are both served from the same
  endpoint. 2026-07-28 requests are answered with a JSON body; 2025-era
  requests with a one-event SSE stream that closes with the result. `GET` and
  `DELETE` (the 2025 standalone stream and session teardown) answer `405`.
  The server advertises `tools.listChanged: false` (the tool list never changes
  at runtime), so a 2026-07-28 `subscriptions/listen` is acknowledged and closed
  at once; no connection is ever held open.
- **Request order:** throttler (per IP) → `McpClientAuthGuard` (enabled?
  Origin? token?) → SDK. Express's JSON body parser reads the body first
  (100 kB default limit), but no MCP message is interpreted before
  authentication passes.
- **Coexistence:** the route is `@Public()` to the *user* JWT layer only and is
  excluded from Swagger. User JWTs do not work on `/api/mcp`, and MCP tokens do
  not work on any REST route.

## 2. Installation and configuration

The dependencies are in `package.json`; `yarn install --frozen-lockfile`
installs them. The endpoint is **off (404) until a client token is
configured**.

Create one token per client and configure its digest:

```bash
# Prints the raw token (give it to the client) and its SHA-256 (configure it).
node -e "const c=require('node:crypto');const t=c.randomBytes(32).toString('base64url');console.log('token :',t);console.log('sha256:',c.createHash('sha256').update(t).digest('hex'))"
```

```dotenv
MCP_CLIENT_TOKENS=n8n:<sha256-of-n8n-token>,claude-code:<sha256-of-claude-token>
```

Restart the API. Store the raw token in the client's own secret store; the API
never stores it and cannot show it again.

## 3. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MCP_CLIENT_TOKENS` | empty (off) | Comma-separated `name:sha256hex`. Name: lowercase slug (`[a-z0-9][a-z0-9._-]{0,63}`). Digest: 64 lowercase hex chars. A malformed entry or a repeated name or digest fails the boot. |
| `MCP_ALLOWED_ORIGINS` | empty | Exact browser origins (`https://host[:port]`) allowed to call the endpoint. Empty refuses every request carrying an `Origin` header. |

Both are listed in the runtime contract (`docs/deployment/README.md` §8).

## 4. Authentication

- `Authorization: Bearer <token>`, one token per client. The API keeps only
  SHA-256 digests and compares them in constant time. SHA-256 rather than a
  slow hash is deliberate: the tokens are 256-bit random values, not
  passwords.
- Failures: no token → `401 TOKEN_MISSING`; an unknown token → `401
  TOKEN_INVALID`. Both carry `WWW-Authenticate: Bearer realm="mcp"`. A browser
  `Origin` not in `MCP_ALLOWED_ORIGINS` → `403 PERMISSION_DENIED`, before the
  token is checked. These use the API's standard error envelope, not JSON-RPC.
- **Revoke** a client: remove its entry and redeploy. **Rotate**: add the new
  digest under a new name, switch the client, then remove the old entry.
- The authenticated client name reaches tools as `ctx.http.authInfo.clientId`.
  The raw token is not forwarded.
- **Rate limit:** 60 requests per minute per client IP (`MCP_THROTTLE` in
  `src/modules/mcp/mcp.config.ts`), counted before authentication so token
  guessing is capped too.

**Which clients this supports:** any client that can send a static header —
n8n (Bearer or header credential), Claude Code (`--header`), MCP Inspector,
custom agents built on an MCP SDK. **Which may need OAuth later:** ChatGPT
connectors and claude.ai custom connectors, which typically expect the MCP
OAuth 2.1 authorization flow (RFC 9728 protected-resource metadata, an
authorization server) and may not accept a static token. Adding OAuth means
validating its access tokens in `McpClientAuthGuard` and serving the metadata
document. The tools do not change. No OAuth server is built today.

## 5. Endpoint URL

| Environment | URL |
|---|---|
| Local | `http://localhost:3000/api/mcp` |
| Deployed | `https://<api-host>/api/mcp` — HTTPS only |

## 6. Available tools

All three are read-only, idempotent, deterministic, and touch no database or
service. `tools/list` returns them in this order.

| Tool | Input | Output (`structuredContent`) |
|---|---|---|
| `ping` | none | `{ "success": true, "message": "pong" }` |
| `echo` | `{ "message": string }` — 1–1000 chars, not only whitespace, no other keys | `{ "success": true, "message": <same string> }` |
| `get_server_info` | none | `{ "name": <package.json name>, "mcp": true, "status": "ready", "version": <package.json version> }` — a fork reports its own package name |

Each result also carries the same JSON as a text `content` block. Invalid
`echo` arguments come back as a tool result with `isError: true` and a message
the model can act on. An unknown tool name returns JSON-RPC error `-32602`.

## 7. Local testing

```bash
yarn test src/common/util/mcp-client-credentials   # parsing + token matching
yarn test:e2e mcp                                   # endpoint, via the real MCP client SDK
```

`test/mcp.e2e-spec.ts` drives the endpoint with `@modelcontextprotocol/client`
as both a 2025-era and a 2026-07-28 client. It covers discovery, all three
tools, `echo` validation, unknown tools, concurrency, every authentication
failure, the Origin check, protocol errors, and the disabled (404) state.

Manual check with curl (2025-era handshake):

```bash
curl -sS http://localhost:3000/api/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

## 8. MCP Inspector

CLI mode, no browser:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/api/mcp \
  --transport http --header "Authorization: Bearer $MCP_TOKEN" --method tools/list

npx @modelcontextprotocol/inspector --cli http://localhost:3000/api/mcp \
  --transport http --header "Authorization: Bearer $MCP_TOKEN" \
  --method tools/call --tool-name echo --tool-arg message="Hello MCP"
```

UI mode: `npx @modelcontextprotocol/inspector`, then choose transport
**Streamable HTTP**, URL `http://localhost:3000/api/mcp`, and add header
`Authorization: Bearer <token>`. If the UI's requests carry its own origin,
add that origin (for example `http://localhost:6274`) to
`MCP_ALLOWED_ORIGINS` locally.

## 9. n8n

Use the **MCP Client Tool** node attached to an AI Agent:

- **Endpoint:** `https://<api-host>/api/mcp`
- **Server Transport:** HTTP Streamable. Older n8n versions only offer the
  deprecated HTTP+SSE transport, which this endpoint does not serve; upgrade
  n8n if that is the only option.
- **Authentication:** Bearer Auth → a credential holding the `n8n` client's
  token. Alternatively Header Auth with name `Authorization` and value
  `Bearer <token>`.
- **Tools to Include:** All.

n8n sends no `Origin` header, so `MCP_ALLOWED_ORIGINS` is not needed.

## 10. Claude Code

```bash
claude mcp add --transport http nestjs-api http://localhost:3000/api/mcp \
  --header "Authorization: Bearer <claude-code-token>"
claude mcp list        # should show nestjs-api as connected
```

Or in a project `.mcp.json`, keeping the token out of the file:

```json
{
  "mcpServers": {
    "nestjs-api": {
      "type": "http",
      "url": "https://<api-host>/api/mcp",
      "headers": { "Authorization": "Bearer ${NESTJS_API_MCP_TOKEN}" }
    }
  }
}
```

## 11. Adding a tool

1. Create `src/modules/mcp/tools/<name>.tool.ts` exporting
   `register<Name>Tool(server, …)`. Follow `echo.tool.ts`: a Zod `inputSchema`
   (`.strict()`), an `outputSchema`, honest `annotations`, and
   `structuredResult(...)` for the return.
2. Add one `register<Name>Tool(server)` call in the factory in
   `mcp.service.ts`. Registration order is the `tools/list` order.
3. If the tool needs a Nest service, inject it into `McpService` and pass it
   into the register function. Tools stay thin and call services.
4. Before exposing a tool that reads or changes data, decide its authorization:
   today every client can call every tool. Gate per client with
   `ctx.http.authInfo.clientId`, or move to scoped (OAuth) tokens. A tool
   never accepts a user id or tenant id from arguments as proof of access.
5. Add the tool to `test/mcp.e2e-spec.ts`: discovery, the happy path, and
   argument validation.

## 12. Production considerations

- **HTTPS only.** Bearer tokens over plain HTTP are readable by anyone on the path.
- **Off by default.** An environment exposes MCP only after `MCP_CLIENT_TOKENS`
  is set there. Use different tokens in each environment.
- **Edge rules:** the path is under `/api`, so existing routing and proxy rules
  cover it. A WAF or CDN in front must allow `POST` with JSON bodies and must
  not cache `/api/mcp`. 2025-era responses are short SSE streams that close
  with the result; nothing is held open, but a proxy that buffers
  `text/event-stream` still works, just without streaming.
- **Logs:** `Authorization` is already redacted and request bodies are never
  logged. Rejected MCP input is logged as a one-line warning.
- **Scale:** stateless, so horizontal scaling needs nothing extra. The
  throttler counts in Redis across instances.
- **Not configured here:** OAuth, per-tool authorization, per-client rate
  buckets, and audit logging of tool calls. Add these with the first tool
  that touches data.
