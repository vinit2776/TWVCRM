#!/usr/bin/env bash
# =============================================================================
# TWV CRM — One-time backup setup script
# Run this once after filling in .backup.env
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== TWV CRM Backup Setup ==="

# Validate env file exists
if [ ! -f "$SCRIPT_DIR/.backup.env" ]; then
  echo "ERROR: .backup.env not found. Copy .backup.env.example and fill it in."
  exit 1
fi

source "$SCRIPT_DIR/.backup.env"

# Validate required vars
REQUIRED_VARS=(
  "B2_KEY_ID" "B2_APPLICATION_KEY"
  "SUPABASE_DB_HOST" "SUPABASE_DB_PASSWORD"
  "SUPABASE_STORAGE_KEY_ID" "SUPABASE_STORAGE_SECRET" "SUPABASE_STORAGE_ENDPOINT"
)
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set in .backup.env"
    exit 1
  fi
done

# Write rclone config
cat > "$SCRIPT_DIR/rclone.conf" <<EOF
[b2-twvcrm]
type = b2
account = ${B2_KEY_ID}
key = ${B2_APPLICATION_KEY}
EOF

echo "✓ rclone config written"

# Test B2 connection
echo "Testing Backblaze B2 connection..."
rclone lsd "b2-twvcrm:twvcrmbackups" --config "$SCRIPT_DIR/rclone.conf" && echo "✓ B2 connection successful"

# Test DB connection
echo "Testing database connection..."
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql \
  -h "$SUPABASE_DB_HOST" \
  -p "$SUPABASE_DB_PORT" \
  -U "$SUPABASE_DB_USER" \
  -d "$SUPABASE_DB_NAME" \
  -c "SELECT version();" -q && echo "✓ Database connection successful"

# Make scripts executable
chmod +x "$SCRIPT_DIR/db-backup.sh"
chmod +x "$SCRIPT_DIR/storage-backup.sh"

# Install launchd jobs (macOS scheduler — runs even after reboot)
PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"

# DB backup — daily at 2:00 AM
cat > "$PLIST_DIR/com.twvcrm.db-backup.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.twvcrm.db-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT_DIR}/db-backup.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${SCRIPT_DIR}/logs/db-backup.log</string>
  <key>StandardErrorPath</key>
  <string>${SCRIPT_DIR}/logs/db-backup-error.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

# Storage backup — daily at 3:00 AM
cat > "$PLIST_DIR/com.twvcrm.storage-backup.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.twvcrm.storage-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT_DIR}/storage-backup.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${SCRIPT_DIR}/logs/storage-backup.log</string>
  <key>StandardErrorPath</key>
  <string>${SCRIPT_DIR}/logs/storage-backup-error.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

mkdir -p "$SCRIPT_DIR/logs"

# Load launchd jobs
launchctl load "$PLIST_DIR/com.twvcrm.db-backup.plist" 2>/dev/null || true
launchctl load "$PLIST_DIR/com.twvcrm.storage-backup.plist" 2>/dev/null || true

echo ""
echo "=== Setup Complete ==="
echo "✓ DB backup scheduled daily at 2:00 AM"
echo "✓ Storage backup scheduled daily at 3:00 AM"
echo "✓ Logs at: $SCRIPT_DIR/logs/"
echo ""
echo "To run a manual test backup now:"
echo "  bash $SCRIPT_DIR/db-backup.sh"
echo "  bash $SCRIPT_DIR/storage-backup.sh"
