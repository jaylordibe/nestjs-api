# Production Deployment

> **SINGLE-VM DEPLOYMENT SHAPE.** This describes one **Linux VM** running
> everything in Docker Compose. It works and is maintained, but it predates the
> provider-neutral runtime contract in
> [`docs/deployment/README.md`](../deployment/README.md), which is where to
> start for any container platform.
>
> Two things below differ from that contract: **one container runs both the API
> and the queue worker here** (`QUEUE_WORKER_ENABLED` defaults to `true`,
> correct only where nothing autoscales), and the **object-storage prose still
> discusses static cloud access keys** — the application now accepts no
> long-lived credential for any storage provider, and the `.env.example` in this
> folder reflects that even where the surrounding text does not.

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

## Object-storage credential decision point (read before step 3)

The `api` service can persist uploads to **S3 (or any S3-compatible service),
Google Cloud Storage, or Azure Blob Storage** — one adapter each, selected by
`STORAGE_PROVIDER`. It can also run with `stub`, which persists nothing.

**This template supplies no variable for a long-lived cloud credential, for any
provider.** No access key, no service-account JSON, no account key, no
connection string. Each adapter authenticates through its platform's keyless
identity chain, so the decision here is which identity the VM presents:

- **The VM already has a cloud identity** (an attached instance role or service
  account). Nothing to configure — the SDK's default chain picks it up from the
  instance metadata service.
- **The VM has no cloud identity** — the usual case for a generic VPS. Use
  workload identity federation: the host exchanges an OIDC token it already has
  for short-lived cloud credentials. Write the federation config into
  `/srv/<service>/`, bind-mount it read-only into the `api` container, and point
  the provider's standard discovery variable at it. That file describes *how to
  obtain* credentials and holds no secret material.
- **Neither is available.** Run an S3-compatible object store you control
  (MinIO) alongside the stack, with `STORAGE_PROVIDER=s3` and
  `STORAGE_S3_ENDPOINT`, rather than downloading a static key.

Grant whichever identity you end up with write access to that one bucket, scoped
to it alone.

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

### 3. Object storage

Create a prod-only bucket so staging tests can't touch prod data, and grant the
api's identity write access to it (per the decision point above). Then set
`STORAGE_PROVIDER` to `s3`, `gcs` or `azure` and that provider's two or three
variables — see the object-storage block in this folder's `.env.example`.

**Decide the bucket's read policy deliberately.** The default is PRIVATE: with
`STORAGE_PUBLIC_URL_BASE` unset the API returns no public URL and reads go
through short-lived signed URLs. Set that variable only if the bucket really is
world-readable or fronted by a CDN — it is an explicit assertion, not a
convenience.

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

nano .env                # paste secrets, fill hostnames, STORAGE_GCS_*,
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
| Secret | `PRODUCTION_SSH_KEY` | private key for that user — **unencrypted**, runner→VM only |
| Secret | `PRODUCTION_SSH_KNOWN_HOSTS` | the server's `known_hosts` line(s). See below. |
| Variable | `PRODUCTION_SERVICE_DIR` | `/srv/<service>` (the on-server project dir) — must match `^/[A-Za-z0-9._/-]+$` |
| Variable | `PRODUCTION_URL` | `https://api.example.com` |

#### Pin the host key (`PRODUCTION_SSH_KNOWN_HOSTS`)

The workflow will **not** run `ssh-keyscan`. Trusting whatever answers on port 22
is a fresh trust-on-first-use decision on every run, made unattended — anyone who
can intercept that first packet is handed the deploy key and runs the deploy
script on their own box. The expected key is pinned instead.

Generate it **once, from a network you trust** (ideally on the server itself):

```bash
# On the server — no network in the path at all:
ssh-keyscan -t ed25519 localhost | sed "s/^localhost/<host-or-ip>/"

# Or from your laptop, then verify the fingerprint out of band against
# `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the server:
ssh-keyscan -t ed25519 <host-or-ip>
```

Paste the full line(s) into the secret. The workflow validates it with
`ssh-keygen -l -f` and fails loudly if it is empty or malformed, so a bad paste
surfaces as a clear error rather than as an "unknown host" that looks like a
network blip.

**Rotate it whenever the server is rebuilt** — a new VM has a new host key, and
the deploy will correctly refuse until this secret is updated.

#### Give the server its own deploy key

Agent forwarding is disabled. The runner's key authenticates the runner to the
VM and nothing else; it is never available to processes on the VM. The VM
therefore needs its own credential to `git fetch`:

```bash
# On the server, as the deploy user:
ssh-keygen -t ed25519 -N '' -C "prod-deploy@$(hostname)" -f ~/.ssh/github_deploy
cat ~/.ssh/github_deploy.pub

cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF

# Trust GitHub's host key from their published list, not from a keyscan:
curl -fsS https://api.github.com/meta | jq -r '.ssh_keys[] | "github.com \(.)"' \
  >> ~/.ssh/known_hosts

