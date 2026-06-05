# Production Deployment

Runs on a generic Linux VM behind Cloudflare + Caddy. Two app
services — `api` + `web` — plus `postgres` + `redis`, all on
one docker-compose stack. Staging mirrors this exactly: see
[`docs/staging/README.md`](../staging/README.md).

CI syncs `docker-compose.yml` and `Caddyfile` from this folder to
`/srv/<service>/` on every API deploy (`<service>` = your `SERVICE_NAME`).
`.env.example` and `backup.sh` are references — changes to them don't
propagate to the live `.env` / `backup.sh` automatically (see
*Updating infra files*).

Throughout this doc, replace `<service>` with your `SERVICE_NAME`
(default `nestjs`) and `example.com` with your real domain.

## Cloud-credential decision point (read before step 3)

This template does **not** bake in a cloud-credential strategy. The
`api` service reaches external clouds (S3-compatible object storage,
and any future SDK that reads Application Default Credentials) and you
must pick how it authenticates. Two standard options:

- **Option A — instance / workload identity (recommended where
  available).** If the VM has an attached identity (AWS instance IAM
  role, GCE workload service account, etc.), the SDK's default
  credential chain pulls short-lived tokens from the instance metadata
  server. No static key file on disk, less to rotate. For S3, leave
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` blank in `.env` and
  grant the role write access to the bucket.

- **Option B — static service-account key / access key (works on any
  host).** On a generic VPS with no attached identity, supply static
  credentials. For S3, set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
  in `.env`. For an SDK that reads a JSON key file, SCP the file to
  `/srv/<service>/`, bind-mount it read-only into the `api` container
  (add a `volumes:` entry under `services.api` in this folder's
  `docker-compose.yml`), and point the SDK's env var (e.g.
  `GOOGLE_APPLICATION_CREDENTIALS`) at the in-container path. Add the
  filename to the repo `.gitignore` so it can never be committed.

The rest of this runbook assumes **Option A** (no key file). If you
pick Option B, also do the bind-mount + key-file steps inline where
noted.

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

Create a prod-only bucket so staging tests can't touch prod data, grant
the api's identity write access (per the decision point above), and make
object reads public if you serve `<img src="...">` straight from the
bucket. The exact commands depend on your provider (AWS S3, Cloudflare
R2, DigitalOcean Spaces, MinIO). Then set `STORAGE_S3_BUCKET` /
`STORAGE_S3_REGION` (+ `STORAGE_S3_ENDPOINT` for non-AWS) in `.env`.

If you picked **Option B**, also add the static `AWS_*` keys to `.env`
(or bind-mount a JSON key file — see the decision point).

### 4. Cloudflare

1. **DNS**: A records for `api.`, apex, and `www.` → server's
   public IP. Proxy enabled (orange cloud). The Origin Certificate in
   step 3 must cover all of these hostnames (a `*.example.com` wildcard
   plus the apex does; otherwise list each one explicitly).
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
      snippet uses `mode request` (accept but don't require the client
      cert). Reload Caddy:
      `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
   3. Toggle Authenticated Origin Pulls **ON** in the CF dashboard.
      Verify every request now arrives with `tls.peer_cert_chain` set
      (`docker compose logs caddy`).
   4. Restore `mode require_and_verify` in the Caddyfile and reload.

