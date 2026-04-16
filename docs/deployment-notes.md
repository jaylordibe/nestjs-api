# Deployment notes (reference only)

These are reference snippets for a single-instance, build-on-server, nginx-in-Docker deployment with two environments: **staging** (QA testing) and **production**. Nothing here is wired into the project — copy what you need into a real project when you're ready to deploy.

---

## Architecture summary

- One VPS per environment (cheap: Hetzner CX22 / DigitalOcean Basic / similar)
- Docker + Docker Compose v2 installed on the host (no host nginx, no host certbot)
- Same git repo cloned to `/srv/nestjs-api` on the server
- `docker compose build` on the server (no container registry)
- Postgres 18, Redis 8, the API, and nginx all run as containers in one compose file
- nginx is the only service that publishes ports to the host (80, later 443)
- API binds only to the docker network (`expose: ['3000']`, no `ports:`)
- nginx reverse-proxies to `api:3000` via Docker DNS

---

## Required app-level support

For the API to correctly read client IPs through nginx, you need:

**`src/config/env.validation.ts`** — add to the Joi schema:
```ts
NODE_ENV: Joi.string()
  .valid('development', 'test', 'staging', 'production')   // added 'staging'
  .default('development'),

TRUST_PROXY: Joi.string().allow('').default(''),
```

**`src/config/configuration.ts`** — extend `AppConfig` and the factory:
```ts
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'staging' | 'production';
  // ...
  trustProxy: string;
}

export default (): AppConfig => ({
  // ...
  trustProxy: process.env.TRUST_PROXY ?? '',
});
```

**`src/main.ts`** — switch to typed Express app and apply trust proxy:
```ts
import { NestExpressApplication } from '@nestjs/platform-express';

const app = await NestFactory.create<NestExpressApplication>(AppModule, { ... });

const trustProxy = configService.get<string>('trustProxy') ?? '';
if (trustProxy) {
  const value = /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy;
  app.set('trust proxy', value);
}
```

**Why:** Without `trust proxy`, the throttler sees every request as coming from nginx's docker-bridge IP and lumps them all together. Set `TRUST_PROXY=1` in env (trust 1 hop = nginx).

**`.gitignore`** — add the env files so they're never committed:
```
.env.staging
.env.production
```

---

## docker-compose.staging.yml

```yaml
services:
  postgres:
    image: postgres:18.3
    container_name: ${SERVICE_NAME}-postgres-staging
    restart: unless-stopped
    shm_size: 256mb
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_INITDB_ARGS: '--encoding=UTF-8 --locale=C.UTF-8'
    volumes:
      - postgres-data:/var/lib/postgresql
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${DB_USER} -d ${DB_NAME}']
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:8.6.2
    container_name: ${SERVICE_NAME}-redis-staging
    restart: unless-stopped
    command: ['redis-server', '--requirepass', '${REDIS_PASSWORD}', '--appendonly', 'yes']
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD}
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD-SHELL', 'redis-cli -a "$$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG']
      interval: 5s
      timeout: 5s
      retries: 10

  api:
    build:
      context: .
    image: ${SERVICE_NAME}-api:staging
    container_name: ${SERVICE_NAME}-api-staging
    restart: unless-stopped
    env_file: .env.staging
    environment:
      NODE_ENV: staging
      DB_HOST: postgres
      REDIS_HOST: redis
      DATABASE_URL: postgresql://${DB_USER}:${DB_PASSWORD}@postgres:5432/${DB_NAME}?schema=public
      REDIS_URL: redis://default:${REDIS_PASSWORD}@redis:6379
    expose:
      - '3000'
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:3000/api/health/liveness >/dev/null || exit 1']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s

  nginx:
    image: nginx:1.27-alpine
    container_name: ${SERVICE_NAME}-nginx-staging
    restart: unless-stopped
    ports:
      - '${NGINX_HOST_PORT}:80'
      # - '${NGINX_HOST_PORT_TLS}:443'   # uncomment after TLS
    volumes:
      - ./nginx/staging.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      api:
        condition: service_healthy

  # One-shot migration runner. Uses the build-stage image (has prisma CLI).
  # Run with: docker compose -f docker-compose.staging.yml --profile migrate run --rm migrate
  migrate:
    build:
      context: .
      target: build
    image: ${SERVICE_NAME}-migrate:staging
    env_file: .env.staging
    environment:
      DB_HOST: postgres
      DATABASE_URL: postgresql://${DB_USER}:${DB_PASSWORD}@postgres:5432/${DB_NAME}?schema=public
    command: ['yarn', 'prisma:deploy']
    depends_on:
      postgres:
        condition: service_healthy
    profiles: ['migrate']

volumes:
  postgres-data:
    name: ${SERVICE_NAME}-postgres-staging-data
  redis-data:
    name: ${SERVICE_NAME}-redis-staging-data
```

