# MCP endpoint

The API exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server at **`/api/mcp`**. An MCP client (Claude Code, claude.ai, n8n, MCP
Inspector, other agents) connects with **only that URL**: it is sent to the
API's own sign-in page, the user signs in with their normal account and
approves the client, and the client then calls tools **as that user**. No
token is pasted and nothing is configured per client.

## 1. Purpose and architecture

- **Two modules, in the API process** (no separate service or gateway):
  - `src/modules/mcp/` — the MCP endpoint: `McpController` (route),
    `McpOAuthGuard` (authentication), `McpService` (the SDK handler), `tools/`
    (one file per tool).
  - `src/modules/mcp-oauth/` — the OAuth 2.1 authorization server MCP clients
    sign in through: `McpOAuthProviderService` (configuration and the account
    rule), `OAuthProtocolController` (discovery, registration, authorize,
    token), `OAuthInteractionController` + `views/` (the sign-in and consent
    pages), `OAuthPayloadAdapter` (storage).
- **SDKs:** the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`
  with `@modelcontextprotocol/node`) serves MCP. The authorization server is
  [`oidc-provider`](https://github.com/panva/node-oidc-provider) (OpenID
  Certified); the MCP SDK ships resource-server helpers only and points servers
  at a dedicated provider.
- **Standard:** the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
  — OAuth 2.1 authorization code with PKCE (S256 only), exact redirect URI
  matching, protected resource metadata (RFC 9728), authorization server
  metadata (RFC 8414), dynamic client registration (RFC 7591), resource
  indicators binding each token to `/api/mcp` (RFC 8707), and sign-in in the
  user's own browser (RFC 8252).
- **Transport:** Streamable HTTP, **stateless**. Every request gets a fresh
  `McpServer`; any instance answers any request.
- **Protocol versions:** the 2026-07-28 revision and 2025-era clients
  (`initialize`, 2025-11-25 and earlier) on the same endpoint. 2026-07-28
  requests get a JSON body; 2025-era requests a one-event SSE stream that
  closes with the result. `GET` and `DELETE` answer `405`. The server
  advertises `tools.listChanged: false`, so nothing is ever held open.
- **Request order on `/api/mcp`:** throttler (per IP) → `McpOAuthGuard`
  (Origin? token? account?) → SDK. Express parses the JSON body first (100 kB
  limit); no MCP message is interpreted before authentication passes.

## 2. Installation and configuration

Nothing MCP-specific to configure. `yarn install --frozen-lockfile` installs the
dependencies, `yarn prisma:deploy` applies the `oauth_payloads` migration, and
the endpoint and its sign-in work with the defaults. The issuer, the signing
keys and the cookie keys come from settings every deployment already has
(`API_BASE_URL`, `JWT_SECRET`); see §4.

## 3. Environment variables

All optional; the runtime contract (`docs/deployment/README.md` §8) is the
authoritative list. One matters wherever the Turnstile bot check is on
(staging, production): without `TURNSTILE_WEB_SITE_KEY` the sign-in page
refuses with 503, though everything else keeps working.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_ALLOWED_ORIGINS` | empty | Exact browser origins (`https://host[:port]`) allowed to call `/api/mcp`. Empty refuses every request carrying an `Origin` header; server-side clients send none. |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_MINUTES` | `60` | Lifetime of an access token (5–1440). |
| `MCP_OAUTH_REFRESH_TOKEN_TTL_DAYS` | `30` | How long a client may renew without the user signing in again (1–90). Absolute from sign-in: renewing never extends it. |
| `MCP_OAUTH_REDIRECT_DOMAINS` | empty | Comma-separated https origins a client may register as its redirect (`https://claude.ai,https://n8n.example.com`). Empty allows any https origin. Loopback (`http://localhost`, `127.0.0.1`, `[::1]`, any port) is always allowed. |
| `TURNSTILE_WEB_SITE_KEY` | unset | The website Turnstile widget's public site key, rendered on the sign-in page. Needed for sign-in wherever `TURNSTILE_WEB_SECRET` and `TURNSTILE_MOBILE_SECRET` are set. |

`API_BASE_URL` decides the issuer (its origin) and the protected resource
(`<API_BASE_URL>/mcp`); it must be the public URL clients use.

## 4. Authentication

### The sign-in flow

1. The client calls `/api/mcp` with no token and gets `401` with
   `WWW-Authenticate: Bearer realm="mcp", resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp", scope="mcp:use"`.
2. It reads the protected resource metadata, then the authorization server
   metadata at `/.well-known/oauth-authorization-server`.
3. It registers itself at `POST /oauth/register` (no Client ID is created by
   hand). Every client is public (`token_endpoint_auth_method: none`) and
   proves possession with PKCE.
4. It opens the user's browser at `/oauth/authorize`. The API's sign-in page
   asks for email or username and password, using the REST login's own check
   (`AuthService.verifyCredentials`): inactive and unverified accounts are
   refused, and a wrong password and an unknown account answer the same.
