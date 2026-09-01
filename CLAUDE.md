# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TWV CRM is the internal operations platform for **The WorkVilla**, a coworking space business. It manages the full lifecycle: leads → proposals → contracts → billing → facility management → procurement → accounting.

**Production**: https://twv-crm.vercel.app (auto-deploys from `origin/main` via Vercel)

## Critical Rules — Read Before Every Task

### ALWAYS

- Ask clarifying questions before writing code if the request touches auth, payments, customer data, migrations, or third-party integrations.
- Sync with main and create a feature branch before starting: `git checkout main && git pull && git checkout -b feat/<short-description>`.
- If more than one Claude Code session may be working in this repo at the same time, each session must use its own `git worktree` (e.g. `git worktree add ../twv-crm-<slug> feat/<short-description>`) instead of checking out branches in the shared working directory. Two sessions sharing one working directory can interleave checkouts/commits on the same HEAD — this has already caused an in-progress uncommitted change to jump branches and land a commit directly on `main` by accident (see PR #355's investigation for the incident). Worktrees give each session an isolated working directory and index, so this can't happen.
- Match existing patterns in the codebase before introducing new ones. Check how similar features are built first.
- Test locally end-to-end before committing. Run the full flow, not just the changed function.
- Update documentation in the same PR if you change an API contract, env var, schema, or public function signature.
- Verify before assuming — if you're unsure a function exists, a file is at a path, or a pattern is used elsewhere, grep the codebase.

### NEVER

- **Never let a real customer be touched by testing, debugging, or verification — no exceptions.** No live customer may receive an email, SMS, invoice, payment link, or any other notification, and no real payment/charge may be triggered, as a side effect of you checking whether something works. This applies even when you are confident the call is "just a preview" or "just a dry run" — if you are not clicking the actual UI control, you do not have that guarantee. Concretely:
  - To verify a fix or investigate a bug, drive it through the real UI (click the actual button), or read the source code / query the database read-only. Do **not** hand-call a mutating or dispatching API route yourself (via script, curl, browser console, or a one-off fetch) to "check" its behavior, even one that looks like a preview endpoint.
  - If you must call an API directly for some reason, treat any endpoint that can generate, finalize, or dispatch a customer-facing statement, invoice, message, or payment as radioactive — read its full implementation first, and if there is any ambiguity about whether a given request body is safe, don't send it.
  - This is not hypothetical: on 2026-09-01, a hand-typed verification call to `/api/billing/auto-generate` used the wrong parameter name (`dryRun` instead of the actual `dry_run`), which silently defaulted to a live run and emailed 20 real customers unsolicited October rent proformas with live payment links, a month early. The fix was to invert the endpoint's default to fail-safe (see that route's code comments) — but the rule that should have prevented it in the first place is this one: never take the shortcut of scripting a call to a live-capable endpoint when a safe, already-tested UI control exists for the same check.
- Never commit secrets — no `.env` files, no API keys, no Supabase service role keys, no credentials in code or comments. Use `.env.example` for documenting required vars.
- Never push directly to `main` — all changes go through a PR.
- Never run destructive operations on production — no `DROP`, `TRUNCATE`, mass `DELETE`, or `supabase db reset` against prod.
- Never disable RLS on a table that contains user data. If RLS is blocking you, fix the policy — don't disable it.
- Never refactor unrelated code in a feature PR. Open a separate PR for refactors.
- Never use the Supabase service role key in client code — service role is server-only.
- Never log PII, passwords, tokens, or API keys even at debug level.
- Never re-enable `tally_sync_enabled` or build on `src/lib/tally/enqueue.ts` (the automated Tally bridge-sync) without an explicit request — see "Shelved features" below.

---

## Co-Developer Working Agreement

Established 2026-08-23. `main` has branch protection: no direct pushes, a required CI check, but no required PR review (GitHub blocks a solo account from approving its own PR, so that requirement was unsatisfiable and has been removed). This means **the merge click is the only approval gate that exists** — nothing else stops a PR from shipping.

