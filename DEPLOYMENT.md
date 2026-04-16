# Deployment

## Staging

A self-hosted staging environment for QA testing. Runs on a single VPS with Postgres + Redis + the API in Docker Compose, fronted by nginx for TLS and a friendly hostname.

### Prerequisites

- A VPS (Hetzner CX22, DigitalOcean Basic Droplet, Linode Nanode, or similar — anything with ≥2GB RAM and Docker support)
- Ubuntu 22.04 or 24.04 (other distros work; commands below assume Debian-family `apt`)
- A domain or subdomain you can point at the server (`staging-api.example.com`)
- SSH access as a non-root user with sudo

### One-time server setup

```bash
ssh user@staging-server

# Install Docker + Docker Compose v2. nginx runs IN compose, not on the host.
sudo apt update
sudo apt install -y docker.io docker-compose-plugin

# Add yourself to the docker group so you don't need sudo for docker commands
sudo usermod -aG docker $USER && newgrp docker

# Clone the repo somewhere stable
sudo mkdir -p /srv && sudo chown $USER:$USER /srv
git clone <YOUR-REPO-URL> /srv/nestjs-api
cd /srv/nestjs-api

# Create the env file from the template and fill in real secrets
cp .env.staging.example .env.staging
nano .env.staging
```

In `.env.staging` you must replace at minimum:

| Var | How to generate |
| --- | --- |
| `DB_PASSWORD` | `openssl rand -base64 24 \| tr -d /+=` |
| `REDIS_PASSWORD` | `openssl rand -base64 24 \| tr -d /+=` |
| `JWT_SECRET` | `openssl rand -hex 48` |
| `CORS_ORIGIN` | The QA frontend's origin, e.g. `https://qa.example.com`. Use `*` only if you really want to (locks nothing down). |

Leave `TRUST_PROXY=1` — required because nginx (running in the same compose) sits in front of the API and adds `X-Forwarded-For`. Without this the throttler would lump every request together as coming from nginx's docker-bridge IP.

### Initial deploy

```bash
# Build the image
docker compose -f docker-compose.staging.yml build

# Apply migrations (runs once, exits)
docker compose -f docker-compose.staging.yml --profile migrate run --rm migrate

# Start everything detached
docker compose -f docker-compose.staging.yml up -d

# Verify
curl -sf http://127.0.0.1:3000/api/health/liveness && echo OK
```

### Subsequent deploys

Use the helper script — it does git pull, build, migrate, restart, and a smoke health check:

```bash
ssh user@staging-server
cd /srv/nestjs-api
./scripts/deploy-staging.sh
```

Useful flags:
- `--no-pull` — deploy whatever is currently checked out (e.g. when you've manually pinned to a specific commit or tag)
- `--help` — print usage

The script exits non-zero if the post-deploy health check fails. Tail logs with `docker compose -f docker-compose.staging.yml logs --tail=200 api` to see why.

### nginx (in compose) + TLS

nginx runs as a service in the same compose file as the API — it's not installed on the host. The config lives in the repo at `nginx/staging.conf` and is mounted into the container read-only. Edit it, then either restart just nginx (`docker compose -f docker-compose.staging.yml restart nginx`) or do a full deploy.

To customize for your domain:

1. **Edit `nginx/staging.conf`**: replace `server_name _;` with your real hostname:
   ```nginx
   server_name staging-api.example.com;
   ```
2. **Reload nginx**:
   ```bash
   docker compose -f docker-compose.staging.yml restart nginx
   ```
3. **Verify** with `curl -sf -H 'Host: staging-api.example.com' http://127.0.0.1/api/health/liveness`.

Point a DNS A record at the staging server's IP (your VPS provider's dashboard) and the same `curl` against the public URL should also work.

#### Adding TLS

certbot doesn't fit the in-Docker model as cleanly as the host-nginx model. Three options, in order of "least to most setup":

**Option A — Caddy instead of nginx** (auto-TLS, recommended for staging).