5. The consent page shows the client's name (marked as chosen by the client)
   and the exact redirect URL it registered. **Allow** sends a code to the
   client; **Deny** (or **Cancel** on the sign-in page) sends `access_denied`
   and grants nothing.
6. The client exchanges the code at `POST /oauth/token` for an access token
   (`MCP_OAUTH_ACCESS_TOKEN_TTL_MINUTES`) and a refresh token that rotates on
   every use.

The password and consent are asked for on **every** authorization: no browser
session outlives one sign-in, so a stolen browser cannot mint a token later.

### Who may connect, and when access ends

Any account that can sign in to the REST API: active, not deleted, email
verified. On every MCP request, every refresh and every code exchange, the
account is re-checked against the same rule REST access follows
(`JwtStrategy`), so access ends **at the next request** after:

- sign-out everywhere (`POST /api/auth/logout-all`);
- a password change, an administrator password reset, a password reset by
  email, or an email change;
- deactivation, deletion or GDPR erase;
- the access token expiring (the client then refreshes) or the refresh
  lifetime running out.

The client is then answered `401` with the same challenge as step 1, and starts
again.

### Token rules

- An MCP token works **only** on `/api/mcp`: it is opaque and bound to that
  resource (RFC 8707 audience), so it never verifies as a REST JWT. A REST
  access token is not an MCP token and is refused on `/api/mcp`.
- Codes and tokens are stored as SHA-256 digests (`oauth_payloads`); a
  database read hands over no usable credential. A code is single-use; a
  redeemed code presented again revokes what it produced.
- Failures on `/api/mcp`: no token → `401 TOKEN_MISSING`; anything else →
  `401 TOKEN_INVALID`; a browser `Origin` not in `MCP_ALLOWED_ORIGINS` →
  `403 PERMISSION_DENIED`, before the token is checked. These use the API's
  error envelope. The OAuth endpoints answer in OAuth's own format
  (`{ "error", "error_description" }`).
- **Keys:** the signing key and cookie keys are derived from `JWT_SECRET` with
  HKDF (`src/common/util/oauth-keys.util.ts`). Rotating `JWT_SECRET` does
  **not** end issued MCP tokens (they are random values looked up by digest).
  To end every MCP connection at once, delete the `oauth_payloads` rows other
  than `Client`; to end one user's, use sign-out everywhere.

### Protections

| Surface | Control |
|---|---|
| Sign-in and consent pages | `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`; nothing else may load except Turnstile; client-supplied text is escaped. |
| Forged form posts | Each form carries an HMAC token bound to its sign-in attempt, and the attempt is bound to the browser by a `SameSite=Lax` cookie a cross-site post does not send. |
| Password guessing | The sign-in post has the REST login's limit (5 per minute per identifier and IP) and Turnstile when it is configured. |
| Registration and protocol endpoints | Per-IP limits (`MCP_OAUTH_THROTTLE` in `mcp-oauth.config.ts`); registration 10 per minute. |
| `/api/mcp` | 60 requests per minute per IP (`MCP_THROTTLE`), counted before authentication. |
| Redirects | Loopback or https only, matched exactly (the port of a loopback redirect may change); `MCP_OAUTH_REDIRECT_DOMAINS` narrows https hosts. |

## 5. Endpoint URLs

| Path | Purpose |
|---|---|
| `/api/mcp` | The MCP endpoint |
| `/.well-known/oauth-protected-resource/api/mcp` (and `/.well-known/oauth-protected-resource`) | RFC 9728 protected resource metadata |
| `/.well-known/oauth-authorization-server` | RFC 8414 authorization server metadata |
| `POST /oauth/register` | Dynamic client registration |
| `/oauth/authorize` | Authorization (opens the sign-in page) |
| `POST /oauth/token` | Code exchange and refresh |
| `/oauth/interaction/:uid` | The sign-in and consent pages |

The OAuth and discovery paths are at the origin root, outside `/api`, because
that is where OAuth clients look for them. Locally the MCP URL is
`http://localhost:3000/api/mcp`; deployed, `https://<api-host>/api/mcp`.

## 6. Available tools

All are read-only and idempotent. `tools/list` returns them in this order.

| Tool | Input | Output (`structuredContent`) |
|---|---|---|
| `ping` | none | `{ "success": true, "message": "pong" }` |
| `echo` | `{ "message": string }` — 1–1000 chars, not only whitespace, no other keys | `{ "success": true, "message": <same string> }` |
| `get_server_info` | none | `{ "name": <package.json name>, "isMcpEnabled": true, "status": "ready", "version": <package.json version> }` |
| `get_current_user` | none | `{ "id": <user id>, "email": <email>, "roles": [<platform role names>] }` — the signed-in user |

Each result also carries the same JSON as a text `content` block. Invalid
`echo` arguments come back as `isError: true`; an unknown tool returns JSON-RPC
error `-32602`.

## 7. Local testing

```bash
yarn test src/common/util/mcp-config src/common/util/oauth-keys
yarn test:e2e mcp     # mcp.e2e-spec.ts and mcp-oauth.e2e-spec.ts
```

