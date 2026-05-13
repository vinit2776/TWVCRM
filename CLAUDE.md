# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TWV CRM is the internal operations platform for **The WorkVilla**, a coworking space business. It manages the full lifecycle: leads → proposals → contracts → billing → facility management → procurement → accounting.

**Production**: https://twv-crm.vercel.app (auto-deploys from `origin/main` via Vercel)

## Commands

```bash
npm run dev          # Start dev server (Next.js 16, Turbopack)
npm run build        # Production build — CI runs this on every push to main
npm run lint         # ESLint — must pass clean (0 errors) before merging

npx supabase db push # Apply pending migrations to the live Supabase project
```

There are no test suites. Verify changes by running the dev server and testing in the browser.

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
| Daily 09:30 IST | `/api/digest` | Email digest |
| Mon 09:30 IST | `/api/cron/vendor-email-digest` | Vendor email nag digest |

Billing generation logic is centralised in `src/lib/billing.ts` — used by both the cron and the manual trigger, and called on contract activation to generate the first statement immediately.

## Business Rules

### Roles and Permissions

`UserRole`: `admin`, `manager`, `sales_rep`, `floor_manager`, `accounts`, `fms`, `office_admin`, `it_manager`, `it_technician`

| Action | Allowed Roles |
|--------|--------------|
| Approve vendor bills | `admin`, `manager` |
| Record payments (vendor bills) | `accounts`, `admin`, `office_admin` — **only from Finance > Acc Payables** |
| Record petty cash | `accounts`, `admin`, `office_admin` |
| Manage contracts | `admin`, `manager`, `sales_rep` |
| Facility tickets | `fms`, `admin` |
| Void billing statements | `admin` only |

### Procurement → Payment Flow (strict separation)

1. **Procurement** (`/procurement/bills/[id]`): Create bills, attach invoices. `admin`/`manager` approve/reject. **No payment recording here.**
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

Lead → Proposal (deposit + pro-rata) → Contract activation → Monthly billing → Renewal / Cancellation.

Cancellation has side effects (WiFi voucher revocation, usage charge settlement) that must be handled atomically.

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
