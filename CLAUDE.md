# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TWV CRM is the internal operations platform for **The WorkVilla**, a coworking space business. It manages the full lifecycle: leads → proposals → contracts → billing → facility management → procurement → accounting.

**Production**: https://twv-crm.vercel.app (auto-deploys from `origin/main` via Vercel)

## Commands

```bash
npm run dev          # Start dev server (Next.js 16, Turbopack)
npm run build        # Production build — CI runs this on every push to main
npm run lint         # ESLint
```

There are no test suites in this project. Verify changes by running the dev server and testing in the browser.

When the Next.js dev server serves stale code after edits, clear the cache: `rm -rf .next` then restart.

## Tech Stack

- **Framework**: Next.js 16 (App Router) with React 19, TypeScript 5
- **Database**: Supabase (PostgreSQL) — migrations in `supabase/migrations/`
- **Auth**: Supabase Auth with cookie-based sessions (`@supabase/ssr`)
- **UI**: Tailwind CSS 4 + shadcn/ui (Radix primitives in `src/components/ui/`)
- **Email**: Resend (transactional), Nodemailer (SMTP), MSG91 (SMS/WhatsApp)
- **Storage**: Backblaze B2 (S3-compatible) for file uploads
- **PDF**: jsPDF + pdf-lib for invoice/agreement generation
- **Deployment**: Vercel with GitHub Actions CI (lint + build)

## Architecture

### Routing

- `src/app/(dashboard)/` — All authenticated pages (sidebar layout)
- `src/app/(auth)/` — Login/signup pages
- `src/app/api/` — API route handlers (server-side only)
- Public routes: `/enquire`, `/pay`, `/verify`, `/feedback`, `/walkin`, `/facility-feedback`

### Data Access Patterns

- **User-scoped**: `createClient()` from `src/lib/supabase/server.ts` — respects RLS, uses cookie session
- **Admin/service**: `createAdminClient()` — bypasses RLS, uses service role key. Use only in API routes for operations that need elevated privileges.
- **Current user**: `GET /api/me` returns `{ role, full_name, email, phone }` — client components fetch this to check role

### Key Patterns

- **Audit trail**: All mutations should call `logAudit()` from `src/lib/audit.ts` (fire-and-forget, never blocks)
- **Constants**: Enums, labels, and color maps live in `src/lib/constants.ts` — always use these instead of inline strings
- **Types**: Central type definitions in `src/types/index.ts`
- **Toast notifications**: Use `sonner` (`toast.success()`, `toast.error()`)
- **Zod validation**: API routes validate request bodies with Zod schemas (see `src/app/api/procurement/bills/[id]/route.ts` for pattern)
- **Currency/dates**: Use `formatCurrency()` and `formatDate()` from `src/lib/utils.ts`

### Cron Jobs

Defined in `vercel.json`. All cron endpoints are under `src/app/api/cron/`. Times are UTC. Protected by `CRON_SECRET` header.

## Business Rules

### Roles and Permissions

Roles (from `UserRole` type): `admin`, `manager`, `sales_rep`, `floor_manager`, `accounts`, `fms`, `office_admin`, `it_manager`, `it_technician`

| Action | Allowed Roles |
|--------|--------------|
| Approve vendor bills | `admin`, `manager` |
| Record payments (vendor bills) | `accounts`, `admin`, `office_admin` — **only from Finance > Acc Payables** |
| Record petty cash | `accounts`, `admin`, `office_admin` |
| Manage contracts | `admin`, `manager`, `sales_rep` |
| Facility tickets | `fms`, `admin` |

### Procurement → Payment Flow

This is a strict separation — do not mix these responsibilities:

1. **Procurement module** (`/procurement/bills/[id]`): Create vendor bills, attach invoices, view document chain. `admin`/`manager` can **approve or reject** bills. **No payment recording here** — only "Resend confirmation" for already-paid bills.
2. **Finance > Acc Payables** (`/accounting/vendor-payments/[id]`): `accounts`/`admin`/`office_admin` record payments **only on approved bills**. Payment recording includes an inline "Send confirmation to vendor" checkbox. Uses `VendorEmailBanner` to prompt for missing vendor emails.

### Vendor Email Handling

- `VendorEmailBanner` (`src/components/finance-intelligence/vendor-email-banner.tsx`): Persistent nag with escalation logic (4-hour snooze, escalates after 3 dismissals in 7 days). Supports `forceShow` prop.
- `VendorEmailChip` (`src/components/finance-intelligence/vendor-email-chip.tsx`): Inline "no email" indicator for list views.
- Payment confirmation emails are sent via `POST /api/procurement/bills/[id]/payment-email`.

### Billing Flow

- Contracts have billing cycles. Invoices auto-generate via cron (`/api/billing/auto-generate`) on the 28th-31st.
- GST tax rates are locked to each contract's `tax_percentage` — never recalculate dynamically.
- Payment batch scheduling: bills are batched as `immediate`, `15th`, or `25th` of the month.

### Contract Lifecycle

Lead → Proposal → Contract (with approval codes) → Billing → Renewal/Cancellation. Cancellation has side effects (WiFi voucher revocation, usage charge settlement) that must be handled atomically.

## Module Map

| Menu | Route prefix | Purpose |
|------|-------------|---------|
| Dashboard | `/dashboard` | KPIs, charts, alerts |
| Sales | `/leads`, `/proposals`, `/pipeline` | Lead-to-contract |
| Finance > Billing | `/billing` | Client invoices, receivables |
| Finance > Acc Payables | `/accounting?tab=vendor-payments` | Vendor bill payments |
| Finance > Contracts | `/contracts` | Active contract management |
| Procurement | `/procurement/*` | Material requests → POs → vendor bills → delivery |
| Facility | `/facility` | Maintenance tickets, cleaning |
| Operations | `/bookings`, `/vouchers`, `/headcount` | Day-to-day space ops |
| Admin | `/admin/*` | Users, settings, locations |
