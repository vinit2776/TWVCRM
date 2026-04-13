#!/usr/bin/env bash
# =============================================================================
# TWV CRM — Nightly Supabase Storage backup to Backblaze B2
# Uses Supabase REST API (service role) to list + download objects
# Buckets: crm-documents, vendor-invoices
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/.backup.env"

TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
LOCAL_STAGING="/tmp/twvcrm-storage-${TIMESTAMP}"
mkdir -p "$LOCAL_STAGING"
RCLONE_CONF="$SCRIPT_DIR/rclone.conf"
B2_PATH="b2-twvcrm:twvcrmbackups/storage"

SUPABASE_URL="$SUPABASE_PROJECT_URL"
SERVICE_KEY="$SUPABASE_SERVICE_ROLE_KEY"

echo "[$(date)] Starting storage backup..."

download_bucket() {
  local BUCKET="$1"
  local DEST="$LOCAL_STAGING/$BUCKET"
  mkdir -p "$DEST"

  echo "[$(date)]   Listing $BUCKET..."

  # List all objects in the bucket
  OBJECTS=$(curl -s -X POST \
    "${SUPABASE_URL}/storage/v1/object/list/${BUCKET}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"prefix": "", "limit": 10000, "offset": 0}' \
    | python3 -c "import json,sys; objs=json.load(sys.stdin); [print(o['name']) for o in objs if o.get('name') and not o['name'].endswith('/')]" 2>/dev/null)

  COUNT=0
  while IFS= read -r OBJ; do
    [ -z "$OBJ" ] && continue
    mkdir -p "$DEST/$(dirname "$OBJ")"
    HTTP_STATUS=$(curl -s -o "$DEST/$OBJ" -w "%{http_code}" \
      "${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${OBJ}" \
      -H "Authorization: Bearer ${SERVICE_KEY}")
    if [ "$HTTP_STATUS" = "200" ]; then
      COUNT=$((COUNT + 1))
    fi
  done <<< "$OBJECTS"

  echo "[$(date)]   Downloaded $COUNT files from $BUCKET"
}

download_bucket "crm-documents"
download_bucket "vendor-invoices"

TOTAL=$(find "$LOCAL_STAGING" -type f | wc -l | tr -d ' ')
echo "[$(date)] Total files downloaded: $TOTAL"

# Sync to Backblaze B2
rclone sync "$LOCAL_STAGING" "${B2_PATH}/" \
  --config "$RCLONE_CONF" \
  --transfers 4 \
  --stats-one-line

echo "[$(date)] Synced to B2"

# Cleanup
rm -rf "$LOCAL_STAGING"

echo "[$(date)] Storage backup complete ✓ ($TOTAL files)"
