#!/usr/bin/env bash
# Daily Postgres dump → ./backups/ next to this script, gzipped, retained
# for 14 days. Lives at /srv/${SERVICE_NAME}/backup.sh on the server.
# Run from cron:
#   0 3 * * * /srv/<service>/backup.sh >> /srv/<service>/backups/backup.log 2>&1
#
# Restore example:
#   gunzip -c backups/2026-04-27.sql.gz | \
#     docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME"

set -euo pipefail

# Resolve the project dir from the script's own location so this stays
# generic — no hard-coded /srv/<service> path to edit per project.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env so we have DB_USER / DB_NAME without hard-coding them.
set -a
# shellcheck disable=SC1091
source .env
set +a

mkdir -p backups
TIMESTAMP=$(date +%F)   # YYYY-MM-DD; one file per day, overwrites if re-run
OUTFILE="backups/${TIMESTAMP}.sql.gz"

# pg_dump runs inside the postgres container so we don't need a host-side
# postgres-client install. -Fc would be smaller but plain SQL is easier
# to inspect / partial-restore from, and gzip closes most of the gap.
docker compose exec -T postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
  | gzip -9 > "$OUTFILE"

# Atomic-ish: only consider the backup successful if the file is non-empty.
if [ ! -s "$OUTFILE" ]; then
  echo "[$(date -Iseconds)] ERROR: backup file is empty, removing" >&2
  rm -f "$OUTFILE"
  exit 1
fi

echo "[$(date -Iseconds)] OK: $OUTFILE ($(du -h "$OUTFILE" | cut -f1))"

# Retention: drop dumps older than 14 days.
find backups -maxdepth 1 -name '*.sql.gz' -mtime +14 -delete
