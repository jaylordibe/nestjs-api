#!/usr/bin/env bash
#
# Deploy the production environment.
#
# Usage:
#   scripts/deploy-production.sh             # full deploy with confirmation prompt
#   scripts/deploy-production.sh --no-pull   # skip git pull (deploy whatever is checked out)
#   scripts/deploy-production.sh --yes       # skip the confirmation prompt (for automation)
#   scripts/deploy-production.sh --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

COMPOSE_FILE=docker-compose.production.yml
ENV_FILE=.env.production

SKIP_PULL=0
SKIP_CONFIRM=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) SKIP_PULL=1 ;;
    --yes|-y) SKIP_CONFIRM=1 ;;
    -h|--help)
      cat <<USAGE
Usage: $0 [--no-pull] [--yes]

Deploys the production environment.

Steps performed:
  1. Show what's about to be deployed and prompt for confirmation
  2. git pull --ff-only         (skip with --no-pull)
  3. docker compose build api
  4. Run pending Prisma migrations via the one-shot migrate service
  5. docker compose up -d        (recreates api; postgres/redis untouched if unchanged)
  6. Smoke-check GET /api/health/liveness on the host port

Flags:
  --no-pull   Skip 'git pull'. Use when you've manually checked out a tag.
  --yes, -y   Skip the confirmation prompt. Intended for CI/automation.
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
  echo "       Copy .env.production.example to .env.production and fill in real secrets." >&2
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

# --- confirmation gate ---

if [[ $SKIP_CONFIRM -eq 0 ]]; then
  CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo '(detached)')
  CURRENT_HEAD=$(git log -1 --oneline 2>/dev/null || echo '(unknown)')
  printf '\n'
  printf '  ===========================================================\n'
  printf '  ABOUT TO DEPLOY TO PRODUCTION\n'
  printf '  ===========================================================\n'
  printf '  Branch:       %s\n' "$CURRENT_BRANCH"
  printf '  HEAD:         %s\n' "$CURRENT_HEAD"
  printf '  Compose file: %s\n' "$COMPOSE_FILE"
  printf '  Env file:     %s\n' "$ENV_FILE"
  printf '  ===========================================================\n'
  printf '\n'
  read -r -p "Type 'yes' to continue: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

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

step "Waiting for API to become healthy (via nginx)"
NGINX_HOST_PORT=$(grep -E '^NGINX_HOST_PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true)
NGINX_HOST_PORT=${NGINX_HOST_PORT:-80}

URL="http://127.0.0.1:${NGINX_HOST_PORT}/api/health/liveness"
for i in $(seq 1 30); do
  if curl -sf "$URL" >/dev/null; then
    printf '\n[OK] Production deploy succeeded. API healthy at %s\n' "$URL"
    exit 0
  fi
  sleep 2
done

printf '\n[FAIL] Health check did not pass within 60s.\n' >&2
printf '       Check logs:    docker compose -f %s logs --tail=200 api\n' "$COMPOSE_FILE" >&2
printf '       Investigate before deciding whether to roll back via git checkout + redeploy.\n' >&2
exit 1
