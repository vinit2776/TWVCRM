#!/usr/bin/env bash
#
# setup-local-dev.sh — copy the project out of iCloud onto a normal folder so the
# dev server works. Run this ONCE. After that, work in ~/Projects/twv-crm.
#
# Why: running `npm run dev` from iCloud Drive is broken — the live-reload never
# fires (you see stale code) and the first compile can hang for minutes. iCloud
# isn't a backup for the code anyway; GitHub already keeps every version.
#
# Usage:  bash scripts/setup-local-dev.sh

set -euo pipefail

TARGET="$HOME/Projects/twv-crm"
SRC="$(git rev-parse --show-toplevel)"

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "❌ $TARGET already exists and isn't empty."
  echo "   If it's an old copy you don't need, delete it and re-run."
  exit 1
fi

echo "Copying the project to $TARGET (this takes a minute)…"
mkdir -p "$TARGET"
rsync -a \
  --exclude 'node_modules/' \
  --exclude '.next/' \
  --exclude '.turbo/' \
  "$SRC/" "$TARGET/"

echo "Installing dependencies…"
( cd "$TARGET" && npm ci )

echo ""
echo "✅ Done. From now on, work here — not in iCloud:"
echo ""
echo "    cd $TARGET"
echo "    npm run dev"
echo ""
echo "Your .env.local was copied over. GitHub remains your backup."