**Vinit's role:**
- Describe bugs/features in plain English — no technical detail required.
- Review each PR before merging: read the diff/description, and click through the Vercel preview link for anything UI-facing.
- Either click **Merge** on GitHub directly, or explicitly tell Claude to merge it in that moment. Nothing reaches production until one of these happens.
- Flag anything that looks wrong immediately after a merge.

**Claude's role — in addition to the rules above:**
- Open every change as a PR describing what changed, why, and how it was tested.
- Merge only when explicitly asked to in that moment (e.g. "merge it") — never on Claude's own initiative, and never before CI and the Vercel preview have both been checked. Being asked once does not carry forward to later PRs; each merge needs its own explicit ask.
- Test every change before opening the PR: build, lint, and an actual browser click-through for UI-facing changes (see "Mandatory: Build → Deploy → Browser Verify" below).
- Stop and ask before continuing if a task's scope grows beyond what was originally asked.

If a second human developer joins the project, re-enable "require 1 approval" on `main` — it works correctly once PR author and approver are different accounts.

---

## Shelved Features — Do Not Resume Without Explicit Request

**Automated Tally bridge-sync** (`app_settings.tally_sync_enabled`, `src/lib/tally/enqueue.ts`,
`routeGstGenerationToTally`, `dispatchGstDirect`'s Tally routing, the Admin → Tally Sync page).
Shelved 2026-07-07 — superseded by the separate **Tally Inbox** manual-handoff workflow
(`tally_handoff_v2_enabled`, `/accounting/inbox`), which is unrelated, fully active, and has no
restriction or connection to the sync flag. `tally_sync_enabled` is currently `false` in
production; do not flip it back on or extend the bridge-sync code path unless the user
specifically asks for it. Full history: `docs/tally-integration-status.md`. The "Tally Sync"
sidebar entry is intentionally hidden (commented out in `sidebar.tsx`), not deleted.

---

## Mandatory: Build → Deploy → Browser Verify

**Every feature or bug fix must follow this sequence before declaring it done:**

1. `npm run build` — must compile with 0 TypeScript errors
2. Push the feature branch and open a PR — triggers CI (lint + build) and a Vercel preview deploy for that branch
3. Wait for CI to pass: `gh run watch <run-id> --exit-status --repo vinit2776/TWVCRM`
4. Reload the Vercel preview URL in the browser (Chrome MCP) and click through the actual UI change
5. Report the PR to the user for review/merge. Only confirm the feature is *live* after they've merged it and you've re-verified against production — see "Co-Developer Working Agreement" above.

**Never claim a feature is done based on local code alone.** The user expects proof it works in a real browser — on the PR's preview deploy pre-merge, and on production post-merge. If it doesn't look right, investigate and fix before confirming.

### Billing / PDF smoke test (mandatory when touching these files)

Any change to `src/lib/billing.ts`, `src/lib/send-proforma.ts`, `src/lib/pdf-generator.ts`, `src/lib/gst-invoice-generator.ts`, or any route under `src/app/api/billing-statements/` **must** include a manual PDF smoke test before declaring done:

1. Open a contract that has at least one print/service usage entry for the current month.
2. Trigger "Verify & Send" (or use the manual send button) to generate a proforma.
3. Open the generated PDF and verify: **Qty × Rate = Amount** for every line item.
4. Check that Qty is not `1` when the actual usage is more than 1 unit.

The browser UI cannot catch PDF rendering bugs — only the PDF itself can.

## Commands

```bash
npm run dev          # Start dev server (Next.js 16, Turbopack)
npm run build        # Production build — CI runs this on every push to main
npm run lint         # ESLint — must pass clean (0 errors) before merging
npm test             # Vitest — CI runs this on every push to main

npx supabase db push # Apply pending migrations to the live Supabase project
```

Test coverage is limited to pure-function/business-logic units (see `src/lib/__tests__/`) — there is no integration or UI test suite. Verify end-to-end behavior by running the dev server and testing in the browser.

When the Next.js dev server serves stale code after edits, clear the cache: `rm -rf .next` then restart.

## Tech Stack

- **Framework**: Next.js 16 (App Router) with React 19, TypeScript 5
- **Database**: Supabase (PostgreSQL) — migrations in `supabase/migrations/`
- **Auth**: Supabase Auth with cookie-based sessions (`@supabase/ssr`)
- **UI**: Tailwind CSS 4 + shadcn/ui (Radix primitives in `src/components/ui/`)
- **Payments**: Razorpay — keys stored in `app_settings` table, not env vars
- **Email**: Resend (transactional), Nodemailer (SMTP), MSG91 (SMS/WhatsApp)
- **Storage**: Backblaze B2 (S3-compatible) for file uploads
- **PDF**: jsPDF + pdf-lib for invoice/agreement generation
- **E-sign**: Leegality (agreement signing)
- **Deployment**: Vercel with GitHub Actions CI (lint + build)

## Architecture

### Routing

- `src/app/(dashboard)/` — All authenticated pages (sidebar layout)
- `src/app/(auth)/` — Login/signup pages
- `src/app/api/` — API route handlers (server-side only)
- Public routes: `/enquire`, `/pay`, `/verify`, `/feedback`, `/walkin`, `/facility-feedback`

### Data Access Patterns

- **User-scoped**: `createClient()` from `src/lib/supabase/server.ts` — respects RLS, uses cookie session. Use for reads in dashboard pages.
- **Admin/service**: `createAdminClient()` from same file — bypasses RLS, uses service role key. Use in API routes for elevated operations.
- **Webhooks**: Create their own service client inline (no cookies available). See `src/app/api/payments/webhook/route.ts` for the pattern.
- **Current user**: `GET /api/me` returns `{ role, full_name, email, phone }` — client components fetch this for role checks.

### Key Patterns

- **Audit trail**: All mutations must call `logAudit()` from `src/lib/audit.ts` (fire-and-forget, never blocks the main operation).
- **Constants**: Enums, labels, and color maps live in `src/lib/constants.ts` — always use these instead of inline strings. Each entity has a `_STATUSES`, `_STATUS_LABELS`, and `_STATUS_COLORS` triple.
- **Types**: Central type definitions in `src/types/index.ts`. Organised by domain (Location, User, Lead, Proposal, Contract, Voucher, Booking, Procurement, Prepaid, Facility, etc.).
- **Toast notifications**: Use `sonner` (`toast.success()`, `toast.error()`).
- **Zod validation**: API routes validate request bodies with Zod schemas. See `src/app/api/procurement/bills/[id]/route.ts` for the pattern.
- **Currency/dates**: Use `formatCurrency()` and `formatDate()` from `src/lib/utils.ts`.
- **Atomic operations**: Use Supabase RPCs (defined in migrations) for operations that require `FOR UPDATE` row locking — e.g., `redeem_prepaid_credits`, `insert_booking_payment_atomic`. Never do read-then-write for financial state.

### Large Page Architecture (new-booking)

The new-booking page (`src/app/(dashboard)/bookings/new/page.tsx`) is split into memo'd section components under `src/components/bookings/new-booking/`:
- **Controller pattern**: All state and effects live in the page. Computed values are `useMemo`, handlers are `useCallback`.
- **Context**: `BookingFormProvider` / `useBookingForm` (from `booking-form-context.tsx`) shares state across section components without prop-drilling.
- **Sections**: `RoomSelectionSection`, `TimeSelectionSection`, `CustomerDetailsSection`, `FacilitiesSection`, `PaymentSection`, `OutstandingChargesSection`, `BookingSummarySection` — each is `React.memo`'d.

### Razorpay Configuration

Keys are stored in the `app_settings` table (not env vars), fetched at runtime:
- `razorpay_key_id`, `razorpay_key_secret`, `razorpay_enabled`, `razorpay_webhook_secret`

Webhook handler: `src/app/api/payments/webhook/route.ts` — verifies HMAC signature, handles `payment_link.paid` (proposal deposit/pro-rata) and `payment.captured` (booking payments).

### Migrations

Naming: `NNNNN_description.sql` (sequential 5-digit prefix). Every new table must:
1. `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;`
2. Define at least a `SELECT` policy for `authenticated` role.

Apply locally with `npx supabase db push`.

### Cron Jobs

Defined in `vercel.json`. All cron endpoints are under `src/app/api/cron/`. Times are UTC (add 5:30 for IST). Protected by `CRON_SECRET` header.

| Schedule | Endpoint | Purpose |
|----------|----------|---------|
| 28–31st 21:00 IST | `/api/billing/auto-generate` | Monthly invoice generation |
| Daily 18:30 IST | `/api/cron/contract-expiry` | Contract expiry alerts |
| Daily 20:30 IST | `/api/digest` | Email digest |
| Mon 09:30 IST | `/api/cron/vendor-email-digest` | Vendor email nag digest |
| Daily 06:30 IST | `/api/cron/gmail-watch-renew` | Renew Gmail watch (no-ops until Gmail is configured) |

Billing generation logic is centralised in `src/lib/billing.ts` — used by both the cron and the manual trigger, and called on contract activation to generate the first statement immediately.

## Business Rules

### Roles and Permissions

`UserRole`: `admin`, `manager`, `sales_rep`, `floor_manager`, `accounts`, `fms`, `office_admin`, `it_manager`, `it_technician`

| Action | Allowed Roles |
|--------|--------------|
| Approve vendor bills | `admin` only — a `manager` gets a 403 |
| Record payments (vendor bills) | `accounts`, `admin`; `office_admin` **cash/petty cash only** — **only from Finance > Acc Payables**, and only on an approved bill |
| Record payments (customer: invoices, deposits, top-ups, ad-hoc) | `admin`, `accounts` only — `PAYMENT_RECORDING_ROLES` in `src/lib/constants.ts`. Everyone else uses **Report paid**, which routes to accounts to verify against the bank. `office_admin` keeps its existing carve-out for settling a pending deposit top-up. Front-desk **booking** payments are separate and unaffected. |
| Record petty cash (submit an entry) | **Any authenticated user** — no role gate; entries start at `pending_manager` |
| Approve petty cash | `admin`, `manager`; entries **≥ ₹5,000** need a second approval from `admin`/`accounts` |
| Manage contracts | `admin`, `manager`, `sales_rep` |
| Facility tickets | `fms`, `admin` |
| Void billing statements | `admin` only |

### Procurement → Payment Flow (strict separation)

1. **Procurement** (`/procurement/bills/[id]`): Create bills, attach invoices. `admin` approves/rejects — `manager` cannot (`canApproveOrReject` in `src/app/api/procurement/bills/[id]/route.ts` is `role === "admin"`). **No payment recording here.**
2. **Finance > Acc Payables** (`/accounting/vendor-payments/[id]`): `accounts`/`admin`/`office_admin` record payments on approved bills only. Uses `VendorEmailBanner` (`src/components/finance-intelligence/vendor-email-banner.tsx`) to prompt for missing vendor emails.

### Billing Statement Lifecycle

`draft` → `finalized` → `exported` (→ `voided`)

- Void action (admin only): `POST /api/billing-statements/[id]/void` — blocked if any payments recorded. Marks original as voided, un-links usage charges back to `pending`, creates a fresh draft with `voided_statement_id` back-reference.
- GST tax rates are locked to each contract's `tax_percentage` — never recalculate dynamically.
- `BillingLifecycleStatus` component (`src/components/billing/billing-lifecycle-status.tsx`) renders the 6-step progress indicator on list views.

### Proposal → Contract Flow (strictly enforced)

**Responsibility split:**
- **Proposal**: security deposit + pro-rata (first partial month) collection
- **Contract**: all monthly recurring billing once active

**Key rules:**
- Deposit link and pro-rata invoice link are **always separate Razorpay links**
- `POST /api/proposals/[id]/send-invoice` always creates a **fresh** link — never reuses `proposal.razorpay_payment_link_url`
- Deposit paid → webhook auto-accepts proposal (`status → accepted`)
- Pro-rata paid → `payment_status → paid`

**Contract activation gate (hard — do not bypass):**
1. `proposal_id` is set
2. Linked proposal `payment_status = 'paid'`
3. If `security_deposit_months > 0`: `deposit_payment_status = 'paid'`
- **Renewal exception**: contracts with `deposit_carried_from` bypass the gate
- Admin bypass: include `payment_override_reason` in PATCH body (logged to audit)

### Contract Lifecycle

Lead → Proposal (deposit + pro-rata) → Contract activation → Monthly billing → Renewal / Extension / Cancellation.

Cancellation has side effects (WiFi voucher revocation, usage charge settlement) that must be handled atomically.

### Contract Extension (short validity gaps — do not confuse with Renewal)

`POST /api/contracts/[id]/extend` — pushes an **active** contract's `end_date` forward by 1–60 days without changing rate, tenure, or terms. For short gaps only (e.g. a few days before renewal paperwork is signed); a new contract term still goes through Renewal.

**Hard rules (do not bypass):**
- 60-day cap is a **lifetime total per contract**, tracked in `contracts.days_extended` — not per single extension call.
- Blocked if contract status is `renewal_in_progress` (the parent's `end_date` is load-bearing for the renewal's split-billing logic in `computeRenewalSplitRentSegments`, `src/lib/billing.ts`).
- Blocked once `end_date` has already lapsed (`today > end_date`), even if the daily `contract-expiry` cron hasn't flipped status to `expired` yet — Extension is proactive only. A lapsed contract needs a fresh term via Renewal, not retroactive billing.
- No approval workflow — direct action by `admin`/`manager`/`sales_rep`, same roles as Renewal. A reason is required and logged to `audit_trail` (`action: "contract_extended"`).
- No new billing logic — billing already prorates by day and pools contracts by `end_date`, so extension just needs the date pushed forward.

## Environment Variables

Required in `.env.local` (and Vercel project settings):

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
NEXT_PUBLIC_APP_URL / APP_URL
CRON_SECRET
RESEND_API_KEY
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
MSG91_AUTH_KEY / MSG91_WHATSAPP_SENDER / MSG91_SMS_*
B2_KEY_ID / B2_APPLICATION_KEY / B2_BUCKET / B2_ENDPOINT
LEEGALITY_API_KEY / LEEGALITY_API_URL / LEEGALITY_PROFILE_ID / LEEGALITY_PRIVATE_SALT
BACKUP_DB_HOST / BACKUP_DB_NAME / BACKUP_DB_USER / BACKUP_DB_PASSWORD / BACKUP_DB_PORT
```

Razorpay keys are stored in the `app_settings` DB table, not env vars.

**Not currently set anywhere** (the Gmail inbound pipeline has never run in any
environment — see `docs/gmail-intake.md` before setting them):

```
GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN
GMAIL_WATCH_EMAIL / GMAIL_PUBSUB_TOPIC
GMAIL_PUBSUB_AUDIENCE / GMAIL_PUBSUB_SA_EMAIL
```

## Module Map

| Menu | Route prefix | Purpose |
|------|-------------|---------|
| Dashboard | `/dashboard` | KPIs, charts, alerts |
| Sales | `/leads`, `/proposals`, `/pipeline` | Lead-to-contract |
| Finance > Billing | `/billing` | Client invoices, receivables |
| Finance > Acc Payables | `/accounting?tab=vendor-payments` | Vendor bill payments |
| Finance > Contracts | `/contracts` | Active contract management |
| Finance > TDS | `/accounting/tds` | TDS deductions, challans, Form 26Q |
| Procurement | `/procurement/*` | Material requests → POs → vendor bills → delivery |
| Facility | `/facility` | Maintenance tickets, cleaning |
| Operations | `/bookings`, `/vouchers`, `/headcount` | Day-to-day space ops |
| Spaces | `/spaces` | Seat occupancy, floor canvas |
| Admin | `/admin/*` | Users, settings, locations |

---

## Workflow Checklists

### Before starting

- Read the relevant ticket / spec. If unclear, ask.
- If another Claude Code session might be active in this repo right now, use a worktree instead of the shared working directory — see "Critical Rules → ALWAYS".
- `git checkout main && git pull`
- `git checkout -b <type>/<short-description>` (types: `feat`, `fix`, `chore`, `refactor`, `docs`)
- Run `npm install` if `package.json` or lockfile changed.
- Skim existing code in the area you're about to touch — understand patterns before adding to them.

### During the task

- Make small, focused commits with conventional commit messages (see Git & PR Workflow below).
- If the scope grows beyond the original ticket, stop and ask before continuing.
- Write tests alongside the code, not after.

### Before committing

- [ ] `npm run lint` passes
- [ ] `npm run build` succeeds
- [ ] Manually tested the full user flow locally
- [ ] No `console.log` debug statements left behind
- [ ] No commented-out code
- [ ] No secrets in the diff (`git diff` and look)
- [ ] `git status` — no `??` untracked files that belong to this feature. Untracked files are served by the local dev server but **never deployed by Vercel** — they will 404 in production.

### Before merging

- [ ] PR description explains why, not just what
- [ ] Migration rollback noted (if applicable)
- [ ] Tested on staging (for anything touching auth, payments, or data)
- [ ] Reviewed by at least one other person (once team is in place)

---

## Code Conventions

- **TypeScript strict mode.** No `any` without a comment explaining why.
- **Server Components by default.** Add `"use client"` only when you need interactivity, hooks, or browser APIs.
- **Server Actions for mutations from the client.** Validate inputs with Zod.
- **No prop drilling beyond 2 levels** — use composition or context.
- **File naming**: `kebab-case.ts` for files, `PascalCase` for components.
- **Imports**: absolute imports via `@/` alias. No relative imports beyond `./` and `../`.
- **Error handling**: never swallow errors silently. Either handle, log (without PII), or rethrow.
- **Comments**: explain *why*, not *what*. Code should be self-documenting for the what.

---

## Database & Migrations (Supabase)

- All schema changes go through migrations. Never edit schema via the Supabase dashboard in production.
- Migration files live in `/supabase/migrations/`. Naming: `NNNNN_description.sql` (sequential 5-digit prefix, matching existing convention).
- **Pick the number against every branch, not just `main`.** `schema_migrations` keys on the prefix alone, so if two files share a number `db push` records the first and silently skips the rest — no error, the columns just never exist. `main` is not the source of truth here: people run `db push` from feature branches, so production is routinely ahead of `main`. CI runs `.github/scripts/check-migration-numbers.mjs`, which compares what your branch introduces against `main` and every remote branch; run it locally with `node .github/scripts/check-migration-numbers.mjs` before pushing. Re-check right before merging — the number can be taken while your PR is open.
- Test migrations locally first: `npx supabase db push` against your local instance.
- RLS is mandatory on every table containing user data. Default policy: deny all, then allow specific.
- Reversible migrations where possible — include a rollback path in the PR description for destructive changes.
- Never query Supabase from client components with the anon key without RLS — RLS is your only protection on the wire.

---

## Security & Secrets

- All secrets live in environment variables, documented in `.env.example` (with placeholder values, no real keys).
- Service role key: server-side only. Never expose to the browser.
- Webhook endpoints: verify signatures before processing.
- User input: validate server-side with Zod, even if the client also validates.
- External APIs: rate-limit and timeout. Never trust third-party response shapes — validate them.
- Auth checks: verify session in every API Route Handler that touches user data. Do not rely on middleware alone.

---

## Git & PR Workflow

### Commit format (conventional commits)

```
feat: add credential vault export endpoint
fix: handle expired session in dashboard loader
chore: bump next to 14.2.5
refactor: extract billing helpers to lib/billing
docs: update env var list in README
```

### Branches

- `main` — always deployable, protected
- `feat/*`, `fix/*`, `chore/*` — short-lived feature branches
- Delete branches after merge

### PR description template

```
## What
Brief summary of the change.

## Why
The reason for the change — link to issue / customer report / context.

## How to test
Steps to verify the change works.

## Migration / rollback notes
(If schema changes or destructive operations)

## Screenshots / screen recordings
(For UI changes)
```

Keep PRs small. If it's bigger than ~400 lines of diff, consider splitting.

### Deployment

- Production deploys happen via merge to `main` after PR approval.
- Feature flags for risky launches — ship dark, enable for a small cohort, then expand.
- Rollback: Vercel "Promote previous deployment" is one click. Supabase migrations need explicit rollback SQL.

---

## When in Doubt

- **Ask.** A 30-second clarifying question is cheaper than a 3-hour rebuild.
- **Read the code.** The pattern probably already exists.
- **Smaller PR.** When in doubt about scope, ship less.
- **Don't guess on security.** If you're unsure whether something is safe to expose, assume it isn't and ask.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
