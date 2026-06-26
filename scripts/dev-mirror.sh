#!/usr/bin/env bash
#
# dev-mirror.sh — run `npm run dev` from a real-disk mirror of the iCloud checkout.
#
# WHY: the canonical working copy stays in iCloud (for backup), but `next dev`
# is unusable there — Turbopack HMR never fires under com~apple~CloudDocs and
# cold compiles hang on iCloud-evicted module files. This syncs the source to a
# throwaway real-disk mirror and runs the dev server there, where HMR and
# compiles are instant.
#
# IMPORTANT — the mirror is a RUN environment, not a second source of truth:
#   • Edits you make in iCloud do NOT hot-reload here until you re-sync
#     (just re-run this script — the rsync is fast).
#   • If you edit inside the mirror, commit/push from the mirror so the work
#     reaches git; the iCloud copy will catch up on the next `git pull` there.
#   • git/GitHub remains the source of truth either way.
#
# USAGE:
#   bash scripts/dev-mirror.sh                 # sync + npm run dev
#   MIRROR=~/code/twv-dev bash scripts/dev-mirror.sh
#   bash scripts/dev-mirror.sh build           # run any npm script instead of dev

set -euo pipefail

SRC="$(git rev-parse --show-toplevel)"
MIRROR="${MIRROR:-$HOME/Projects/twv-crm-mirror}"
NPM_SCRIPT="${1:-dev}"

echo "→ Source: $SRC"
echo "→ Mirror: $MIRROR"
mkdir -p "$MIRROR"

# Sync source → mirror. Skip the heavy, regenerable, or non-portable dirs.
# .env.local is gitignored but rsync copies it (not excluded) so dev has its env.
rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude '.next/' \
  --exclude '.turbo/' \
  --exclude '.git/' \
  "$SRC/" "$MIRROR/"

cd "$MIRROR"

# Install deps only when the lockfile changed (keeps repeat runs fast).
if [ ! -d node_modules ] || ! cmp -s package-lock.json node_modules/.package-lock.json 2>/dev/null; then
  echo "→ Dependencies out of date — running npm ci…"
  npm ci
else
  echo "→ Dependencies up to date — skipping install."
fi

echo "→ npm run $NPM_SCRIPT  (in $MIRROR)"
exec npm run "$NPM_SCRIPT"
