#!/usr/bin/env bash
#
# clean-icloud-conflicts.sh — find and remove iCloud conflict copies.
#
# WHY: editing in iCloud Drive produces conflict duplicates like
# `00302_amenity_icons 2.sql` or `booking-gst-task 2.ts`. Duplicate migration
# numbers break `supabase db push` (and the pre-commit hook blocks commits while
# they exist). This finds every "<name> <N>.<ext>" copy and deletes it ONLY when
# it is byte-identical to its canonical file; anything that differs is left in
# place and reported for you to resolve by hand.
#
# USAGE:
#   bash scripts/clean-icloud-conflicts.sh          # delete identical copies
#   DRY_RUN=1 bash scripts/clean-icloud-conflicts.sh # just report, delete nothing

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

deleted=0 kept=0 found=0

# Match "<something> <digits>.<ext>" basenames (iCloud's conflict-copy pattern).
while IFS= read -r -d '' f; do
  found=$((found + 1))
  name="$(basename "$f")"
  dir="$(dirname "$f")"

  # Derive the canonical name: strip the " <N>" that precedes the extension.
  if [[ "$name" =~ ^(.*)\ [0-9]+(\.[^.]+)$ ]]; then
    canonical="$dir/${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
  else
    echo "?? KEPT (unrecognized pattern): $f"; kept=$((kept + 1)); continue
  fi

  if [ ! -f "$canonical" ]; then
    echo "?? KEPT (no canonical file '$canonical'): $f"; kept=$((kept + 1)); continue
  fi

  if cmp -s "$f" "$canonical"; then
    if [ "${DRY_RUN:-0}" = "1" ]; then
      echo "✓ would delete (identical to canonical): $f"
    else
      rm -- "$f"; echo "✓ deleted (identical to canonical): $f"
    fi
    deleted=$((deleted + 1))
  else
    echo "⚠️  KEPT (DIFFERS from '$canonical' — resolve manually): $f"; kept=$((kept + 1))
  fi
# Glob '* [0-9].*' (portable to both BSD and GNU find) matches iCloud's
# conflict-copy basename pattern "<name> <digit>.<ext>".
done < <(find . \
  -not -path './node_modules/*' -not -path './.git/*' \
  -name '* [0-9].*' -print0)

echo ""
if [ "$found" -eq 0 ]; then
  echo "✅ No iCloud conflict copies found — clean."
else
  echo "Summary: $found found, $deleted removed${DRY_RUN:+ (dry run)}, $kept kept for review."
fi
