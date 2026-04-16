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

# Install Docker, Docker Compose v2, nginx, certbot
sudo apt update
sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx

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

Leave `TRUST_PROXY=loopback` — required because nginx is on the same host and the API needs to see real client IPs (otherwise the throttler treats every request as coming from nginx).

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

### nginx + TLS

Drop this at `/etc/nginx/sites-available/staging-api.conf` (replace the hostname with yours):

```nginx
server {
    listen 80;
    server_name staging-api.example.com;

    # Allow Let's Encrypt's HTTP-01 challenge then redirect everything else
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name staging-api.example.com;

    # certbot will fill these in after the HTTP server above is reachable
    ssl_certificate /etc/letsencrypt/live/staging-api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staging-api.example.com/privkey.pem;

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout 60s;
    }
}
```

Enable the site, validate, reload, then issue the cert:

```bash
sudo ln -s /etc/nginx/sites-available/staging-api.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d staging-api.example.com
```

certbot edits the HTTPS server block in place and sets up auto-renewal via a system timer. Verify with `curl -sf https://staging-api.example.com/api/health/liveness`.

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
