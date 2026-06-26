#!/usr/bin/env bash
#
# setup-local-dev.sh — move the working copy off iCloud Drive onto real disk.
#
# WHY: Running `next dev` from the iCloud path
#   (~/Library/Mobile Documents/com~apple~CloudDocs/...) is broken in two ways:
#     1. File-watching (FSEvents) is unreliable under com~apple~CloudDocs, so
#        Turbopack HMR never sees source edits and serves stale code.
#     2. iCloud "Optimize Mac Storage" evicts files to dataless stubs; a cold
#        Turbopack compile reads thousands of module files and blocks for
#        minutes re-downloading them, often never finishing.
#   GitHub (origin) is the real source of truth, so the code does not need to
#   live in iCloud at all.
#
# WHAT: rsync the current checkout to ~/Projects/twv-crm (real disk), excluding
#   the regenerable node_modules/.next, then `npm ci`. Your .env.local (which is
#   gitignored, not committed) is carried over automatically.
#
# USAGE:
#   bash scripts/setup-local-dev.sh            # default target ~/Projects/twv-crm
#   TARGET=~/code/twv-crm bash scripts/setup-local-dev.sh
#   FORCE=1 bash scripts/setup-local-dev.sh    # overwrite a non-empty target
#
# After it finishes, do ALL local dev in the target directory.

set -euo pipefail

TARGET="${TARGET:-$HOME/Projects/twv-crm}"

# Resolve the source repo root. Refuse to run from a Claude Code worktree —
# we want the real main checkout, not a throwaway worktree.
SRC="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$SRC" ]; then
  echo "❌ Not inside a git repository. Run this from the TWV CRM checkout." >&2
  exit 1
fi
case "$SRC" in
  */.claude/worktrees/*)
    echo "❌ You are inside a git worktree:" >&2
    echo "     $SRC" >&2
    echo "   Run this from the main iCloud checkout instead." >&2
    exit 1
    ;;
esac

case "$SRC" in
  *com~apple~CloudDocs*) : ;;  # expected: migrating off iCloud
  *)
    echo "ℹ️  Source is already off iCloud ($SRC). Nothing to migrate."
    echo "   If you just want a second working copy, set FORCE=1 to proceed."
    [ "${FORCE:-0}" = "1" ] || exit 0
    ;;
esac

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "❌ Target already exists and is not empty: $TARGET" >&2
  echo "   Re-run with FORCE=1 to overwrite, or set a different TARGET." >&2
  exit 1
fi

echo "→ Source: $SRC"
echo "→ Target: $TARGET"
mkdir -p "$TARGET"

# rsync everything (including .git and the gitignored .env.local) EXCEPT the
# regenerable, slow-to-copy directories. --delete keeps re-runs clean.
rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude '.next/' \
  --exclude '.turbo/' \
  "$SRC/" "$TARGET/"

echo "→ Installing dependencies (npm ci)…"
( cd "$TARGET" && npm ci )

echo ""
echo "✅ Done. Real-disk working copy ready at:"
echo "     $TARGET"
echo ""
echo "Next steps:"
echo "  cd $TARGET"
echo "  npm run dev        # HMR + compiles are now instant"
echo ""
echo "From now on, do local dev here. The iCloud copy can be archived once you"
echo "confirm this one builds and runs (git/GitHub remains the source of truth)."