## docker-compose.production.yml

Identical shape — just swap every `-staging` for `-prod`, every `:staging` image tag for `:prod`, every `.env.staging` for `.env.production`, and force `NODE_ENV: production`.

---

## nginx/staging.conf (and production.conf)

```nginx
upstream nestjs_api {
  server api:3000;          # docker service name + internal port
}

server {
  listen 80;
  listen [::]:80;
  server_name staging-api.example.com;   # or production hostname

  client_max_body_size 10M;              # 5M for production

  # location /.well-known/acme-challenge/ { root /var/www/certbot; }

  location / {
    proxy_pass http://nestjs_api;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        "upgrade";

    proxy_connect_timeout 5s;
    proxy_read_timeout    60s;          # 30s for production
    proxy_send_timeout    60s;
  }
}

# After TLS is configured, the HTTPS block goes here:
# server {
#   listen 443 ssl http2;
#   server_name staging-api.example.com;
#   ssl_certificate     /etc/letsencrypt/live/staging-api.example.com/fullchain.pem;
#   ssl_certificate_key /etc/letsencrypt/live/staging-api.example.com/privkey.pem;
#   client_max_body_size 10M;
#   location / { ...same proxy_pass block... }
# }
```

---

## .env.staging.example

```bash
NODE_ENV="staging"
PORT=3000

NGINX_HOST_PORT=80
NGINX_HOST_PORT_TLS=443

SERVICE_NAME="nestjs"

DB_USER="nestjs"
DB_PASSWORD="REPLACE"                    # openssl rand -base64 24 | tr -d /+=
DB_HOST="localhost"
DB_PORT=5432
DB_NAME="nestjs_staging"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public"

REDIS_HOST="localhost"
REDIS_PORT=6379
REDIS_PASSWORD="REPLACE"
REDIS_URL="redis://default:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}"

JWT_SECRET="REPLACE"                     # openssl rand -hex 48
JWT_EXPIRES_IN="30d"

CORS_ORIGIN="https://qa.example.com"

TRUST_PROXY="1"                          # nginx is 1 hop in front

THROTTLE_TTL_MS=60000
THROTTLE_LIMIT=60
```

`.env.production.example` is identical, with `NODE_ENV="production"`, real prod hostnames, and fresh secrets.

---

## scripts/deploy-staging.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

COMPOSE_FILE=docker-compose.staging.yml
ENV_FILE=.env.staging

SKIP_PULL=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) SKIP_PULL=1 ;;
    -h|--help) echo "Usage: $0 [--no-pull]"; exit 0 ;;
    *) echo "ERROR: unknown argument '$arg'" >&2; exit 1 ;;
  esac
done