Replace the `nginx` service in `docker-compose.staging.yml` with a `caddy` service, mount a Caddyfile, point its hostname at your domain. Caddy auto-fetches Let's Encrypt certs on startup and renews them. ~10 lines of compose, no certbot, no shared volumes. The catch: switching from your existing nginx-config pattern to Caddyfile syntax.

**Option B — certbot in a sidecar container** (keep nginx).

Run `certbot/certbot` in another compose service that shares two named volumes with nginx:
- `certbot-conf:/etc/letsencrypt` — where the certs live
- `certbot-www:/var/www/certbot` — webroot for the HTTP-01 challenge

Then enable the commented HTTPS block in `nginx/staging.conf`. The certbot container runs `certbot certonly --webroot ...` once to bootstrap, then a cron-style loop to renew. Real but more compose surface to maintain.

**Option C — Run certbot on the host** (mixed model, not recommended).

Install certbot on the host with `apt install certbot`, run it standalone (it'll bind port 80 — you'd have to stop the nginx container first), then mount `/etc/letsencrypt` as read-only into the nginx container. Works but defeats the "everything is in compose" cleanliness.

For QA staging where end-to-end TLS isn't strictly required, you can defer this and just use `http://`. For production, set up Option A or B before going live.

### Common operations

**Tail logs**
```bash
docker compose -f docker-compose.staging.yml logs -f --tail=100 api
docker compose -f docker-compose.staging.yml logs -f postgres   # less common
```

**Restart just the API (without redeploy)**
```bash
docker compose -f docker-compose.staging.yml restart api
```

**Wipe and re-seed the staging DB** (QA wants a fresh slate)
```bash
docker compose -f docker-compose.staging.yml down -v   # destroys postgres-data + redis-data volumes
docker compose -f docker-compose.staging.yml up -d postgres redis
docker compose -f docker-compose.staging.yml --profile migrate run --rm migrate
docker compose -f docker-compose.staging.yml up -d api
```

**Update env vars without rebuilding**

Edit `.env.staging`, then:
```bash
docker compose -f docker-compose.staging.yml up -d   # detects env changes, recreates affected containers
```

**Roll back a deploy**

The script doesn't keep tagged previous images; the simplest rollback is git-based:
```bash
git log --oneline -10            # find the previous good commit
git checkout <previous-sha>
./scripts/deploy-staging.sh --no-pull
```

**Connect a psql session to the staging DB**
```bash
docker compose -f docker-compose.staging.yml exec postgres \
  psql -U "$(grep ^DB_USER .env.staging | cut -d= -f2- | tr -d \")" \
       -d "$(grep ^DB_NAME .env.staging | cut -d= -f2- | tr -d \")"
```

### Things worth knowing

1. **Postgres and Redis are NOT exposed to the internet.** No `ports:` mapping in the staging compose file — they're reachable only from other containers on the same docker network. The only port published to the host is the API's loopback bind (`127.0.0.1:HOST_API_PORT`).

2. **The API container's `NODE_ENV` is forced to `staging`** in the compose file's `environment` block, regardless of what's in `.env.staging`. Defense in depth — you can't accidentally deploy a `NODE_ENV=development` build to a public server.

3. **Migrations run before the API recreates.** If a migration fails, the old API container keeps serving. The new one isn't started. So a broken migration causes a deploy failure, not user-visible downtime.

4. **Migration container uses the build-stage image**, not the runtime image. The runtime image strips devDeps (including the Prisma CLI), so migrations need a fatter image. The compose file's `target: build` handles this — same Dockerfile, different stop point.

