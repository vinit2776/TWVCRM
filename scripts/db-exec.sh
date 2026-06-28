#!/usr/bin/env bash
#
# db-exec.sh — apply SQL to the Supabase Postgres as the OWNER role (postgres),
# straight from the CLI. No browser SQL editor needed.
#
# Reads the connection from .env.local (gitignored — never commit secrets):
#   SUPABASE_DB_URL=postgresql://...        (preferred, if set)
#   — or —
#   SUPABASE_DB_PASSWORD=<postgres password> (host/port/ref inferred)
#
# Usage:
#   scripts/db-exec.sh supabase/migrations/00308_whatever.sql   # apply a file
#   scripts/db-exec.sh -c "select version();"                   # inline SQL
#   scripts/db-exec.sh                                          # interactive psql
#
set -euo pipefail
cd "$(dirname "$0")/.."

ENVF=".env.local"
val() {
  # `|| true` keeps a no-match grep from tripping `set -e`.
  local v
  v="$(grep -m1 "^$1=" "$ENVF" 2>/dev/null | cut -d= -f2- \
    | sed -E 's/\\r//g; s/\\n//g; s/[[:space:]]*$//; s/^["'\'']//; s/["'\'']$//')" || true
  printf '%s' "$v"
}

REF="${SUPABASE_PROJECT_REF:-zlbvadtajetylacxevsm}"
HOST="$(val BACKUP_DB_HOST)"; HOST="${HOST:-aws-1-ap-south-1.pooler.supabase.com}"
PORT="$(val BACKUP_DB_PORT)"; PORT="${PORT:-5432}"

# If first arg is an existing file, apply it with -f; otherwise pass args through.
ARGS=("$@")
if [ "${1:-}" != "" ] && [ -f "${1:-}" ]; then ARGS=(-f "$1"); fi

URL="$(val SUPABASE_DB_URL)"
if [ -n "$URL" ]; then
  exec psql "$URL" -v ON_ERROR_STOP=1 "${ARGS[@]}"
fi

PW="$(val SUPABASE_DB_PASSWORD)"
if [ -z "$PW" ]; then
  echo "ERROR: add SUPABASE_DB_PASSWORD=<postgres password> (or SUPABASE_DB_URL=...) to .env.local" >&2
  echo "       Get it from Supabase Dashboard -> Project Settings -> Database." >&2
  exit 1
fi

export PGPASSWORD="$PW" PGSSLMODE=require
exec psql -h "$HOST" -p "$PORT" -U "postgres.$REF" -d postgres -v ON_ERROR_STOP=1 "${ARGS[@]}"
