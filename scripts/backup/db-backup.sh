#!/usr/bin/env bash
# =============================================================================
# TWV CRM — Daily PostgreSQL backup to Backblaze B2
# Uses a dedicated read-only backup_user (BYPASSRLS) via Supabase pooler
# Dumps schema + data for all public tables → gzip → B2
# Retention: 7 days
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/.backup.env"

DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
BACKUP_FILE="/tmp/twvcrm-db-${TIMESTAMP}.sql.gz"
RCLONE_CONF="$SCRIPT_DIR/rclone.conf"
B2_PATH="b2-twvcrm:twvcrmbackups/db"

echo "[$(date)] Starting DB backup..."

export PGHOST="$SUPABASE_DB_HOST"
export PGPORT="$SUPABASE_DB_PORT"
export PGUSER="$SUPABASE_DB_USER"
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
export PGDATABASE="$SUPABASE_DB_NAME"

# Dump schema + data for public schema, compress
pg_dump \
  --no-owner \
  --no-acl \
  --schema=public \
  | gzip > "$BACKUP_FILE"

SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "[$(date)] Dump complete — $SIZE"

# Upload to Backblaze B2
rclone copy "$BACKUP_FILE" "${B2_PATH}/${DATE}/" \
  --config "$RCLONE_CONF" \
  --stats-one-line
echo "[$(date)] Uploaded → B2: db/${DATE}/twvcrm-db-${TIMESTAMP}.sql.gz"

# Cleanup local temp
rm -f "$BACKUP_FILE"

# Prune backups older than 7 days
rclone delete "${B2_PATH}/" \
  --config "$RCLONE_CONF" \
  --min-age 7d \
  --rmdirs 2>/dev/null || true
echo "[$(date)] Pruned files older than 7 days"

echo "[$(date)] DB backup complete ✓"
