# Deployment

The application is **cloud-provider neutral**. It depends on generic
capabilities — an HTTP runtime, PostgreSQL, a Redis-compatible backend, object
storage, runtime-injected secrets, a worker runtime, stdout logging and HTTP
health checks — and on nothing that ties it to one vendor.

Three commands deploy it anywhere:

| Runtime | Command | `QUEUE_WORKER_ENABLED` |
|---|---|---|
| API | `node dist/main.js` | `false` |
| Worker | `node dist/worker.js` | `true` |
| Migration | the Prisma deploy script | n/a |

| Document | What it is |
|---|---|
| **[`deployment/`](./deployment/README.md)** | **The contract.** Runtime commands, container, database, Redis, storage, secrets, health and environment — provider-neutral, with AWS / Google Cloud / Azure / Kubernetes / Compose shown only as example mappings. **Start here.** |
| [`prod/`](./prod/README.md), [`staging/`](./staging/README.md) | A complete **single-VM** Docker Compose deployment behind Cloudflare + Caddy. |
| [`operations.md`](./operations.md) | Which operational controls are actually enforced versus only scaffolded. |

## Read this before using `prod/` or `staging/`

Those two directories describe **one VM running everything**: the API, a
worker in the same process, Postgres, Redis and Caddy as containers on one
host. That is a legitimate way to run this template and the files are not
abandoned — but they encode assumptions the generic contract does not
share, and a few of them are actively wrong if you copy them onto a
managed container platform:

- **One process runs both API and worker.** Those compose files set no
  `QUEUE_WORKER_ENABLED`, so it defaults to `true` and one container does
  everything. Correct on one box with no autoscaler; wrong the moment the
  API scales horizontally, because every API instance would then consume
  jobs and race to reconcile the same recurring schedules.
- **Redis is plaintext on a private docker network.** No TLS, because
  nothing off the host can reach it. A managed Redis needs
  `REDIS_TLS_ENABLED=true` and a `rediss://` URL.
- **The Swagger gate is Caddy Basic Auth.** A managed container platform has
  no Caddy in front of it, so use `SWAGGER_ENABLED` instead.
- **Object storage credentials.** Those READMEs still discuss supplying static
  access keys. The application no longer accepts any long-lived cloud
  credential for any provider — every storage adapter authenticates through
  its platform's keyless identity chain. Both env templates have been updated;
  prefer [`deployment/`](./deployment/README.md) for the current contract.

The per-environment files remain self-contained (compose, Caddyfile, env
template, backup script, README) so the two VM environments can drift to
fit their host without leaking config into each other.

| Environment | Folder | Branch | Notes |
|-------------|--------|--------|-------|
| Production  | [`prod/`](./prod/README.md)       | `main`    | Swagger hidden at the Nest layer |
| Staging     | [`staging/`](./staging/README.md) | `staging` | Swagger reachable, gated behind Caddy Basic Auth |

CI auto-syncs each environment's `docker-compose.yml` and `Caddyfile`
into `/srv/<service>/` on every API deploy (`<service>` = your
`SERVICE_NAME`, default `nestjs`):

- `.github/workflows/deploy-production.yml` copies from `docs/prod/`
- `.github/workflows/deploy-staging.yml` copies from `docs/staging/`

> CRUD / resource scaffolding lives in [`resource-pattern.md`](./resource-pattern.md),
> not here — this directory is deployment-only.

**Before you run any of this against real data, read
[`operations.md`](./operations.md).** It is an honest inventory of which
operational controls this template actually enforces and which it only gives you
a place to put — backups, restore verification, RPO/RTO, secret rotation,
retention, queue backpressure, incident response, and rollback. Several of them
are scaffolded but **not scheduled**, which means they are not running until you
wire them up. That page says so rather than implying coverage.

## Architecture (both environments)

```
   Internet
      ↓ HTTPS (TLS 1.3)
  Cloudflare         ← DNS proxied (orange cloud), SSL/TLS = Full (Strict)
      ↓ HTTPS (Cloudflare Origin Cert + Authenticated Origin Pulls)
   Caddy :443         ← /srv/<service>/Caddyfile, routes by hostname
   ┌──┴───┐
   ↓      ↓
  api    web          (internal docker network only)
   │      │
   └──────┴── postgres + redis (internal only)
```

Caddy is the single public entry point. `api`, `web`,
`postgres`, and `redis` are reachable only on the internal docker
network — the only host port mappings are `80:80` and `443:443` on Caddy.

Routing by hostname (set in `.env`, consumed by the Caddyfile):

| Hostname           | Upstream    | Notes                                   |
|--------------------|-------------|-----------------------------------------|
| `API_HOSTNAME`     | `api:3000`  | `/api/docs*` → `Cache-Control: no-store` |
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
  <service>-web/              ← git clone (customer SPA)
```

Pick the environment-specific README for setup, secrets, and the
post-first-deploy operational reference.

## Adding a new SPA service

The template ships two app services (`api` + `web`). Any additional
browser-facing SPA (`<name>` below — e.g. `admin`, `vendor`, `affiliate`)
is a per-project opt-in: a **5-touchpoint change** in both `docs/prod/`
and `docs/staging/`. The steps below use an **admin** console as the
worked example (substitute your own `<name>`):

1. **Hostname.** Add `<NAME>_HOSTNAME="<name>.example.com"` (e.g.
   `ADMIN_HOSTNAME="admin.example.com"`, and the staging equivalent)
   under the `# ─── public hostnames ───` block in `.env.example`.
   Operator must also create a proxied Cloudflare A record → the server
   IP before the first deploy, and ensure the Origin Cert covers the new
   hostname.
2. **Caddyfile.** Append a routing block mirroring the existing `web`
   one — `{$<NAME>_HOSTNAME}` site directive, `import cloudflare_only` +
   `import origin_tls` + `import common_headers`, `reverse_proxy <name>:80`
   (e.g. `reverse_proxy admin:80`).
3. **docker-compose.yml.** Append a service block under `services:`
   mirroring `web` (build context `./${SERVICE_NAME}-<name>`, a
   `VITE_API_BASE_URL` arg, `expose: ['80']`, `restart`, `logging`). Add
   `<NAME>_HOSTNAME: ${<NAME>_HOSTNAME}` to the `caddy.environment` block
   so the Caddyfile's placeholder substitution can resolve it.
4. **`CORS_ORIGIN`.** Append `https://${<NAME>_HOSTNAME}` to the env-file
   `CORS_ORIGIN` list (e.g. it becomes
   `https://${ADMIN_HOSTNAME},https://www.${WEB_HOSTNAME}`). The API
   rejects boot in prod/staging if `CORS_ORIGIN` contains `*`, so
   explicit enumeration is mandatory.
5. **Vite build args.** Define `<NAME>_VITE_API_BASE_URL` (e.g.
   `ADMIN_VITE_API_BASE_URL`, and any other build args the SPA needs) in
   `.env.example` alongside `WEB_VITE_API_BASE_URL`. The matching
   `services.<name>.build.args` reference reads it.

The SPA codebase lives in a sibling repo (`<service>-<name>/`) with its
own Dockerfile and deploy workflow. This api repo does NOT build the SPA
— the deploy workflow here only re-syncs `docker-compose.yml` and
`Caddyfile`. The first deploy succeeds even if the sibling SPA repo
doesn't exist yet; the affected service fails to build but doesn't block
api/web.
