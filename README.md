# TWV CRM

Internal operations platform for **The WorkVilla** coworking space — leads → proposals → contracts → billing → facility management → procurement → accounting.

Built with Next.js 16 (App Router), React 19, TypeScript, Supabase, and Tailwind. Deployed on Vercel (auto-deploys from `origin/main`).

**Production:** https://twv-crm.vercel.app

See [`CLAUDE.md`](./CLAUDE.md) for architecture, business rules, and contribution conventions.

---

## ⚠️ Do not run local dev from iCloud Drive

This repo currently lives in iCloud Drive
(`~/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM`). **Never run
`npm run dev` from that path.** Next.js 16 / Turbopack breaks badly under iCloud:

- **File-watching doesn't fire.** FSEvents is unreliable under
  `com~apple~CloudDocs`, so HMR never picks up source edits and the dev server
  keeps serving stale, months-old code.
- **Cold compiles hang.** iCloud "Optimize Mac Storage" evicts files to dataless
  stubs. A cold Turbopack compile reads thousands of module files and blocks for
  minutes re-downloading them — often never finishing.

`npm run build` and `git`/CI are unaffected — only the long-running dev server is.

### The fix: keep the working copy on real disk

GitHub (`origin`) is the real source of truth, so the code does not need to live
in iCloud. **Recommended setup: clone/move the canonical working copy to
`~/Projects/twv-crm` and reserve iCloud for non-code documents only.**

One command, from the iCloud checkout:

```bash
bash scripts/setup-local-dev.sh
```

This rsyncs the checkout to `~/Projects/twv-crm` (excluding `node_modules`/`.next`),
carries over your gitignored `.env.local`, and runs `npm ci`. Then:

```bash
cd ~/Projects/twv-crm
npm run dev          # HMR + compiles are now instant
```

Once the new copy builds and runs, archive the iCloud copy. From then on, do all
local dev in `~/Projects/twv-crm`.

> Prefer a clean clone? `cd ~/Projects && git clone https://github.com/vinit2776/TWVCRM.git twv-crm`,
> then copy `.env.local` over and `npm ci`.

<details>
<summary>Fallback: keep iCloud canonical, run from a local mirror</summary>

Only if you must keep editing inside iCloud (e.g. multi-machine Finder access).
Maintain a real-disk run mirror and re-sync before each dev session — note this
two-copy model is exactly what causes stale-code confusion, so the move above is
strongly preferred:

```bash
rsync -a --delete --exclude node_modules --exclude .next \
  "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Projects/TWV CRM/" \
  "$HOME/Projects/twv-crm-local/"
cd ~/Projects/twv-crm-local && npm ci && npm run dev
```
</details>

---

## Getting Started

```bash
npm ci               # install exact dependencies
cp .env.example .env.local   # then fill in the values (see CLAUDE.md → Environment Variables)
npm run dev          # start dev server (http://localhost:3000)
```

## Commands

```bash
npm run dev          # Start dev server (Next.js 16, Turbopack)
npm run build        # Production build — CI runs this on every push to main
npm run lint         # ESLint — must pass clean (0 errors) before merging

npx supabase db push # Apply pending migrations to the live Supabase project
```

There are no test suites — verify changes by running the dev server and testing
in the browser. If the dev server serves stale code after edits, clear the cache:
`rm -rf .next` then restart (and confirm you are **not** running from iCloud — see above).

## Migrations

SQL migrations live in `supabase/migrations/`, named `NNNNN_description.sql`
(sequential 5-digit prefix). A pre-commit hook blocks commits that introduce
duplicate migration numbers, which would cause `supabase db push` to silently
skip a migration.

> **iCloud conflict copies:** editing in iCloud can produce conflict duplicates
> like `00302_… 2.sql` or `foo 2.ts`. These duplicate migration numbers and break
> `supabase db push`. Delete them once confirmed identical to the canonical file:
> ```bash
> find . -regextype posix-extended -regex '.* [0-9]\.[a-z]+$' \
>   -not -path './node_modules/*' -not -path './.git/*'
> ```
> Moving the working copy off iCloud (above) prevents them entirely.