ssh -T git@github.com   # expect "successfully authenticated"
```

Add the printed **public** key to the api repo under **Settings → Deploy keys**,
with **"Allow write access" left OFF**. Two separate credentials, each doing one
job: compromising the VM yields a read-only key to one repository, not the key
that opens the VM.

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

### When a release is NOT backwards-compatible

Note the ordering above: migrations run **before** the new container starts, so
the **old** build serves traffic against the **new** schema for the whole
build-and-swap window. That is why migrations must normally be expand-only — add
nullable, backfill separately, tighten in a later release — and it is what the
`migration-safety` CI job proves by booting the released build against the
proposed schema.

A release that cannot satisfy that (a dropped or renamed table, a tightened
constraint the running code violates) needs a **maintenance window**, and the
automated deploy will not give you one. Take the API down first:

```bash
cd /srv/<service>

# 1. Stop serving. Requests fail fast rather than hitting a schema the running
#    build cannot read.
docker compose stop api

# 2. Migrate against a database nothing is reading.
docker compose --profile migrate run --rm --build migrate

# 3. Bring the NEW build up. `--wait` blocks on the healthcheck.
docker compose up -d --force-recreate --wait api
```

CI tells you when this applies: the `migration-safety` job fails the
released-build check, or — for a deliberate baseline rewrite — prints a warning
naming exactly which assertions it skipped and why. **Do not merge past either
without reading it.** Both mean the same thing: the running build cannot serve
traffic on the new schema.

Rolling back a schema change means restoring a backup, not redeploying — so
confirm you have a **verified** one before starting. See
[`../operations.md`](../operations.md), which is candid about the fact that the
shipped backup script is neither scheduled nor verified by default.

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

## Queue worker

The `api` container runs the BullMQ worker in-process
(`QUEUE_WORKER_ENABLED=true`, the default). Nothing extra to deploy.

**Monitor `GET /api/health/workers`.** It is deliberately *off* readiness — a
restarting worker must not pull the API out of rotation — which also means
nothing else will tell you the worker has stopped consuming. It returns 503
when no heartbeat has landed within ~15 minutes.

```bash
# Is anything consuming the queues?
docker compose exec api node -e "fetch('http://localhost:3000/api/health/workers').then(r=>r.text()).then(console.log)"

# Lifecycle log lines are logfmt and greppable by event
docker compose logs api | grep 'event=failed'
docker compose logs api | grep 'event=retried'
```

**Queued jobs are exactly as durable as Redis.** The `redis` service runs
`--appendonly yes` against a named volume, so waiting, delayed and retryable
jobs survive a restart of the api, the worker and Redis itself. There is no
in-memory fallback by design — one would mean jobs silently vanishing.

### Splitting the worker into its own container

Not needed at low volume. When job throughput justifies it this is a deployment
change only, no code change — `src/worker.ts` already bootstraps the same
`AppModule` without an HTTP server:

1. Add a `worker` service to `docker-compose.yml`: same `build.context` and
   `image` as `api`, plus `command: ["node", "dist/worker.js"]`.
2. Healthcheck it against the queue heartbeat key rather than an HTTP endpoint
   — a process with no HTTP server has no other way to answer one.
3. Set `QUEUE_WORKER_ENABLED=false` on the `api` service. It keeps enqueuing
   everything; the jobs just wait for the worker.
4. Mirror the api service's build / stop / recreate steps in
   `.github/workflows/deploy-production.yml`.
5. Give it a `stop_grace_period` above the worker's 25s drain budget
   (`WORKER_SHUTDOWN_TIMEOUT_MILLISECONDS` in `src/worker.ts`), so a shutdown
   reports what it abandoned instead of being SIGKILLed mid-job.

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
| `/api/health/readiness` 503 with `queue: down` | API cannot reach Redis to enqueue work | `docker compose ps redis`, `docker compose logs redis`, then `docker compose logs api \| grep 'Queue health check failed'` for the real cause (it is logged, never returned) |
| `/api/health/workers` 503, readiness green | Nothing is consuming the queues — worker crashed, or `QUEUE_WORKER_ENABLED` is false with no worker container running | `docker compose logs api \| grep QueueProcessor`, check `QUEUE_WORKER_ENABLED` in `.env` |
| Jobs fail immediately without retrying | Permanent failure by design — unknown job name, or a payload version this release doesn't accept (usually a half-finished rolling deploy) | `docker compose logs api \| grep 'event=failed'` — the `reason=` field names it |
| A recurring job fires that no code declares | Orphaned BullMQ scheduler left in Redis | Boot reconciliation removes it; look for `Removing orphaned recurring schedule` in the api logs |
| Per-IP rate limiting acts globally / all clients same IP | `TRUST_PROXY` wrong | Should be `2` (Cloudflare + Caddy) |
| GCS uploads fail with 403 | Runtime identity lacks `roles/storage.objectAdmin` on the bucket, or ADC resolved a different project | Check the binding on the bucket and that `STORAGE_GCS_PROJECT_ID` names the project that owns it |
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
