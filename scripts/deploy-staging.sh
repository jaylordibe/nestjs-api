#!/usr/bin/env bash
#
# Deploy the staging environment.
#
# Usage:
#   scripts/deploy-staging.sh           # full deploy: git pull -> build -> migrate -> up -> healthcheck
#   scripts/deploy-staging.sh --no-pull # skip git pull (deploy whatever is checked out)
#   scripts/deploy-staging.sh --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

COMPOSE_FILE=docker-compose.staging.yml
ENV_FILE=.env.staging

SKIP_PULL=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) SKIP_PULL=1 ;;
    -h|--help)
      cat <<USAGE
Usage: $0 [--no-pull]

Steps performed:
  1. git pull --ff-only        (skip with --no-pull)
  2. docker compose build api
  3. Run pending Prisma migrations via the one-shot migrate service
  4. docker compose up -d       (recreates api; postgres/redis untouched if unchanged)
  5. Smoke-check GET /api/health/liveness on the host port
USAGE
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$arg' (try --help)" >&2
      exit 1
      ;;
  esac
done

# --- preflight checks ---

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found." >&2
  echo "       Copy .env.staging.example to .env.staging and fill in real secrets." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed or not on PATH." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' subcommand not available (need Docker Compose v2)." >&2
  exit 1
fi

step() { printf '\n==> %s\n' "$*"; }

# --- deploy ---

if [[ $SKIP_PULL -eq 0 ]]; then
  step "git pull --ff-only"
  git pull --ff-only
else
  step "Skipping git pull (--no-pull)"
fi

step "Building api image"
docker compose -f "$COMPOSE_FILE" build api

step "Running database migrations"
docker compose -f "$COMPOSE_FILE" --profile migrate run --rm migrate

step "Starting / restarting services"
docker compose -f "$COMPOSE_FILE" up -d

# --- post-deploy smoke check ---

step "Waiting for API to become healthy"
HOST_API_PORT=$(grep -E '^HOST_API_PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true)
HOST_API_PORT=${HOST_API_PORT:-3000}

URL="http://127.0.0.1:${HOST_API_PORT}/api/health/liveness"
for i in $(seq 1 30); do
  if curl -sf "$URL" >/dev/null; then
    printf '\n[OK] Deploy succeeded. API healthy at %s\n' "$URL"
    exit 0
  fi
  sleep 2
done

printf '\n[FAIL] Health check did not pass within 60s.\n' >&2
printf '       Check logs: docker compose -f %s logs --tail=100 api\n' "$COMPOSE_FILE" >&2
exit 1