5. **Volumes are namespaced with `${SERVICE_NAME}` and the suffix `-staging-data`**. So if you ever co-host prod on the same server (you shouldn't, but…), they can't collide.

6. **Backups aren't configured.** For QA staging, data is recreatable. If QA spends days populating fixtures, add a daily `pg_dump` cron:
   ```bash
   # /etc/cron.d/staging-pg-backup
   0 3 * * * user docker compose -f /srv/nestjs-api/docker-compose.staging.yml exec -T postgres pg_dump -U USER DBNAME | gzip > /srv/backups/staging-$(date +\%F).sql.gz
   ```

7. **Log rotation** — by default Docker doesn't rotate logs and they fill the disk. On a long-running staging, configure `/etc/docker/daemon.json`:
   ```json
   {
     "log-driver": "json-file",
     "log-opts": { "max-size": "10m", "max-file": "5" }
   }
   ```
   Then `sudo systemctl restart docker`.

8. **`bcrypt` native build** — the Dockerfile relies on `bcrypt`'s prebuilt binaries for `node:24-alpine`. If a future bcrypt release drops them, the build fails with a `python/g++ not found` error. Fix is to add `RUN apk add --no-cache python3 make g++` in the deps stage. Hasn't bitten us yet.

---

## Production

Same shape as staging — single VPS, direct build on the server, Postgres + Redis + API in Docker Compose, nginx for TLS. The only structural difference is a confirmation prompt in the deploy script. Operationally, it deserves more care: real backups, real monitoring, real on-call.

### Prerequisites

Same as staging, but with hardened expectations:
- A VPS sized for actual traffic — start with ≥4GB RAM and 2 vCPU; resize as you go
- A dedicated production domain (`api.example.com`)
- A backup destination (S3, B2, anywhere off-server)

### One-time server setup

Identical to staging — same `apt` install, same docker group setup, same git clone. Then:

```bash
cp .env.production.example .env.production
nano .env.production
```

Replace **every** `REPLACE_WITH_*` placeholder. Generate fresh secrets — never reuse staging's:

| Var | How to generate |
| --- | --- |
| `DB_PASSWORD` | `openssl rand -base64 24 \| tr -d /+=` |
| `REDIS_PASSWORD` | `openssl rand -base64 24 \| tr -d /+=` |
| `JWT_SECRET` | `openssl rand -hex 48` |
| `CORS_ORIGIN` | Your real frontend's origin, e.g. `https://app.example.com` |

Leave `TRUST_PROXY=loopback` (nginx is on the same host).

### Initial deploy

```bash
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml --profile migrate run --rm migrate
docker compose -f docker-compose.production.yml up -d
curl -sf http://127.0.0.1:3000/api/health/liveness && echo OK
```

### Subsequent deploys

```bash
ssh user@prod-server
cd /srv/nestjs-api
./scripts/deploy-production.sh
```

The script shows you what's about to ship and **requires you to type `yes`** before doing anything destructive. Different from staging on purpose — production deploys should never be muscle-memory.

Useful flags:
- `--no-pull` — deploy whatever's currently checked out (e.g. a specific git tag)
- `--yes` / `-y` — skip the confirmation prompt; intended for CI/automation only
- `--help` — print usage

### nginx (in compose) + TLS

Same structure as staging — `nginx/production.conf` is mounted into the in-compose nginx container. Edit `server_name` to your real production domain (`api.example.com`), restart nginx, point DNS at the server.

The production conf already has tighter defaults than staging:
- `client_max_body_size 5M` (vs 10M in staging)
- `proxy_read_timeout 30s` (vs 60s in staging)
- A commented-out HSTS header in the HTTPS block — uncomment **only after** you've confirmed HTTPS works end-to-end. HSTS is sticky in browsers (effectively a one-way switch for the validity period), so don't enable it before TLS is rock-solid.

For TLS, see the staging section's "Adding TLS" subsection — the three options (Caddy, certbot sidecar, host certbot) all apply. **For production, TLS is mandatory** — set up Option A or B before pointing public traffic at this server.

### Common operations

Same set of commands as staging, just swap `docker-compose.staging.yml` for `docker-compose.production.yml`. The most important ones:

**Tail logs**
```bash
docker compose -f docker-compose.production.yml logs -f --tail=200 api
```

**Roll back a bad deploy** (production-grade rollback is git-based — fast and safe):
```bash
git log --oneline -10
git checkout <previous-good-sha>
./scripts/deploy-production.sh --no-pull --yes   # bypass prompt; you've already decided
```

**`psql` into the production DB** — be very careful:
```bash
docker compose -f docker-compose.production.yml exec postgres \
  psql -U "$(grep ^DB_USER .env.production | cut -d= -f2- | tr -d \")" \
       -d "$(grep ^DB_NAME .env.production | cut -d= -f2- | tr -d \")"
```

**Update env vars without rebuilding the image**
```bash
nano .env.production
docker compose -f docker-compose.production.yml up -d   # detects env diff, recreates affected
```

### Operational requirements (do these before going live)

1. **Backups.** Production data is not recreatable. Set up at minimum a daily `pg_dump` to an off-server destination:
   ```bash
   # /etc/cron.d/prod-pg-backup
   0 3 * * * user docker compose -f /srv/nestjs-api/docker-compose.production.yml exec -T postgres pg_dump -U USER DBNAME | gzip > /srv/backups/prod-$(date +\%F).sql.gz
   ```
   Then `aws s3 cp` (or `rclone`) the backup off the server. **Test a restore** before you trust the backup.

2. **Log rotation.** `/etc/docker/daemon.json`:
   ```json
   { "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "10" } }
   ```
   Then `sudo systemctl restart docker`. Without this, container logs eventually fill the disk and crash everything.

3. **Monitoring + alerting.** At minimum: a synthetic check from outside the server hitting `https://api.example.com/api/health/readiness` every minute, paging you if it's down for >5 min. Free options: Uptime Robot, BetterStack, Healthchecks.io.

4. **Disk monitoring.** A 50GB VPS fills up faster than you think with logs + Postgres growth + container images. Alert at 80% used.

5. **TLS auto-renewal verification.** certbot installs a system timer; `sudo systemctl list-timers | grep certbot` should show it. Letsencrypt certs expire every 90 days — make sure renewal works before the first one expires (run `sudo certbot renew --dry-run`).

6. **`docker system prune` regularly.** Old images and build cache accumulate over many deploys. Either run `docker system prune -af --volumes=false` weekly via cron, or do it manually after each deploy.

### Differences vs. staging worth flagging

| Concern | Staging | Production |
| --- | --- | --- |
| Compose file | `docker-compose.staging.yml` | `docker-compose.production.yml` |
| Env file | `.env.staging` (gitignored) | `.env.production` (gitignored) |
| Container name suffix | `-staging` | `-prod` |
| Volume name suffix | `-staging-data` | `-prod-data` |
| Image tag | `:staging` | `:prod` |
| Forced `NODE_ENV` | `staging` | `production` |
| Deploy script | `deploy-staging.sh` | `deploy-production.sh` (with confirmation prompt) |
| Backups | Optional | **Required** |
| Monitoring | Optional | **Required** |
| Same VPS as staging? | Fine for QA | **Don't** — co-hosting prod and staging shares fault domain (one VPS reboot kills both) |

### A word of caution about single-instance production

Single-instance ("one VPS, no failover") production is a real choice with real tradeoffs:

- **Pros:** Cheap, simple, no orchestration, full control.
- **Cons:** Single point of failure. If the VPS dies (hardware, network, you fat-finger an `rm -rf`), your service is down until you can rebuild from backups. Updates to the underlying VPS OS require taking the API offline. No horizontal scaling.

This is fine for: early-stage products, internal tools, low-traffic SaaS, anything where occasional downtime is acceptable.

This is NOT fine for: paying-customer-facing apps where SLA matters, anything regulated (healthcare, finance), apps with revenue-sensitive uptime.

When you outgrow this setup, the path forward is usually:
1. Move Postgres to a managed service (RDS, Neon, Supabase, Crunchy)
2. Move the API to ≥2 instances behind a load balancer (Fly.io, Render, ECS, Kubernetes)
3. Move Redis to a managed service (ElastiCache, Upstash, Memorystore)

Don't pre-optimize for that — start with this single-instance setup, get to product-market fit, then graduate.
