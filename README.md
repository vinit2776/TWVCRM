# TWV CRM

Internal operations platform for **The WorkVilla** coworking space — leads → proposals → contracts → billing → facility management → procurement → accounting.

Built with Next.js 16 (App Router), React 19, TypeScript, Supabase, and Tailwind. Deployed on Vercel (auto-deploys from `origin/main`).

**Production:** https://twv-crm.vercel.app

See [`CLAUDE.md`](./CLAUDE.md) for architecture, business rules, and contribution conventions.

---

## Working in iCloud Drive (canonical) — safely

This repo lives in iCloud Drive
(`~/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM`), kept there
deliberately as an extra backup layer. That's fine for editing, `git`, and
`npm run build` — but iCloud breaks the long-running dev server, and it
occasionally creates conflict-copy files. Three helper scripts make this safe.

### 1. Checkpoint before you start changing things

iCloud can serve stale state and silently spawn conflict copies, so create a
dated, restorable snapshot at the start of each work session:

```bash
bash scripts/checkpoint.sh           # git fetch + dated snapshot tag
PUSH=1 bash scripts/checkpoint.sh    # also push the snapshot to GitHub (off-machine)
```

It checks how far ahead/behind `origin` you are, then snapshots the **entire
working copy** (including uncommitted edits and new untracked files; gitignored
files like `.env.local` are excluded) into a `checkpoint/<timestamp>` tag —
without touching your working tree. Restore anytime:

```bash
git tag --list 'checkpoint/*'                  # list snapshots
git diff checkpoint/<timestamp>                # see what changed since
git checkout checkpoint/<timestamp> -- <path>  # restore a file
```

### 2. Run the dev server from a real-disk mirror

**Never run `npm run dev` directly from the iCloud path** — Turbopack HMR never
fires under `com~apple~CloudDocs` (so it serves stale code), and cold compiles
hang for minutes on iCloud-evicted module files. Instead, run from a fast
real-disk mirror:

```bash
bash scripts/dev-mirror.sh           # rsync source → ~/Projects/twv-crm-mirror, then npm run dev
```

The mirror is a throwaway **run** environment, not a second source of truth.
Edits in iCloud won't hot-reload there until you re-run the sync (it's fast); if
you edit inside the mirror, commit/push from there so the work reaches git.
`npm run build` and `git` are unaffected by iCloud, so run those normally from
the iCloud checkout.

### 3. Clean up iCloud conflict copies

Editing in iCloud produces conflict duplicates like `00302_amenity_icons 2.sql`
or `booking-gst-task 2.ts`. Duplicate migration numbers break `supabase db push`
(and the pre-commit hook blocks commits while they exist):

```bash
DRY_RUN=1 bash scripts/clean-icloud-conflicts.sh   # report only
bash scripts/clean-icloud-conflicts.sh             # delete copies identical to canonical
```

It deletes a conflict copy **only** when it is byte-identical to its canonical
file; anything that differs is kept and flagged for you to resolve by hand.

---

## Getting Started

```bash
npm ci               # install exact dependencies
cp .env.example .env.local   # then fill in the values (see CLAUDE.md → Environment Variables)
npm run dev          # start dev server (http://localhost:3000)
```

## Commands

```bash
npm run dev          # Start dev server — DON'T run from iCloud; use scripts/dev-mirror.sh
npm run build        # Production build — CI runs this on every push to main (safe in iCloud)
npm run lint         # ESLint — must pass clean (0 errors) before merging

npx supabase db push # Apply pending migrations to the live Supabase project
```

There are no test suites — verify changes by running the dev server (via
`scripts/dev-mirror.sh`, see above) and testing in the browser. If it serves
stale code, you're almost certainly running `next dev` straight from iCloud —
use the mirror; otherwise clear the cache with `rm -rf .next` and restart.

## Migrations

SQL migrations live in `supabase/migrations/`, named `NNNNN_description.sql`
(sequential 5-digit prefix). A pre-commit hook blocks commits that introduce
duplicate migration numbers, which would cause `supabase db push` to silently
skip a migration.

> **iCloud conflict copies:** editing in iCloud can produce conflict duplicates
> like `00302_… 2.sql` or `foo 2.ts`. These duplicate migration numbers and break
> `supabase db push`. Run `bash scripts/clean-icloud-conflicts.sh` to remove the
> ones identical to their canonical file (see the iCloud section above).