[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not installed" >&2; exit 1; }

step() { printf '\n==> %s\n' "$*"; }

if [[ $SKIP_PULL -eq 0 ]]; then
  step "git pull --ff-only"
  git pull --ff-only
fi

step "Building api image"
docker compose -f "$COMPOSE_FILE" build api

step "Running database migrations"
docker compose -f "$COMPOSE_FILE" --profile migrate run --rm migrate

step "Starting / restarting services"
docker compose -f "$COMPOSE_FILE" up -d

step "Waiting for API to become healthy (via nginx)"
NGINX_HOST_PORT=$(grep -E '^NGINX_HOST_PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true)
NGINX_HOST_PORT=${NGINX_HOST_PORT:-80}
URL="http://127.0.0.1:${NGINX_HOST_PORT}/api/health/liveness"

for i in $(seq 1 30); do
  if curl -sf "$URL" >/dev/null; then
    printf '\n[OK] Deploy succeeded at %s\n' "$URL"
    exit 0
  fi
  sleep 2
done

printf '\n[FAIL] Health check did not pass within 60s.\n' >&2
printf '       Logs: docker compose -f %s logs --tail=200 api\n' "$COMPOSE_FILE" >&2
exit 1
```

`scripts/deploy-production.sh` is the same shape with one addition: a confirmation prompt requiring you to type `yes` before proceeding (skip with `--yes` for CI). Replace `staging` with `production` throughout.

---

## Runbook

### One-time server setup

```bash
ssh user@server
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker

sudo mkdir -p /srv && sudo chown $USER:$USER /srv
git clone <YOUR-REPO-URL> /srv/nestjs-api
cd /srv/nestjs-api

cp .env.staging.example .env.staging
nano .env.staging   # fill in DB_PASSWORD, REDIS_PASSWORD, JWT_SECRET, CORS_ORIGIN
```

### Initial deploy

```bash
docker compose -f docker-compose.staging.yml build
docker compose -f docker-compose.staging.yml --profile migrate run --rm migrate
docker compose -f docker-compose.staging.yml up -d
curl -sf http://127.0.0.1/api/health/liveness && echo OK
```

### Subsequent deploys

```bash
./scripts/deploy-staging.sh
```

### Common operations

```bash
# Tail API logs
docker compose -f docker-compose.staging.yml logs -f --tail=100 api

# Wipe and re-seed the staging DB (QA wants a fresh slate)
docker compose -f docker-compose.staging.yml down -v
docker compose -f docker-compose.staging.yml up -d postgres redis
docker compose -f docker-compose.staging.yml --profile migrate run --rm migrate
docker compose -f docker-compose.staging.yml up -d

# Roll back to a previous commit
git log --oneline -10
git checkout <previous-sha>
./scripts/deploy-staging.sh --no-pull

# Open psql against the staging DB
docker compose -f docker-compose.staging.yml exec postgres \
  psql -U "$(grep ^DB_USER .env.staging | cut -d= -f2- | tr -d \")" \
       -d "$(grep ^DB_NAME .env.staging | cut -d= -f2- | tr -d \")"
```

---

## TLS (deferred)

nginx-in-Docker doesn't combine cleanly with `certbot --nginx`. Three options when you're ready:

1. **Caddy instead of nginx** — auto-fetches Let's Encrypt certs, ~10 lines of compose, no certbot at all. Only catch: Caddyfile syntax instead of nginx config.
2. **certbot in a sidecar container** — keep nginx, run `certbot/certbot` in another compose service that shares two named volumes (`certbot-conf:/etc/letsencrypt`, `certbot-www:/var/www/certbot`). Bootstrap once with `certonly --webroot`, then a cron-style loop to renew.
3. **certbot on the host** — install certbot via `apt`, run `certonly` in standalone mode (briefly stop the nginx container to free port 80), mount `/etc/letsencrypt` read-only into the nginx container. Mixed model, not as clean.

For staging-behind-VPN, HTTP is acceptable. For production, do option 1 or 2 before going live.

---

## Production-only requirements

Before going live in production (none of these are configured by default):

1. **Backups** — daily `pg_dump` to off-server storage:
   ```bash
   # /etc/cron.d/prod-pg-backup
   0 3 * * * user docker compose -f /srv/nestjs-api/docker-compose.production.yml exec -T postgres pg_dump -U USER DBNAME | gzip > /srv/backups/prod-$(date +\%F).sql.gz
   ```
   Then `aws s3 cp` (or rclone) to S3/B2. **Test a restore** before trusting the backup.

2. **Log rotation** — `/etc/docker/daemon.json`:
   ```json
   { "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "10" } }
   ```
   Then `sudo systemctl restart docker`.

3. **Monitoring** — uptime check from outside the server hitting `/api/health/readiness` every minute. UptimeRobot, BetterStack, Healthchecks.io (free tiers).

4. **Disk monitoring** — alert at 80%. Logs + Postgres growth + container images add up faster than expected.

5. **`docker system prune -af` weekly** — old images and build cache accumulate over deploys.

---

## Single-instance trade-offs

This is fine for: early-stage products, internal tools, low-traffic SaaS.

This is NOT fine for: anything with SLA commitments, regulated workloads, or revenue-sensitive uptime.

When you outgrow it: managed Postgres (RDS / Neon / Supabase / Crunchy) → ≥2 API instances behind a load balancer (Fly.io / Render / ECS / Kubernetes) → managed Redis (ElastiCache / Upstash / Memorystore). Don't pre-optimize — graduate when you actually feel the pain.