6. **Origin IP allowlist** — the Caddyfile also drops any connection
   that doesn't come from a Cloudflare-published IP range
   (`(cloudflare_only)` snippet). This is automatic; nothing to
   configure. CF updates these ranges very rarely. If you ever see real
   users 403'd, diff our list against
   [`cloudflare.com/ips-v4`](https://www.cloudflare.com/ips-v4) +
   [`ips-v6`](https://www.cloudflare.com/ips-v6) and redeploy.
   Direct-to-origin debugging (`curl https://<server-ip>` from your
   laptop) is intentionally blocked — go through the public hostname.

### 5. Infra files + secrets

```bash
cd /srv/<service>
cp <service>-api/docs/prod/docker-compose.yml docker-compose.yml
cp <service>-api/docs/prod/Caddyfile          Caddyfile
cp <service>-api/docs/prod/backup.sh          backup.sh
cp <service>-api/docs/prod/.env.example       .env

chmod +x backup.sh

# Generate secrets:
openssl rand -hex 48     # → JWT_SECRET
openssl rand -base64 32  # → DB_PASSWORD
openssl rand -base64 32  # → REDIS_PASSWORD

nano .env                # paste secrets, fill hostnames, STORAGE_S3_*,
                         # RESEND_API_KEY, EMAIL_FROM, TWILIO_*, SEED_*
chmod 600 .env
```

### 6. First deploy

```bash
cd /srv/<service>
docker compose up -d postgres redis
docker compose --profile migrate run --rm --build migrate
docker compose up -d --build api web
docker compose up -d caddy

# Seed the database (first deploy only). Runs on the `migrate` service, NOT
# `api`: the seeder is `ts-node prisma/seed.ts`, and the pruned api runtime
# image has no ts-node / prisma CLI / source. The migrate service uses the
# Dockerfile `build` target, which has them. Reads SEED_* from .env.
docker compose --profile migrate run --rm migrate yarn prisma:seed

# Smoke test:
curl -fsS "https://${API_HOSTNAME:-api.example.com}/api/health/liveness"
```

### 7. Schedule daily backups

```bash
crontab -e
# Add (replace <service> with your SERVICE_NAME):
0 3 * * * /srv/<service>/backup.sh >> /srv/<service>/backups/backup.log 2>&1
```

### 8. GitHub deploy secrets

In the api repo under **Settings → Environments → production**:

| Type | Name | Value |
|---|---|---|
| Secret | `PRODUCTION_HOST` | server public IP or DNS |
| Secret | `PRODUCTION_USER` | SSH user (in docker group, owns `/srv/<service>`) |
| Secret | `PRODUCTION_SSH_KEY` | private key for that user |
| Variable | `PRODUCTION_SERVICE_DIR` | `/srv/<service>` (the on-server project dir) |
| Variable | `PRODUCTION_URL` | `https://api.example.com` |

**Enable deploys.** The deploy job ships gated, so the template (and any
fresh clone) runs CI but never deploys. To turn on CD in a real project,
do **either**:

- **Simplest — remove the gate (recommended per project):** delete the
  `if: ${{ vars.DEPLOY_ENABLED == 'true' }}` line (and the comment above
  it) from the `deploy` job in **both** `.github/workflows/deploy-production.yml`
  and `deploy-staging.yml`. After that the deploy runs on every push (once
  tests pass). Do this **only after the secrets above are set** — the
  commit that removes the line, pushed to `main`, is itself the first
  deploy.
- **Or keep the gate and flip a switch:** set a **repository** variable
  `DEPLOY_ENABLED=true` under **Settings → Secrets and variables → Actions
  → Variables** — repository scope, NOT environment-scoped (a job's `if:`
  can't read environment variables). This decouples enabling from any push.

Either way the same gate covers prod and staging.

The `web` repo needs the same three secrets under its
own **Settings → Environments → production**, plus a `PRODUCTION_URL`
variable pointing at that SPA's hostname.

Strongly recommended: also enable **Required reviewers** on the
production environment so a human approves every prod deploy.

## Deploys after the first

CI handles them. On `git push origin main`:

1. `.github/workflows/test.yml` runs lint + tests + Trivy scan.
2. `.github/workflows/deploy-production.yml` SSHes into the server,
   hard-resets `<service>-api` to `origin/main`, syncs
   `docker-compose.yml`/`Caddyfile` from `docs/prod/`, runs migrations,
   rebuilds + force-recreates the api service, graceful-reloads Caddy,
   and runs a smoke test against `PRODUCTION_URL`. If the api never goes
   healthy, container logs are dumped into the workflow run.

The web repo follows the same pattern but only rebuilds
its own service — pushing to the api repo's `main` branch does NOT build
or start the SPA containers. Each SPA deploys when its own repo's `main`
branch is pushed.

## Manual operations

```bash
cd /srv/<service>

# Tail logs
docker compose logs -f --tail=200 api
docker compose logs -f caddy

# Run a one-off migration (CI also does this)
docker compose --profile migrate run --rm --build migrate

# Seed the database (first deploy only)
docker compose --profile migrate run --rm migrate yarn prisma:seed

# Open a Postgres shell
docker compose exec postgres psql -U "$(grep ^DB_USER .env | cut -d= -f2)" \
  -d "$(grep ^DB_NAME .env | cut -d= -f2)"

# Reload Caddy without dropping connections
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile

# Manual backup (cron does this nightly)
./backup.sh

# Restore a backup
gunzip -c backups/2026-04-27.sql.gz \
  | docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME"

# Force-rebuild the API only (deploy workflow already does this)
docker compose up -d --build --force-recreate api
```

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `502 Bad Gateway` from Caddy | Upstream container down / unhealthy | `docker compose ps`, `docker compose logs api` |
| `525 SSL handshake failed` from Cloudflare | Origin cert missing or wrong | `ls -la /srv/<service>/certs/`, `docker compose logs caddy` |
| `526 Invalid SSL certificate` after enabling AOP | `cf-origin-pull-ca.pem` missing, wrong path, or AOP not toggled ON | Re-curl the CA cert, check the dashboard toggle, `docker compose logs caddy` |
| Caddy logs `client didn't provide a certificate` | AOP enabled in Caddy but OFF in CF dashboard | Toggle ON in CF, or temporarily set `client_auth mode request` while diagnosing |
| Direct `curl https://<origin-ip>` hangs / connection-reset | Working as intended — non-CF source IPs are dropped by `(cloudflare_only)` | Route through the public CF hostname instead |
| `web` service fails to build on first deploy | Sibling SPA repo not cloned yet (step 2) | Clone the repo into `/srv/<service>/<service>-<name>` and re-run `docker compose up -d --build <name>` |
| Migrations exit non-zero | Schema drift / missing migration on disk | `docker compose --profile migrate run --rm migrate` (re-run, read output) |
| API logs `ECONNREFUSED postgres:5432` | Postgres not up yet (race) or container restart loop | `docker compose ps postgres`, `docker compose logs postgres` |
| Per-IP rate limiting acts globally / all clients same IP | `TRUST_PROXY` wrong | Should be `2` (Cloudflare + Caddy) |
| S3 uploads fail with 403 | Identity missing bucket write perms, or wrong static keys | Verify the IAM role / `AWS_*` keys and bucket policy |
| Disk filling up | Docker logs / dangling images | `docker image prune -f`, `docker system df` |

## Updating infra files

`docker-compose.yml`, `Caddyfile`, and `backup.sh` are tracked in this
repo. CI auto-syncs the first two on every API deploy. For `backup.sh`,
copy manually after editing:

```bash
ssh user@host 'cp /srv/<service>/<service>-api/docs/prod/backup.sh /srv/<service>/backup.sh && chmod +x /srv/<service>/backup.sh'
```

`.env.example` is a reference — changes to it don't propagate to the
server's live `.env` automatically. When you add a new variable, update
the live `.env` too.
