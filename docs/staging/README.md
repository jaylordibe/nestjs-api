# Staging Deployment

Runs on a generic Linux VM behind Cloudflare + Caddy — the same shape as
production. Two app services (`api` + `web`) plus
`postgres` + `redis` on one docker-compose stack. Production mirrors this:
see [`docs/prod/README.md`](../prod/README.md).

The only meaningful difference from prod: staging keeps Swagger
reachable (it's gated off in prod at the Nest layer) and locks
`/api/docs*` behind HTTP Basic Auth at the Caddy edge.

CI syncs `docker-compose.yml` and `Caddyfile` from this folder to
`/srv/<service>/` on every API deploy (`<service>` = your `SERVICE_NAME`).
`.env.example` and `backup.sh` are references — changes to them don't
propagate to the live `.env` / `backup.sh` automatically.

Throughout this doc, replace `<service>` with your `SERVICE_NAME`
(default `nestjs`) and `example.com` with your real domain.

## Cloud-credential decision point

Same as production — the template doesn't bake in a cloud-credential
strategy for the api's external SDKs (S3 storage etc.). Pick **Option A**
(instance / workload identity, recommended where available) or
**Option B** (static keys / mounted key file). See
[`docs/prod/README.md`](../prod/README.md#cloud-credential-decision-point-read-before-step-3)
for the full write-up. For staging, **Option B** with a dedicated
staging-only bucket + staging-only credentials is the common choice so
test data and access are isolated from prod.

## One-time setup

### 1. Server (Ubuntu)

```bash
# Docker + compose plugin
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# Add deploy user to docker group (replace `ubuntu` with your user)
sudo usermod -aG docker ubuntu
newgrp docker

# Firewall — only public-facing ports
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# Project dir
sudo mkdir -p /srv/<service>/certs /srv/<service>/backups
sudo chown -R "$USER:$USER" /srv/<service>
```

### 2. Clone the sibling repos

Each repo is a compose build context, and each SPA's own deploy workflow
does `cd /srv/<service>/<repo>` without cloning — so every directory must
exist on the server before its first deploy. The api deploy tolerates a
missing SPA repo (that service fails to build but doesn't block `api`).

```bash
cd /srv/<service>
git clone <api-repo-url>   <service>-api
git clone <web-repo-url>   <service>-web
```

### 3. Object storage (S3-compatible)

Create a staging-only bucket so test uploads can't touch prod data,
grant the api's identity (Option A) or static keys (Option B) write
access, and make object reads public if you serve images straight from
the bucket. Then set `STORAGE_S3_BUCKET` / `STORAGE_S3_REGION`
(+ `STORAGE_S3_ENDPOINT` for non-AWS, + `AWS_*` for static keys) in
`.env`. Consider a lifecycle rule that auto-deletes staging uploads
after ~30 days so they don't accumulate.

### 4. Cloudflare

1. **DNS**: A records for `api.staging.`, the staging
   apex, and `www.staging.` → server's public IP. Proxy enabled (orange
   cloud). The Origin Certificate in step 3 must cover all of these
   hostnames (a `*.staging.example.com` wildcard plus the apex does;
   otherwise list each one explicitly).
2. **SSL/TLS → Overview** → encryption mode = **Full (strict)**.
3. **SSL/TLS → Origin Server → Create Certificate** → defaults are fine.
   Save the certificate as `/srv/<service>/certs/origin.pem` and the
   private key as `/srv/<service>/certs/origin.key`.
4. **SSL/TLS → Edge Certificates** → enable *Always Use HTTPS* and
   *Automatic HTTPS Rewrites*.
5. **Authenticated Origin Pulls** — mandatory. The Caddyfile requires a
   CF-signed client cert on every TLS handshake
   (`client_auth mode require_and_verify`), so this must be enabled or
   the origin will refuse every request.

   On the host:
   ```bash
   curl -fsSL \
     https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem \
     -o /srv/<service>/certs/cf-origin-pull-ca.pem
   chmod 644 /srv/<service>/certs/cf-origin-pull-ca.pem
   chmod 600 /srv/<service>/certs/origin.key
   chmod 644 /srv/<service>/certs/origin.pem
   ```

   Then in the dashboard: **SSL/TLS → Origin Server → Authenticated
   Origin Pulls → ON**.

   **Rollout order (avoids any failed-handshake window)** — only
   relevant if you're enabling AOP on an already-running deploy;
   first-time provisioning can skip straight to step (4):
   1. Place `cf-origin-pull-ca.pem` on the host (curl above).
   2. Temporarily edit `/srv/<service>/Caddyfile` so the `(origin_tls)`
      snippet uses `mode request`. Reload Caddy:
      `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
   3. Toggle Authenticated Origin Pulls **ON** in the CF dashboard.
   4. Restore `mode require_and_verify` in the Caddyfile and reload.

6. **Origin IP allowlist** — the Caddyfile drops any connection that
   doesn't come from a Cloudflare-published IP range
   (`(cloudflare_only)` snippet). Automatic; nothing to configure. If
   you ever see real users 403'd, diff our list against
   [`cloudflare.com/ips-v4`](https://www.cloudflare.com/ips-v4) +
   [`ips-v6`](https://www.cloudflare.com/ips-v6) and redeploy.

### 5. Infra files + secrets

```bash
cd /srv/<service>
cp <service>-api/docs/staging/docker-compose.yml docker-compose.yml
cp <service>-api/docs/staging/Caddyfile          Caddyfile
cp <service>-api/docs/staging/backup.sh          backup.sh
cp <service>-api/docs/staging/.env.example       .env

chmod +x backup.sh

# Generate secrets:
openssl rand -hex 48     # → JWT_SECRET
openssl rand -base64 32  # → DB_PASSWORD
openssl rand -base64 32  # → REDIS_PASSWORD

nano .env                # paste secrets, fill hostnames, STORAGE_S3_*,
                         # SWAGGER_BASIC_AUTH_*, SEED_*
chmod 600 .env
```

#### Swagger Basic Auth (staging only)

Production has Swagger disabled at the Nest layer. Staging keeps it on
but gates `/api/docs*` behind HTTP Basic Auth at the Caddy edge so
attackers guessing the staging hostname hit a login prompt before the
schema.

```bash
# 1) Pick a username + password and generate a bcrypt hash.
#    The `caddy hash-password` CLI prompts twice, prints the hash.
docker compose exec caddy caddy hash-password

# 2) Paste the bcrypt output into .env, WRAPPED IN SINGLE QUOTES.
nano .env
#   SWAGGER_BASIC_AUTH_USER=devs
#   SWAGGER_BASIC_AUTH_PASSWORD_HASH='$2a$14$YFNFCKHZDlVtVDiL8IyjBu9YrFhOGJ3ujDYCVJbBYoblnO8zXs9tO'

# 3) Recreate Caddy so it re-reads .env. A plain `caddy reload` won't
#    pick up new docker env vars; only `up -d` (which re-creates the
#    container) does.
docker compose up -d caddy
```

**Gotcha — single quotes, not double**: bcrypt hashes start with
`$2a$14$...`. Docker Compose performs `${VAR}` interpolation on .env
values, so an unquoted or double-quoted `$` would be expanded or trigger
"variable is not set" warnings. Single quotes disable that pass.

### 6. First deploy

```bash
cd /srv/<service>
docker compose up -d postgres redis
docker compose --profile migrate run --rm --build migrate
docker compose up -d --build api web
docker compose up -d caddy

# Seed the BOOTSTRAP USERS (first deploy only). Runs on the `migrate` service,
# NOT `api`: the seeder is `ts-node prisma/seed.ts`, and the pruned api runtime
# image has no ts-node / prisma CLI / source. The migrate service uses the
# Dockerfile `build` target, which has them. Reads SEED_* from .env.
#
# NOTE: the authorization catalog (permissions + system roles) is NOT seeded
# here. It is projected by `yarn rbac:sync`, which the `migrate` service already
# runs on EVERY deploy — the api refuses to boot if the catalog and the database
# disagree, so it cannot be a manual step. `prisma:seed` re-runs `rbac:sync`
# internally, so running it here is harmless.
docker compose --profile migrate run --rm migrate yarn prisma:seed

# Smoke test:
curl -fsS "https://${API_HOSTNAME:-api.staging.example.com}/api/health/liveness"
```

### 7. Schedule daily backups (optional on staging)

```bash
crontab -e
# Add (replace <service> with your SERVICE_NAME):
0 3 * * * /srv/<service>/backup.sh >> /srv/<service>/backups/backup.log 2>&1
```

### 8. GitHub deploy secrets

In the api repo under **Settings → Environments → staging**:

| Type | Name | Value |
|---|---|---|
| Secret | `STAGING_HOST` | server public IP or DNS |
| Secret | `STAGING_USER` | SSH user (in docker group, owns `/srv/<service>`) |
| Secret | `STAGING_SSH_KEY` | private key for that user |
| Variable | `STAGING_SERVICE_DIR` | `/srv/<service>` (the on-server project dir) |
| Variable | `STAGING_URL` | `https://api.staging.example.com` |

**Enable deploys.** The deploy job ships gated, so the template (and fresh
clones) run CI but never deploy. To enable CD in a real project, **either**
delete the `if: ${{ vars.DEPLOY_ENABLED == 'true' }}` line (and its comment)
from the `deploy` job in **both** deploy workflows — the simplest per-project
option, do it only after secrets are set — **or** set the **repository**
variable `DEPLOY_ENABLED=true` (Settings → Secrets and variables → Actions →
Variables; repository scope, NOT environment-scoped). The same gate covers
prod and staging; see `docs/prod/README.md` for details.

The `web` repo needs the same three secrets under its
own **Settings → Environments → staging**, plus a `STAGING_URL` variable
pointing at that SPA's hostname.

## Deploys after the first

CI handles them. On `git push origin staging`:

1. `.github/workflows/test.yml` runs lint + tests + Trivy scan (the
   staging workflow gates on it via `needs: test`).
2. `.github/workflows/deploy-staging.yml` SSHes into the server,
   hard-resets `<service>-api` to `origin/staging`, syncs
   `docker-compose.yml`/`Caddyfile` from `docs/staging/`, runs
   migrations, rebuilds + force-recreates the api service,
   graceful-reloads Caddy, runs a smoke test against `STAGING_URL`.

The web repo follows the same pattern but only rebuilds
its own service.

## Manual operations

```bash
cd /srv/<service>

# Tail logs
docker compose logs -f --tail=200 api
docker compose logs -f caddy

# Run a one-off migration (CI also does this)
docker compose --profile migrate run --rm --build migrate

# Reset the database (staging only — destroys all data)
docker compose exec api yarn prisma:reset
docker compose --profile migrate run --rm migrate yarn prisma:seed

# Open a Postgres shell
docker compose exec postgres psql -U "$(grep ^DB_USER .env | cut -d= -f2)" \
  -d "$(grep ^DB_NAME .env | cut -d= -f2)"

# Reload Caddy without dropping connections
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile

# Manual backup
./backup.sh

# Force-rebuild the API only
docker compose up -d --build --force-recreate api
```

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `502 Bad Gateway` from Caddy | Upstream container down / unhealthy | `docker compose ps`, `docker compose logs api` |
| `525 SSL handshake failed` from Cloudflare | Origin cert missing or wrong | `ls -la /srv/<service>/certs/`, `docker compose logs caddy` |
| `526 Invalid SSL certificate` after enabling AOP | `cf-origin-pull-ca.pem` missing, wrong path, or AOP not toggled ON | Re-curl the CA cert, check the dashboard toggle, `docker compose logs caddy` |
| Caddy logs `client didn't provide a certificate` | AOP enabled in Caddy but OFF in CF dashboard | Toggle ON in CF, or temporarily set `client_auth mode request` while diagnosing |
| `/api/docs` returns 401 in browser | Working as intended — Swagger Basic Auth | Enter the `SWAGGER_BASIC_AUTH_*` credentials |
| Swagger Basic Auth always rejects / Compose warns "variable is not set" | bcrypt hash double-quoted or unquoted in .env | Single-quote `SWAGGER_BASIC_AUTH_PASSWORD_HASH`, then `docker compose up -d caddy` |
| `web` service fails to build on first deploy | Sibling SPA repo not cloned yet (step 2) | Clone the repo into `/srv/<service>/<service>-<name>` and re-run `docker compose up -d --build <name>` |
| Migrations exit non-zero | Schema drift / missing migration on disk | `docker compose --profile migrate run --rm migrate` (re-run, read output) |
| Per-IP rate limiting acts globally | `TRUST_PROXY` wrong | Should be `2` (Cloudflare + Caddy) |
| S3 uploads fail with 401/403 | Wrong/revoked keys, or identity missing bucket perms | Verify the IAM role / `AWS_*` keys and bucket policy |
