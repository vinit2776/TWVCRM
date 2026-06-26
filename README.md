# TWV CRM

Internal operations platform for **The WorkVilla** coworking space — leads → proposals → contracts → billing → facility management → procurement → accounting.

Built with Next.js 16 (App Router), React 19, TypeScript, Supabase, and Tailwind. Deployed on Vercel (auto-deploys from `origin/main`).

**Production:** https://twv-crm.vercel.app

See [`CLAUDE.md`](./CLAUDE.md) for architecture, business rules, and contribution conventions.

---

## ⚠️ Don't run the dev server from iCloud

This repo is currently in iCloud Drive. Running `npm run dev` from there is
broken — live-reload never fires (you see stale code) and the first compile can
hang for minutes. Your code is already backed up on GitHub (every version), so
the simplest fix is to keep the project in a normal folder.

**Do this once:**

```bash
bash scripts/setup-local-dev.sh
```

It copies the project to `~/Projects/twv-crm` (bringing your `.env.local`) and
installs dependencies. After that, always work there:

```bash
cd ~/Projects/twv-crm
npm run dev
```

That's it — editing, `npm run dev`, and `git` all work normally from
`~/Projects/twv-crm`. You can delete the iCloud copy once you've confirmed the
new one runs.

---

## Getting Started

```bash
npm ci               # install exact dependencies
cp .env.example .env.local   # then fill in the values (see CLAUDE.md → Environment Variables)
npm run dev          # start dev server (http://localhost:3000)
```

## Commands

```bash
npm run dev          # Start dev server (run from ~/Projects/twv-crm, not iCloud — see above)
npm run build        # Production build — CI runs this on every push to main
npm run lint         # ESLint — must pass clean (0 errors) before merging

npx supabase db push # Apply pending migrations to the live Supabase project
```

There are no test suites — verify changes by running the dev server and testing
in the browser. If the dev server serves stale code, you're almost certainly
running it from iCloud (see above); otherwise clear the cache with `rm -rf .next`
and restart.

## Migrations

SQL migrations live in `supabase/migrations/`, named `NNNNN_description.sql`
(sequential 5-digit prefix). A pre-commit hook blocks commits that introduce
duplicate migration numbers, which would cause `supabase db push` to silently
skip a migration.

> **iCloud conflict copies:** editing in iCloud can produce conflict duplicates
> like `00302_… 2.sql` or `foo 2.ts` that duplicate migration numbers and break
> `supabase db push`. Working from `~/Projects/twv-crm` (above) avoids them; to
> find any leftovers: `find . -name '* [0-9].*' -not -path './node_modules/*'`.
