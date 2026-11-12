# Contributing to TWV CRM

Welcome. This repo is set up so you can develop and test freely, but every
change to production goes through a pull request that **Vinit reviews and
merges**. Nothing you push reaches the live site by itself.

## 1. One-time setup

1. **Get repo access.** Vinit invites your GitHub account as a collaborator
   with **Write** access. Accept the invite email from GitHub.
2. **Install the GitHub CLI** (recommended, not required): https://cli.github.com
   ```bash
   gh auth login
   ```
3. **Clone the repo:**
   ```bash
   git clone https://github.com/vinit2776/TWVCRM.git
   cd TWVCRM
   npm install
   ```
4. **Get environment variables.** Ask Vinit for `.env.local` (Supabase URL/keys,
   etc. — see `.env.example` for the full list). Never commit this file.
5. **Confirm the dev server runs:**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000.

## 2. Everyday workflow

```bash
git checkout main
git pull
git checkout -b feat/<short-description>   # or fix/, chore/, refactor/, docs/
```

- Make your changes.
- Test locally end-to-end in the browser — run the actual flow, not just the
  changed function.
- Before committing:
  ```bash
  npm run lint     # must pass clean
  npm run build    # must compile with 0 TypeScript errors
  npm test         # Vitest, for lib/business-logic changes
  ```
- Commit using [Conventional Commits](https://www.conventionalcommits.org/):
  `feat: ...`, `fix: ...`, `chore: ...`, `refactor: ...`, `docs: ...`
- Push your branch and open a PR against `main`:
  ```bash
  git push -u origin feat/<short-description>
  gh pr create
  ```

## 3. What happens after you open a PR

- GitHub Actions CI runs automatically (lint, tests, build, and a migration
  number-collision check). It must pass before the PR can merge.
- Vinit reviews the diff and clicks through the Vercel preview link for
  anything UI-facing.
- **Only Vinit can approve and merge into `main`.** You cannot merge your own
  PR, and CI passing alone does not unlock the merge button — his review is
  required.
- If he asks for changes, push more commits to the same branch — the PR
  updates automatically.

## 4. Hard rules

- **Never push directly to `main`** — it's blocked at the repo level, so this
  will simply fail; always go through a branch + PR.
- **Never commit secrets** — no `.env` files, API keys, or Supabase service
  role keys. Use `.env.example` to document new variables you introduce.
- **Never edit the database schema directly** in the Supabase dashboard.
  Schema changes go through a migration file in `supabase/migrations/`
  (`NNNNN_description.sql`). Run
  `node .github/scripts/check-migration-numbers.mjs` locally before pushing —
  migration numbers collide silently across branches otherwise.
- **Keep PRs small and focused.** Don't refactor unrelated code in a feature
  PR — open a separate PR for that.
- **If your task's scope grows** beyond what was originally asked, stop and
  flag it in the PR or ask Vinit before continuing.
- If a change touches auth, payments, customer data, or a migration, flag it
  explicitly in the PR description — these get extra scrutiny.

## 5. Where things live

See [CLAUDE.md](CLAUDE.md) for the full architecture map, business rules,
role/permission table, and module layout — it's the canonical reference for
how this codebase is organized.