`test/mcp-oauth.e2e-spec.ts` signs in with the official MCP client SDK and a
scripted browser (`test/setup/mcp-oauth.ts`): discovery, registration, the
sign-in and consent pages, n8n's request shapes, every refusal, every way
access ends, token separation, and the page protections.
`test/mcp.e2e-spec.ts` drives the tools as 2025-era and 2026-07-28 clients.

## 8. MCP Inspector

`npx @modelcontextprotocol/inspector`, transport **Streamable HTTP**, URL
`http://localhost:3000/api/mcp`, then start its OAuth flow from the
authentication settings: it registers itself and opens the sign-in page. The
UI calls from its own origin, so add it (for example `http://localhost:6274`)
to `MCP_ALLOWED_ORIGINS` locally.

## 9. n8n

Use the **MCP Client Tool** node attached to an AI Agent:

- **Endpoint:** `https://<api-host>/api/mcp`
- **Server Transport:** HTTP Streamable
- **Authentication:** MCP OAuth2 → create a credential, leave **Register
  Client Automatically** on, and **Connect**: n8n registers itself, opens the
  sign-in page, and stores the tokens.

n8n needs 1.119 or later for automatic registration. Its callback is
`https://<n8n-host>/rest/oauth2-credential/callback`, so the n8n host must be
https (or allowed by `MCP_OAUTH_REDIRECT_DOMAINS`).

## 10. Claude Code

```bash
claude mcp add --transport http nestjs-api https://<api-host>/api/mcp
```

Then run `/mcp` in Claude Code and choose **Authenticate**: the browser opens
the sign-in page, and Claude Code stores and renews the tokens itself. Its
callback is a `localhost` port; the port may differ between sign-ins.

## 11. claude.ai

Add a custom connector with the URL `https://<api-host>/api/mcp`, then connect
and sign in. claude.ai calls
from its own servers, so the API must be reachable over public HTTPS. Its
callback is `https://claude.ai/api/mcp/auth_callback`.

## 12. Adding a tool

1. Create `src/modules/mcp/tools/<name>.tool.ts` exporting
   `register<Name>Tool(server, …)`. Follow `echo.tool.ts` for input validation
   and `get-current-user.tool.ts` for a tool that acts as the user.
2. Add one `register<Name>Tool(server, …)` call in the factory in
   `mcp.service.ts`. Registration order is the `tools/list` order.
3. A tool that reads or changes data identifies the caller with
   `signedInUserId(context)` and goes through the same services and access
   checks REST uses (`AbilityScopedQueryService`, `PermissionCheckService`).
   A tool never accepts a user or workspace id from its arguments as proof of
   access.
4. Add the tool to `test/mcp.e2e-spec.ts`.

## 13. Production considerations

- **HTTPS only**, at the edge. The MCP spec requires every OAuth endpoint to be
  HTTPS, and `API_BASE_URL` must be the public https URL.
- **Edge rules:** route `/api/mcp`, `/oauth/*`, `/.well-known/oauth-authorization-server`
  and `/.well-known/oauth-protected-resource*` to the API; do not cache them.
- **Turnstile:** when the bot check is on, add the API host to the website
  widget's hostname list in Cloudflare and set `TURNSTILE_WEB_SITE_KEY`.
- **Retention:** a nightly job (`mcp-oauth:payload-retention:v1`) deletes
  expired codes, tokens, grants, sessions and interactions. Registered clients
  are kept.
- **Logs:** `Authorization`, cookies and the `code` query parameter are
  redacted; request bodies are never logged.
- **Scale:** stateless; OAuth state is in Postgres and throttling in Redis.
- **Consent phishing:** registration is open by design, so anyone can register
  a client under any name. The consent page shows the redirect address; set
  `MCP_OAUTH_REDIRECT_DOMAINS` to restrict which hosts may receive codes.
- **Upgrading from static client tokens:** `MCP_CLIENT_TOKENS` is gone (a
  leftover value is ignored). A client set up with a pasted bearer token now
  gets `401` with the sign-in challenge; re-add it by URL so it signs in.
- **A refresh token is single-use.** Presenting one that was already used
  (a retried request whose answer was lost, two parallel refreshes) is treated
  as theft: the grant is revoked and the user signs in again.
- **Differences from the laravel-api template** (same endpoints, configuration
  names and behaviour otherwise): the sign-in and consent pages live at
  `/oauth/interaction/:uid`; tokens are bound to `/api/mcp` by RFC 8707
  audience (Laravel: by issuing client and the `mcp:use` scope); the refresh lifetime is absolute
  from sign-in (Laravel: renewed with each refresh); deactivation ends access
  (Laravel has no deactivation, only deletion); Turnstile protects the sign-in
  page; a loopback redirect may change port for `localhost` too; and the 401
  challenge adds `scope` and, for a bad token, `error="invalid_token"`.
- **Not configured here:** per-client disconnect (sign-out everywhere ends all
  of a user's connections), Client ID Metadata Documents, per-user MCP rate
  buckets, and audit logging of tool calls.
