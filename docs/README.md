# Deployment

Per-environment infra files live in subdirectories — each one is fully
self-contained (compose, Caddyfile, env template, backup script, README)
so the two environments can drift to fit their host platform without
leaking config into the other.

| Environment | Folder | Branch | Notes |
|-------------|--------|--------|-------|
| Production  | [`prod/`](./prod/README.md)       | `main`    | Swagger hidden at the Nest layer |
| Staging     | [`staging/`](./staging/README.md) | `staging` | Swagger reachable, gated behind Caddy Basic Auth |

Both environments target a **generic Linux VM behind Cloudflare + Caddy**.
The template does not bake in a cloud-credential strategy for the api's
external SDKs (object storage etc.) — pick instance/workload identity or
static keys per the **decision point** in each environment's README.

CI auto-syncs each environment's `docker-compose.yml` and `Caddyfile`
into `/srv/<service>/` on every API deploy (`<service>` = your
`SERVICE_NAME`, default `nestjs`):

- `.github/workflows/deploy-production.yml` copies from `docs/prod/`
- `.github/workflows/deploy-staging.yml` copies from `docs/staging/`

> CRUD / resource scaffolding lives in [`resource-pattern.md`](./resource-pattern.md),
> not here — this directory is deployment-only.

## Architecture (both environments)

```
   Internet
      ↓ HTTPS (TLS 1.3)
  Cloudflare         ← DNS proxied (orange cloud), SSL/TLS = Full (Strict)
      ↓ HTTPS (Cloudflare Origin Cert + Authenticated Origin Pulls)
   Caddy :443         ← /srv/<service>/Caddyfile, routes by hostname
   ┌──┴───┬──────┐
   ↓      ↓      ↓
  api   admin   web        (internal docker network only)
   │      │      │
   └──────┴──────┴── postgres + redis (internal only)
```

Caddy is the single public entry point. `api`, `admin`, `web`,
`postgres`, and `redis` are reachable only on the internal docker
network — the only host port mappings are `80:80` and `443:443` on Caddy.

Routing by hostname (set in `.env`, consumed by the Caddyfile):

| Hostname           | Upstream    | Notes                                   |
|--------------------|-------------|-----------------------------------------|
| `API_HOSTNAME`     | `api:3000`  | `/api/docs*` → `Cache-Control: no-store` |
| `ADMIN_HOSTNAME`   | `admin:80`  | admin SPA                               |
| `WEB_HOSTNAME`     | (redirect)  | apex → 301 → `www.WEB_HOSTNAME`          |
| `www.WEB_HOSTNAME` | `web:80`    | customer-facing SPA (canonical host)    |

## Server layout (both environments)

The api repo is the **deployment hub**: its deploy workflow re-syncs the
infra files and rebuilds the api service. The SPA bundles are built from
sibling repos checked out next to it on the server; each SPA has its own
deploy workflow that only rebuilds its own service.

```
/srv/<service>/
  docker-compose.yml          ← copy of docs/<env>/docker-compose.yml
  Caddyfile                   ← copy of docs/<env>/Caddyfile
  .env                        ← copied from docs/<env>/.env.example, then filled in
  backup.sh                   ← copy of docs/<env>/backup.sh, chmod +x
  certs/
    origin.pem                ← Cloudflare Origin Certificate
    origin.key                ← chmod 600
    cf-origin-pull-ca.pem     ← Cloudflare Authenticated Origin Pulls CA
  backups/                    ← created by backup.sh
  <service>-api/              ← git clone (this repo — NestJS)
  <service>-admin/            ← git clone (admin SPA)
  <service>-web/              ← git clone (customer SPA)
```

Pick the environment-specific README for setup, secrets, and the
post-first-deploy operational reference.

## Adding a new SPA service

The template ships three app services (`api` + `admin` + `web`). A new
browser-facing SPA (`<name>` below — e.g. `vendor`, `affiliate`) is a
**5-touchpoint change** in both `docs/prod/` and `docs/staging/`:

1. **Hostname.** Add `<NAME>_HOSTNAME="<name>.example.com"` (and the
   staging equivalent) under the `# ─── public hostnames ───` block in
   `.env.example`. Operator must also create a proxied Cloudflare A
   record → the server IP before the first deploy, and ensure the Origin
   Cert covers the new hostname.
2. **Caddyfile.** Append a routing block mirroring the admin one —
   `{$<NAME>_HOSTNAME}` site directive, `import cloudflare_only` +
   `import origin_tls` + `import common_headers`, `reverse_proxy <name>:80`.
3. **docker-compose.yml.** Append a service block under `services:`
   mirroring admin (build context `./${SERVICE_NAME}-<name>`, a
   `VITE_API_BASE_URL` arg, `expose: ['80']`, `restart`, `logging`). Add
   `<NAME>_HOSTNAME: ${<NAME>_HOSTNAME}` to the `caddy.environment` block
   so the Caddyfile's placeholder substitution can resolve it.
4. **`CORS_ORIGIN`.** Append `https://${<NAME>_HOSTNAME}` to the env-file
   `CORS_ORIGIN` list. The API rejects boot in prod/staging if
   `CORS_ORIGIN` contains `*`, so explicit enumeration is mandatory.
5. **Vite build args.** Define `<NAME>_VITE_API_BASE_URL` (and any other
   build args the SPA needs) in `.env.example` alongside
   `ADMIN_VITE_API_BASE_URL`. The matching `services.<name>.build.args`
   reference reads it.

The SPA codebase lives in a sibling repo (`<service>-<name>/`) with its
own Dockerfile and deploy workflow. This api repo does NOT build the SPA
— the deploy workflow here only re-syncs `docker-compose.yml` and
`Caddyfile`. The first deploy succeeds even if the sibling SPA repo
doesn't exist yet; the affected service fails to build but doesn't block
api/admin/web.
