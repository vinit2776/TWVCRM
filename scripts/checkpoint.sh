#!/usr/bin/env bash
#
# checkpoint.sh — create a dated, restorable snapshot BEFORE you start changing
# things, and check you're in sync with the git remote.
#
# WHY: the working copy lives in iCloud Drive, which can silently produce
# conflict copies and serve stale state. Run this at the start of a work session
# so there is always a timestamped point you can roll back to — an extra safety
# layer on top of iCloud and normal commits.
#
# WHAT it does (none of it touches your working files or current branch state):
#   1. git fetch + report how far ahead/behind the remote you are.
#   2. Snapshot the ENTIRE working copy as it is right now — including
#      uncommitted edits and new untracked files (gitignored files like
#      .env.local are excluded) — into a local tag `checkpoint/<timestamp>`.
#   3. Keep the most recent 20 checkpoints, prune older ones.
#
# USAGE:
#   bash scripts/checkpoint.sh           # local dated snapshot + sync check
#   PUSH=1 bash scripts/checkpoint.sh    # ALSO push the snapshot tag to origin
#                                        # (off-machine dated backup on GitHub)
#
# RESTORE LATER:
#   git tag --list 'checkpoint/*'                  # list snapshots
#   git diff checkpoint/<timestamp>                # what changed since
#   git checkout checkpoint/<timestamp> -- <path>  # restore one file
#   git checkout checkpoint/<timestamp> -- .       # restore everything (careful)

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

TS="$(date +%Y%m%d-%H%M%S)"
TAG="checkpoint/$TS"

# 1. Sync check against the upstream branch (best-effort; ok if offline).
echo "→ Fetching from origin…"
if git fetch --quiet origin 2>/dev/null; then
  UP="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ -n "$UP" ]; then
    AHEAD="$(git rev-list --count "$UP"..HEAD 2>/dev/null || echo 0)"
    BEHIND="$(git rev-list --count HEAD.."$UP" 2>/dev/null || echo 0)"
    echo "  vs $UP — $AHEAD ahead, $BEHIND behind"
    if [ "$BEHIND" -gt 0 ]; then
      echo "  ⚠️  You are $BEHIND commit(s) behind. Consider: git pull --ff-only $UP" >&2
    fi
  else
    echo "  (current branch has no upstream — skipping ahead/behind check)"
  fi
else
  echo "  (fetch failed — offline? continuing with a local snapshot)"
fi

# 2. Snapshot the full working tree into a tag, without disturbing index/worktree.
#    Build the tree in a throwaway index so staged/unstaged state is untouched.
TMP_INDEX="$(mktemp -t twv-checkpoint-index.XXXXXX)"
trap 'rm -f "$TMP_INDEX"' EXIT
GIT_INDEX_FILE="$TMP_INDEX" git read-tree HEAD
GIT_INDEX_FILE="$TMP_INDEX" git add -A          # respects .gitignore (no .env.local)
TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)"
COMMIT="$(git commit-tree "$TREE" -p HEAD -m "checkpoint $TS — auto restore point")"
git tag -f "$TAG" "$COMMIT" >/dev/null
echo "→ Snapshot saved: $TAG"

# 3. Optionally push the snapshot off-machine.
if [ "${PUSH:-0}" = "1" ]; then
  echo "→ Pushing $TAG to origin…"
  git push --force origin "$TAG"
  echo "  backed up to GitHub."
fi

# 4. Keep the 20 newest checkpoints locally, prune the rest.
#    (portable to macOS bash 3.2 / BSD head — no mapfile, no negative head -n)
ALL_TAGS="$(git tag --list 'checkpoint/*' | sort)"
TOTAL="$(printf '%s\n' "$ALL_TAGS" | grep -c . || true)"
if [ "$TOTAL" -gt 20 ]; then
  N=$((TOTAL - 20))
  printf '%s\n' "$ALL_TAGS" | head -n "$N" | while read -r t; do
    [ -n "$t" ] && git tag -d "$t" >/dev/null
  done
  echo "→ Pruned $N old checkpoint(s), kept the newest 20."
fi

echo ""
echo "✅ Safe to start changes. Restore anytime with:"
echo "     git diff $TAG"
echo "     git checkout $TAG -- <path>"
