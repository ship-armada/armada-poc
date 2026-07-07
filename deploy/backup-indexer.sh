#!/usr/bin/env bash
# ABOUTME: Nightly backup for the crowdfund indexer — tarball of the file-store/snapshot
# ABOUTME: volume plus a pg_dump when Postgres is running, with local retention pruning.
set -euo pipefail

# Run this from the ops dir that holds docker-compose.yml + .env (where you deployed).
# Cron example (daily 03:15 UTC):
#   15 3 * * *  cd /opt/armada-infra && ./backup-indexer.sh >> backup.log 2>&1
#
# Tunables (env vars, all optional):
#   COMPOSE_PROJECT_NAME  docker compose project name / volume prefix (default: crowdfund-indexer)
#   BACKUP_DIR            where backups are written (default: ./backups)
#   RETENTION_DAYS        prune local backups older than this many days (default: 14)
#   BACKUP_REMOTE_CMD     optional off-host copy command; receives the file path as $1
#                         (see step 3). A backup on the same VPS does NOT survive VPS loss.

PROJECT="${COMPOSE_PROJECT_NAME:-crowdfund-indexer}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DATA_VOLUME="${PROJECT}_indexer-data"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
BACKUP_ABS="$(cd "$BACKUP_DIR" && pwd)"

echo "[backup] $STAMP  project=$PROJECT  dir=$BACKUP_ABS  retention=${RETENTION_DAYS}d"

# 1. File-store + snapshots + alert dedupe volume -> tar.gz.
#    Mounted read-only so a backup can never mutate live data.
data_out="$BACKUP_ABS/indexer-data-$STAMP.tar.gz"
docker run --rm \
  -v "${DATA_VOLUME}:/data:ro" \
  -v "${BACKUP_ABS}:/backup" \
  alpine:3 tar czf "/backup/$(basename "$data_out")" -C /data .
echo "[backup] wrote $data_out ($(du -h "$data_out" | cut -f1))"

# 2. Postgres dump — only when the postgres service is up (file-store deploys skip this).
#    pg_dump runs inside the container, so POSTGRES_USER/DB come from the container env
#    and no database credentials are handled by this script.
pg_out=""
if docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  pg_out="$BACKUP_ABS/postgres-$STAMP.sql.gz"
  docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$pg_out"
  echo "[backup] wrote $pg_out ($(du -h "$pg_out" | cut -f1))"
else
  echo "[backup] postgres service not running — file store only, skipping pg_dump"
fi

# 3. Optional off-host copy. A backup on the same box does not survive host loss.
#    Set BACKUP_REMOTE_CMD to push each fresh file off-box; it receives the path as $1.
#    Example:  export BACKUP_REMOTE_CMD='rclone copy "$1" r2:armada-indexer-backups'
if [ -n "${BACKUP_REMOTE_CMD:-}" ]; then
  for f in "$data_out" "$pg_out"; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    echo "[backup] off-host copy: $f"
    sh -c "$BACKUP_REMOTE_CMD" _ "$f"
  done
fi

# 4. Prune local backups older than the retention window.
find "$BACKUP_ABS" -maxdepth 1 -type f \
  \( -name 'indexer-data-*.tar.gz' -o -name 'postgres-*.sql.gz' \) \
  -mtime "+$RETENTION_DAYS" -print -delete | sed 's/^/[backup] pruned /' || true

echo "[backup] done"
