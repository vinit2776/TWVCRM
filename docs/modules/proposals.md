# Proposals

## Purpose and Business Context

The Proposals module handles the commercial negotiation phase of the Lead → Contract lifecycle. A sales rep creates a proposal from a lead's detail page, sends it to the prospective client for review, collects payments (security deposit and first-month GST invoice), and then converts the accepted proposal into a formal contract.

Key business rules this module enforces:
- Security deposit and pro-rata (first month) invoice are always separate payment steps.
- Zero-deposit proposals require an admin OTP ("deposit waiver") before they can be sent or downloaded.
- The deposit payment link and the pro-rata invoice link are always fresh Razorpay links — never reused across invocations.
- A proposal PDF sent to the customer at the negotiation phase never contains the deposit payment button; the button only appears in the acceptance email.

---

## Routes

| Route | File | Description |
|---|---|---|
| `/proposals` | `src/app/(dashboard)/proposals/page.tsx` | List view — all proposals, paginated 25/page, filterable by status |
| `/proposals/[id]` | `src/app/(dashboard)/proposals/[id]/page.tsx` | Detail view — full lifecycle management UI |

Both routes are `"use client"` pages. There are no server-component wrappers.

---

## Key Source Files

### Pages
- `src/app/(dashboard)/proposals/page.tsx` — List page
- `src/app/(dashboard)/proposals/[id]/page.tsx` — Detail page (1,577 lines, contains all dialogs inline)

### Components
- `src/components/proposals/proposal-form.tsx` — Proposal creation dialog (opened from lead detail page)
- `src/components/proposals/proposal-lifecycle.tsx` — Sidebar timeline component showing all stages
- `src/components/proposals/booking-confirmation-dialog.tsx` — Confirm-accept dialog that triggers `/accept` API
- `src/components/proposals/deposit-waiver-gate.tsx` — OTP flow card for zero-deposit proposals
- `src/components/proposals/preset-picker.tsx` — Line-item preset selector in the form

### API Routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/proposals` | List all proposals (paginated, filterable) |
| POST | `/api/proposals` | Create proposal (Zod validated) |
| GET | `/api/proposals/[id]` | Fetch single proposal with lead + location join |
| PATCH | `/api/proposals/[id]` | Update allowed fields (status, timestamps, razorpay links, occupation date) |
| POST | `/api/proposals/[id]/accept` | Accept proposal: mark accepted, create deposit link, send booking confirmation email + WhatsApp |
| POST | `/api/proposals/[id]/send-invoice` | Generate prorated GST invoice, send email + WhatsApp (supports `preview: true` mode) |
| POST | `/api/proposals/[id]/deposit-link` | Create/reuse deposit Razorpay link, send email + WhatsApp (supports `preview: true`) |
| POST | `/api/proposals/[id]/deposit-payment` | Record manual bank transfer deposit payment (admin/manager/accounts only) |
| POST | `/api/proposals/[id]/payment-link` | Auto-create Razorpay link for monthly charge (idempotent — reuses existing link) |
| POST | `/api/proposals/[id]/monthly-link` | Create monthly charge Razorpay link and email it (manual trigger) |
| POST | `/api/proposals/[id]/email` | Send proposal PDF to customer via email + optional WhatsApp document |
| GET | `/api/proposals/[id]/track` | Public endpoint (no auth) — marks status `viewed`, redirects to PDF |
| GET | `/api/proposals/[id]/service-quotas` | Fetch service quotas for this proposal (for PDF rendering) |
| POST | `/api/proposals/[id]/deposit-waiver-otp` | OTP flow: `request` / `resend` / `verify` |
| GET | `/api/leads/[id]/proposals` | List proposals for a specific lead |
| POST | `/api/leads/[id]/proposals` | Create proposal scoped to a lead (alternative entry point) |
| GET | `/api/proposal-presets` | List line-item presets |
| POST | `/api/proposal-presets` | Create a line-item preset |
| GET/PATCH/DELETE | `/api/proposal-presets/[id]` | Read/update/delete a preset |
| GET/PATCH | `/api/accounting/proposal-payments` | Accounting view of deposits paid; mark as accounted |

### Lib Files
- `src/lib/validations.ts` — `createProposalSchema` and `updateProposalSchema` (Zod)
- `src/lib/pdf-generator.ts` — `generateProposalPDF()` — jsPDF proposal PDF generation
- `src/lib/gst-invoice-generator.ts` — `generateGstInvoicePDF()` — jsPDF GST invoice PDF
- `src/lib/auto-status.ts` — `autoUpdateLeadStatus()` called with `"proposal"` trigger on creation
- `src/lib/audit.ts` — `logAudit()`, `logEmailActivity()`, `logWhatsAppActivity()`
- `src/lib/constants.ts` — `PROPOSAL_STATUSES`, `PROPOSAL_STATUS_LABELS`, `PROPOSAL_STATUS_COLORS`, `DEFAULT_PROPOSAL_TERMS`, `COMPANY_BANK_DETAILS`
- `src/lib/tax.ts` — `calcGst()` — returns `{ cgst, sgst, igst, taxAmount, grandTotal }` (always intra-state TN: CGST+SGST only)

---

## Data Model

### Table: `proposals`

All columns added across migrations. The canonical full column list:

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID PK | `uuid_generate_v4()` | |
| `lead_id` | UUID NOT NULL → `leads(id)` | ON DELETE CASCADE | Required |
| `location_id` | UUID → `locations(id)` | ON DELETE SET NULL | Optional, added in `00006` |
| `proposal_number` | VARCHAR(50) UNIQUE | DB trigger | Format: `PROP-NNNN` (code) or `TWV-P-NNNN` (trigger). The app-layer code generates `PROP-NNNN`. The DB trigger generates `TWV-P-NNNN` when `proposal_number IS NULL` on insert. The API always supplies the number, so the trigger is a fallback. |
| `title` | VARCHAR(500) NOT NULL | | |
| `status` | `proposal_status` enum | `'draft'` | See status machine below |
| `description` | TEXT | | Shown as "Complimentary Services Offered" in UI |
| `items` | JSONB | `'[]'` | Array of `LineItem` objects |
| `subtotal` | DECIMAL(12,2) | 0 | Sum of `item.total` |
| `tax_percentage` | DECIMAL(5,2) | 18 | GST rate; locked at proposal creation time |
| `tax_amount` | DECIMAL(12,2) | 0 | `subtotal * tax_percentage / 100` |
| `discount_percentage` | DECIMAL(5,2) | 0 | |
| `discount_amount` | DECIMAL(12,2) | 0 | `subtotal * discount_percentage / 100` |
| `total_amount` | DECIMAL(12,2) | 0 | `subtotal + tax_amount - discount_amount` |
| `valid_until` | DATE | NULL | Razorpay link expiry uses this; falls back to now + 30 days |
| `terms_and_conditions` | TEXT | NULL | |
| `notes` | TEXT | NULL | Shown as "Customer Notes" in UI |
| `sent_at` | TIMESTAMPTZ | NULL | Set when email is sent |
| `viewed_at` | TIMESTAMPTZ | NULL | Set by public tracking endpoint |
| `accepted_at` | TIMESTAMPTZ | NULL | |
| `rejected_at` | TIMESTAMPTZ | NULL | |
| `rejection_reason` | TEXT | NULL | Added `00062` |
| `pdf_storage_path` | TEXT | NULL | Path in `crm-documents` bucket; used by tracking redirect (`00107`) |
| `created_by` | UUID → `users(id)` | NULL | ON DELETE SET NULL |
| `created_at` | TIMESTAMPTZ | NOW() | |
| `updated_at` | TIMESTAMPTZ | NOW() | Auto-updated by trigger |
| `occupation_start_date` | DATE | NULL | Set when GST invoice is sent (`00077`) |
| `payment_status` | TEXT | `'pending'` | `'pending'` or `'paid'` (`00068`) |
| `razorpay_payment_link_id` | TEXT | NULL | Monthly charge link ID |
| `razorpay_payment_link_url` | TEXT | NULL | Monthly charge link short URL |
| `payment_received_at` | TIMESTAMPTZ | NULL | |
| `payment_amount` | DECIMAL(12,2) | NULL | |
| `payment_reference` | TEXT | NULL | Razorpay payment ID or payment link ID |
| `security_deposit_months` | INTEGER | 0 | 0 means no deposit (`00069`) |
| `security_deposit_amount` | DECIMAL(12,2) | 0 | Pre-GST; auto-calculated as `months × subtotal` unless overridden |
| `deposit_payment_status` | TEXT | `'not_required'` | `'not_required'` / `'pending'` / `'paid'` |
| `deposit_razorpay_link_id` | TEXT | NULL | Deposit Razorpay payment link ID |
| `deposit_razorpay_link_url` | TEXT | NULL | Deposit Razorpay payment link short URL |
| `deposit_payment_received_at` | TIMESTAMPTZ | NULL | |
| `deposit_payment_amount` | DECIMAL(12,2) | NULL | Actual amount received (may differ by ≤10%) |
| `deposit_payment_reference` | TEXT | NULL | UTR or Razorpay payment ID |
| `deposit_payment_medium` | TEXT | NULL | `neft` / `rtgs` / `upi` / `cheque` / `cash` / `razorpay` (added `00217`) |
| `deposit_payment_screenshot_url` | TEXT | NULL | URL to proof in storage |
| `deposit_shortfall_approved_by` | UUID → `users(id)` | NULL | Tracks who approved a shortfall (added `00206`) |
| `deposit_accounted` | BOOLEAN | FALSE | Accounting team reconciliation flag (`00105`) |
| `deposit_accounted_at` | TIMESTAMPTZ | NULL | |
| `deposit_accounted_by` | TEXT | NULL | Auth user ID (not FK) |
| `deposit_waiver_otp` | TEXT | NULL | 6-digit OTP, cleared after use (`00164`) |
| `deposit_waiver_otp_expires` | TIMESTAMPTZ | NULL | 24-hour TTL |
| `deposit_waiver_verified_at` | TIMESTAMPTZ | NULL | Set on successful OTP verification |
| `deposit_waiver_verified_by` | UUID → `users(id)` | NULL | |
| `deposit_waiver_requested_at` | TIMESTAMPTZ | NULL | Set on OTP request/resend |

**Indexes:** `idx_proposals_lead_id`, `idx_proposals_status`, `idx_proposals_location_id`

### DB Trigger: `proposals_number`
Fires BEFORE INSERT when `proposal_number IS NULL`. Generates `TWV-P-NNNN` by finding `MAX(CAST(SUBSTRING(proposal_number FROM 'TWV-P-(\d+)') AS INTEGER))`. The application layer generates `PROP-NNNN` format using a count-based approach, bypassing the trigger.

### Table: `proposal_service_quotas`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `proposal_id` | UUID NOT NULL → `proposals(id)` | ON DELETE CASCADE |
| `service_id` | UUID NOT NULL → `service_catalog(id)` | ON DELETE RESTRICT |
| `monthly_quota` | NUMERIC(10,2) NOT NULL DEFAULT 0 | 0 = no free quota |
| `overage_rate` | NUMERIC(12,2) NOT NULL DEFAULT 0 | ex-GST per unit |
| `notes` | TEXT | |

UNIQUE constraint: `(proposal_id, service_id)`

### Table: `proposal_line_item_presets`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | VARCHAR(255) NOT NULL | Display label |
| `description` | TEXT NOT NULL | Pre-fills line item description |
| `quantity` | DECIMAL(10,2) DEFAULT 1 | |
| `unit` | VARCHAR(100) | e.g. "months", "seats" |
| `unit_price` | DECIMAL(12,2) DEFAULT 0 | |
| `category` | VARCHAR(100) | Optional group |
| `sort_order` | INT DEFAULT 0 | |
| `is_active` | BOOLEAN DEFAULT TRUE | |
| `created_by` | UUID → `users(id)` | ON DELETE SET NULL |

### RLS Policies

**proposals table:** RLS enabled. All four operations (SELECT, INSERT, UPDATE, DELETE) use `USING (auth.uid() IS NOT NULL)` — any authenticated user can perform any operation. There is no role-based row filtering at the DB level; role checks happen in API route handlers.

**proposal_service_quotas:** RLS enabled. SELECT and ALL operations allowed to any `authenticated` user.

**proposal_line_item_presets:** RLS enabled (`00110`).

**Note:** The public `/api/proposals/[id]/track` endpoint uses `createAdminClient()` (service role key) since no session is available.

---

## Status Machine

### `proposal_status` enum values
`draft` → `sent` → `viewed` → `accepted` | `rejected` | `expired`

```
draft
  │
  ├── (OTP waiver required for zero-deposit proposals)
  │
  ▼
sent         ← set by /email route OR manual "Mark as Sent" button
  │
  ▼
viewed       ← set by /track route when customer clicks email link (idempotent: only from "sent")
  │
  ├──► accepted  ← set by /accept route OR manual PATCH OR Razorpay webhook
  │              (payment_link.paid or deposit link paid → auto-accepted)
  │
  └──► rejected  ← manual only (requires rejection_reason)
```

**`expired`** exists in the enum but is not set by any code path in the current codebase. It may be set externally or reserved for future use.

### `deposit_payment_status` values (TEXT, not enum)
`not_required` (default when `security_deposit_months = 0`) | `pending` (set on create when months > 0) | `paid`

### `payment_status` values (TEXT, not enum)
`pending` (default) | `paid`

### Status transitions enforced server-side

- `/accept` route: only `sent` or `viewed` → `accepted` (HTTP 400 otherwise)
- `/email` route: sets status to `sent` (from any status, no guard)
- `/track` route: only `sent` → `viewed` (idempotent)
- `/send-invoice` route: requires status in `['sent', 'viewed', 'accepted']`
- `/deposit-link` route: requires status in `['sent', 'viewed', 'accepted']`

---

## Business Rules

### Hard Rules (must never be bypassed)

1. **Zero-deposit OTP gate:** When `security_deposit_months = 0`, the proposal cannot be emailed (`/email` route) or have its accept flow triggered (`/accept` route) until `deposit_waiver_verified_at` is non-null. Both routes return HTTP 403 with an explicit error message.

2. **Deposit before invoice:** When `security_deposit_months > 0`, the GST invoice (`/send-invoice`) cannot be sent until `deposit_payment_status = 'paid'`. HTTP 400 is returned.

3. **Fresh Razorpay link on invoice send:** The `/send-invoice` route always creates a new Razorpay payment link for the prorated amount. It never reuses the existing `razorpay_payment_link_url`. This is critical because the prorated amount differs from the full monthly amount.

4. **Deposit link reuse on `/deposit-link`:** The `/deposit-link` route reuses the existing `deposit_razorpay_link_url` if one already exists (to avoid duplicate links). Only creates a new one if `deposit_razorpay_link_url` is null.

5. **Manual deposit payment roles:** Only `admin`, `manager`, `accounts` roles can call `/deposit-payment`. HTTP 403 for others.

6. **Deposit shortfall tolerance:** If manual deposit amount is less than expected:
   - More than 10% short: hard block (HTTP 400).
   - ≤ 10% short: requires `shortfall_approved = true` AND actor must be `admin` or `manager`. `accounts` role cannot approve shortfalls.

7. **Proposal number uniqueness:** `proposal_number` has a UNIQUE DB constraint.

8. **Lead required:** `lead_id` is NOT NULL with FK to `leads(id)` ON DELETE CASCADE. All proposals must be linked to a lead.

### Webhook Auto-accept

The Razorpay webhook (`/api/payments/webhook/route.ts`) handles `payment_link.paid`:
- If `razorpay_payment_link_id` matches a proposal's main payment link → sets `payment_status = 'paid'`, `status = 'accepted'`, `accepted_at`.
- If `deposit_razorpay_link_id` matches → sets `deposit_payment_status = 'paid'`, `status = 'accepted'`, `accepted_at`.

### Escalating Alert Badge

The proposals list page shows an "Activate Contract" badge when:
- `proposal.status === 'accepted'`
- `payment_status === 'paid'`
- `deposit_payment_status === 'paid'` OR `deposit_payment_status === 'not_required'` OR `security_deposit_months` is falsy
- AND `accepted_at` was more than 0 days ago

Badge color escalates: amber (1–7 days) → orange (8–20 days) → red (21+ days).

---

## Validation Rules

### Zod Schema (`createProposalSchema` in `src/lib/validations.ts`)

| Field | Rule | Enforced |
|---|---|---|
| `lead_id` | UUID format required | Server (Zod) |
| `location_id` | UUID or empty string (empty → undefined/null) | Server (Zod) |
| `title` | min length 1 | Server (Zod), Client (form) |
| `items` | min 1 item | Server (Zod), Client (form) |
| `tax_percentage` | 0–100 | Server (Zod) |
| `discount_percentage` | 0–100 | Server (Zod) |
| `security_deposit_months` | 0–6 | Server (Zod) |
| `security_deposit_amount` | ≥ 0 | Server (Zod) |
| `service_quotas[].service_id` | UUID | Server (Zod) |
| `service_quotas[].monthly_quota` | ≥ 0 | Server (Zod) |
| `service_quotas[].overage_rate` | ≥ 0 | Server (Zod) |

### Totals Calculation (server-side only, not re-validated client-side)

```
subtotal = sum(item.quantity * item.unit_price) for each item
tax_amount = subtotal * (tax_percentage / 100)
discount_amount = subtotal * (discount_percentage / 100)
total_amount = subtotal + tax_amount - discount_amount
```

If `security_deposit_amount` is not supplied, it defaults to `security_deposit_months * subtotal` (pre-GST).

### Deposit payment server validation (`/deposit-payment`)

1. `amount` must be a valid positive float.
2. `deposit_payment_status` must be `'pending'` (not `'paid'` or `'not_required'`).
3. If `amount < security_deposit_amount`: shortfall check applies (see Hard Rules above).

### GST date validation (`/send-invoice`)

- `occupation_start_date` required; validated as string (format `YYYY-MM-DD` expected).
- Client also validates: `!/^\d{4}-\d{2}-\d{2}$/.test(gstDate)` before submitting.

### OTP validation (`/deposit-waiver-otp`)

- `otp` must be exactly 6 characters, all digits.
- OTP checked against `deposit_waiver_otp` column (string equality).
- `deposit_waiver_otp_expires` checked: must be in the future.
- OTP is cleared (`null`) after successful verification.

---

## Role Permissions

| Action | Allowed Roles |
|---|---|
| View proposal list | All authenticated |
| View proposal detail | All authenticated |
| Create proposal | All authenticated (via lead detail page) |
| Mark as Sent / Viewed / Accepted / Rejected (PATCH) | All authenticated |
| Accept proposal and send booking confirmation | All authenticated |
| Download / Send proposal PDF | All authenticated (blocked for zero-deposit without OTP) |
| Send deposit email | All authenticated |
| Send GST invoice | All authenticated |
| Record manual deposit payment | `admin`, `manager`, `accounts` only (HTTP 403 for others) |
| Approve deposit shortfall | `admin`, `manager` only |
| Request/verify deposit waiver OTP | Any authenticated user can request; OTP goes to all `admin` users |
| Mark deposit as accounted | All authenticated (via `/api/accounting/proposal-payments`) |

---

## Integration Points

### Leads Module
- Proposals are always created from a lead (`lead_id` required).
- On proposal creation, `autoUpdateLeadStatus(supabase, lead_id, "proposal")` is called — advances lead status to `proposal_sent` if not already at or beyond that status.
- The proposal detail page shows a back-link to the lead.

### Contracts Module
- The "Create Contract" button on the proposal detail page opens `CreateContractDialog` (dynamically imported).
- `CreateContractDialog` receives `leadId` and `defaultProposalId`.
- The contract activation gate (separate from proposals) checks `proposal.payment_status = 'paid'` and `proposal.deposit_payment_status = 'paid'` (when deposit required).

### Razorpay
- Keys fetched from `app_settings` table (keys: `razorpay_enabled`, `razorpay_key_id`, `razorpay_key_secret`) via `createAdminClient()`.
- Three distinct payment link types per proposal:
  1. Monthly charge link (`razorpay_payment_link_id` / `razorpay_payment_link_url`) — for `total_amount`
  2. Deposit link (`deposit_razorpay_link_id` / `deposit_razorpay_link_url`) — for `security_deposit_amount`
  3. GST invoice link — created fresh on each `/send-invoice` call, replaces the monthly charge link fields
- Razorpay link `reference_id` formats:
  - Monthly (payment-link route): `proposal_number` (no suffix)
  - Monthly (send-invoice route): `{proposal_number}-MON-{timestamp}`
  - Monthly (monthly-link route): `{proposal_number}-MON`
  - Deposit: `{proposal_number}-DEP-{timestamp}`
- Razorpay link `notes` identifies entity type: `type: "security_deposit"` or `type: "monthly_charge"`
- Webhook processes `payment_link.paid` events and auto-accepts proposals.
- Razorpay link expiry: defaults to `valid_until + 23:59:59Z` if set, else `now + 30 days`.

### Email (Resend)
- All emails use `EMAIL_FROM` and `EMAIL_REPLY_TO` from `src/lib/mailer.ts`.
- `/email` route sends to first recipient, others in CC.
- `/send-invoice` route CCs all active `admin`, `manager`, `accounts` users.
- Proposal email contains a tracking link: `GET /api/proposals/[id]/track` — auto-marks as `viewed` when opened.

### WhatsApp (MSG91)
- `src/lib/whatsapp.ts` — `messaging` object used for:
  - `messaging.proposalDocument()` — proposal PDF (optional, requires `send_via_whatsapp: true` flag)
  - `messaging.proposalDepositRequest()` — deposit payment link
  - `messaging.bookingConfirmationDocument()` — booking PDF on accept
  - `messaging.proposalInvoice()` — GST invoice text
  - `messaging.invoiceDocument()` — GST invoice PDF
- All WhatsApp calls are fire-and-forget (`.catch(console.error)`)

### Storage (Supabase, bucket: `crm-documents`)
- `proposals/{id}/proposal-latest.pdf` — latest emailed proposal PDF (overwritten on resend)
- `proposals/{id}/booking-confirmation-{timestamp}.pdf` — acceptance email PDF
- `proposals/{id}/deposit-proof-{timestamp}.{ext}` — deposit payment proof uploaded manually
- `invoices/{invoiceNumber-replaced-slashes}.pdf` — GST invoice PDF

### Accounting Module
- `GET /api/accounting/proposal-payments?month=YYYY-MM` aggregates deposits, proforma invoices, and billing statements paid in a given month.
- `deposit_accounted`, `deposit_accounted_at`, `deposit_accounted_by` fields on `proposals` table track reconciliation.

### Service Quotas
- `proposal_service_quotas` table stores per-service monthly quotas and overage rates.
- Created alongside proposal (POST `/api/proposals` extracts `service_quotas` from request body and inserts rows).
- Fetched at proposal detail render for PDF inclusion (`/service-quotas`).
- Intended to be copied to `contract_service_quotas` when the proposal converts to a contract.

---

## Key User Flows

### Flow 1: Create and Send Proposal

1. Open lead detail page → "Create Proposal" button → `ProposalForm` dialog.
2. Fill title, location, line items, tax %, discount %, valid until, terms, deposit months, deposit amount (optional override), service quotas.
3. Submit → `POST /api/leads/[id]/proposals` (or `POST /api/proposals`) with Zod validation.
4. Server calculates totals, sets `status: 'draft'`, `deposit_payment_status` based on deposit months.
5. Lead auto-status advances to `proposal_sent` if applicable.
6. If `security_deposit_months = 0`: proposal is locked. User must complete deposit waiver OTP flow.
7. Detail page auto-triggers `POST /api/proposals/[id]/payment-link` if `razorpay_payment_link_url` is null and status is not rejected.
8. User clicks "Email" → "Send Proposal" → `EmailDocumentDialog` opens.
9. Client generates PDF via `generateProposalPDF()` (dynamic import).
10. Submits PDF to `POST /api/proposals/[id]/email`.
11. Server sends email, optionally sends WhatsApp document, sets `status: 'sent'`, `sent_at`, `pdf_storage_path`.

### Flow 2: Zero-Deposit Waiver OTP

1. Proposal is created with `security_deposit_months = 0`.
2. `DepositWaiverGate` component shows on detail page.
3. User clicks "Request Admin Approval" → `POST .../deposit-waiver-otp` with `action: 'request'`.
4. Server generates 6-digit OTP, stores in `deposit_waiver_otp` (24-hour TTL), emails all `role = 'admin'` users.
5. Admin reads email, shares OTP with sales rep verbally.
6. Sales rep enters OTP in the gate component → `POST .../deposit-waiver-otp` with `action: 'verify'`.
7. Server validates OTP + expiry, sets `deposit_waiver_verified_at`, `deposit_waiver_verified_by`, clears `deposit_waiver_otp`.
8. Proposal is unlocked: Send Proposal and Download PDF are now available.

### Flow 3: Accept Proposal with Deposit

1. User clicks "Accept" button (visible when status is `sent` or `viewed`).
2. `BookingConfirmationDialog` opens, shows what will be sent.
3. User clicks "Accept & Send".
4. Client generates proposal PDF, sends `POST .../accept` with PDF as multipart form.
5. Server:
   a. Validates: status must be `sent` or `viewed`, zero-deposit must have OTP verified.
   b. Updates `status: 'accepted'`, `accepted_at`.
   c. Creates Razorpay deposit payment link if `hasDeposit` and no link yet; stores `deposit_razorpay_link_id/url`.
   d. Uploads PDF to `crm-documents` storage, creates signed URL.
   e. Sends booking confirmation email with PDF attached + deposit payment button.
   f. Sends WhatsApp text with deposit link.
   g. Sends WhatsApp document (PDF).
6. Deposit link shown on detail page sidebar with 30-day countdown.

### Flow 4: Collect Security Deposit (Manual Bank Transfer)

1. Customer pays via NEFT/RTGS/UPI. Operations staff receives payment.
2. On proposal detail, "Record Bank Transfer" button (visible when deposit pending and proposal sent/viewed/accepted).
3. Dialog opens. Staff enters amount, payment mode, UTR/reference, optional notes + proof file.
4. If amount < expected by ≤10%: admin/manager sees checkbox to approve shortfall.
5. If amount < expected by > 10%: hard block, cannot submit.
6. Submit → `POST .../deposit-payment` (multipart/form-data).
7. Server validates role, amount, shortfall rules.
8. Uploads proof file to storage.
9. Updates `deposit_payment_status: 'paid'`, `deposit_payment_amount`, `deposit_payment_reference`, `deposit_payment_medium`, `deposit_payment_received_at`, `deposit_payment_screenshot_url`.
10. Sends confirmation email to customer.

### Flow 5: Send Proforma Invoice (Pro-rata First Month)

1. Deposit must be paid (or no deposit required).
2. User opens Email dropdown → "GST Invoice — First Month" → dialog.
3. User enters occupation start date, clicks "Generate Preview".
4. `POST .../send-invoice` with `{ occupation_start_date, preview: true }`.
5. Server calculates: `daysRemaining = daysInMonth - dayOfMonth + 1`, `prorationFactor = daysRemaining / daysInMonth`, prorated amounts, GST (always CGST+SGST for TN intra-state).
6. Returns preview HTML + computed figures (shown in dialog iframe).
7. User clicks "Send Invoice".
8. `POST .../send-invoice` without `preview: true`.
9. Server creates fresh Razorpay link for prorated amount (always a new link, overwrites `razorpay_payment_link_url`).
10. Generates **Proforma Invoice** PDF (`generateGstInvoicePDF()` with `isProforma: true`), uploads to storage. PDF header reads "PROFORMA INVOICE"; number is labelled "Proforma Ref:".
11. Assigns proforma ref number: `TWV/INV/YY-YY/NNNN` (based on count of billing_statements with that FY prefix — shared sequence with GST invoices).
12. Emails customer (+ CCs admin/manager/accounts); PDF attached.
13. Sends WhatsApp text + WhatsApp document.
14. Sets `occupation_start_date` on proposal.
15. Once customer pays the PI via the Razorpay link → it surfaces in **Tally Inbox** (`/accounting/inbox`). Accounts team then issues the actual GST invoice from Tally and enters the GST invoice number in the Tally Inbox page, which is sent to the customer.

### Flow 6: Revise and Resend Proforma Invoice

Same as Flow 5 but triggered when `proposal.occupation_start_date` is already set. The dialog shows "Revise & Resend". A completely new proforma ref number is issued; no cancellation of the prior PI is performed automatically.

### Flow 7: Razorpay Webhook Auto-accept

1. Customer pays via the deposit Razorpay link.
2. Razorpay sends `payment_link.paid` to `/api/payments/webhook`.
3. Webhook matches on `deposit_razorpay_link_id`.
4. Sets `deposit_payment_status: 'paid'`, `status: 'accepted'`, `accepted_at`, `deposit_payment_received_at`, `deposit_payment_amount`, `deposit_payment_reference`.

---

## Known Pitfalls and Gotchas

### Proposal number format inconsistency
There are two formats in production: `PROP-NNNN` (generated by app code based on total count) and `TWV-P-NNNN` (generated by DB trigger). The app code always supplies `proposal_number` to the insert, so the trigger never fires for app-created proposals. However, if a proposal is inserted directly via Supabase dashboard or migration, the trigger format applies. Do not assume all proposal numbers match `PROP-` prefix.

### GST invoice link overwrites monthly charge link
`/send-invoice` always creates a fresh Razorpay link and stores it in `razorpay_payment_link_id` / `razorpay_payment_link_url`, overwriting the monthly charge link previously auto-created by the `/payment-link` route. After sending the GST invoice, the stored link represents the prorated invoice amount, not the full monthly amount.

### Deposit link display: 30-day countdown from `sent_at`
The UI calculates deposit link expiry as `sent_at + 30 days`. The actual Razorpay link expiry is set to `valid_until + 23:59:59Z` (if set) or `now + 30 days` at creation time. These two may not match if `valid_until` was explicitly set. The "Regenerate Expired Link" button clears `deposit_razorpay_link_id/url` via PATCH then calls `/deposit-link` to create a fresh one.

### `security_deposit_amount` is pre-GST
The deposit amount stored and displayed is pre-GST (just months × subtotal). No GST is charged on the security deposit in the Razorpay link or email. Do not add GST to the deposit amount.

### Proposal PDF has no deposit button at negotiation phase
The proposal PDF and email sent via `/email` route never includes the Razorpay deposit link. The deposit button only appears in the booking confirmation email sent by `/accept`. This is intentional — the deposit link is only sent after mutual acceptance.

### `items` is JSONB, not a separate table
Line items are stored as JSONB in `proposals.items`. There is no separate `proposal_line_items` table. The `LineItem` shape is: `{ description: string, quantity: number, unit?: string, unit_price: number, total: number }`.

### `total_amount` in proposal is pre-GST for the monthly charge field in email
Despite being called `total_amount`, it represents the post-tax monthly amount (subtotal + tax). However, the email/UI states "₹X/month + GST" which is misleading — the displayed amount already includes GST as calculated. Check `subtotal` vs `total_amount` if building any reconciliation logic.

### Manual deposit payment uses `createClient()` (not admin) for storage upload
The `/deposit-payment` route uses `createClient()` for storage upload, which means the upload depends on RLS policies on the storage bucket for authenticated users. If bucket policies change, this upload may fail.

### Shortfall approval checkbox is role-checked both client and server
Only `admin` and `manager` roles see the shortfall approval checkbox in the UI (`currentUser.role` check). The server independently checks `SHORTFALL_APPROVER_ROLES = ["admin", "manager"]`. The `accounts` role can record deposits but cannot approve shortfalls even if they find a way to send the field.

### `/track` is a public endpoint with no auth
`GET /api/proposals/[id]/track` uses `createAdminClient()` and requires no session. It marks the proposal as `viewed`. Anyone with a proposal ID can trigger this. This is by design (email tracking), but means any proposal can be marked viewed without authentication.

### `deposit_waiver_otp` is stored in plaintext
The OTP is stored as plain TEXT in the `deposit_waiver_otp` column. It is cleared after use. It is only readable via `createAdminClient()` (service role) in the verify route, not via the user-scoped client.

### Auto-created monthly payment link on detail page load
The proposal detail page auto-fires `POST /api/proposals/[id]/payment-link` on every load if `razorpay_payment_link_url` is null and status is not `rejected`. This creates a Razorpay link silently. If Razorpay is down or misconfigured, this will throw a console error but not block the page.

---

## Environment / Config Dependencies

| Config | Source | Used by |
|---|---|---|
| `razorpay_enabled` | `app_settings` table | All Razorpay link creation routes |
| `razorpay_key_id` | `app_settings` table | All Razorpay link creation routes |
| `razorpay_key_secret` | `app_settings` table | All Razorpay link creation routes |
| `NEXT_PUBLIC_APP_URL` / `APP_URL` | env var | Razorpay `callback_url` and tracking URL generation |
| `RESEND_API_KEY` | env var | Email sending via Resend |
| `MSG91_AUTH_KEY` etc. | env var | WhatsApp messaging |
| `SUPABASE_SERVICE_ROLE_KEY` | env var | `createAdminClient()` — used in accept, send-invoice, deposit-link, waiver-otp routes |

No feature flags beyond `razorpay_enabled` in `app_settings`. Razorpay disabled = deposit/monthly links cannot be created; manual bank transfer flow still works.

---

## Proforma Invoice Numbering

Proforma ref numbers follow: `TWV/INV/YY-YY/NNNN` (shared sequence with GST invoices on billing statements)

- `YY-YY` = Indian financial year (April–March). If current month ≥ April, `fyStart = currentYear`.
- `NNNN` = count of existing `billing_statements` with same FY prefix + 1 (padded to 4 digits).
- Uses `adminSupabase` to query `billing_statements.gst_invoice_number LIKE 'TWV/INV/YY-YY/%'`.
- **Gotcha:** The numbering sequence is based on `billing_statements`, not `proposals`. The pro-rata invoice created at proposal stage is NOT stored in `billing_statements` — only the number is allocated from that count. This means the first invoice could be `0001` even if some billing statements already exist with the same prefix from the same FY.

---

## Proration Formula

```
startDate = occupation_start_date (UTC)
year, month, dayOfMonth = startDate.getUTCFullYear/Month/Date
daysInMonth = new Date(year, month + 1, 0).getDate()  // JS: month is 0-indexed
daysRemaining = daysInMonth - dayOfMonth + 1           // inclusive of start day
prorationFactor = daysRemaining / daysInMonth

proratedSubtotal = round(subtotal * prorationFactor, 2)
// GST is always CGST + SGST (intra-state Tamil Nadu)
{ cgst, sgst, igst=0, taxAmount, grandTotal } = calcGst(proratedSubtotal, taxPercentage)

// Line item rates are also prorated individually:
proratedRate = round(item.unit_price * prorationFactor, 2)
lineAmount = round(item.quantity * proratedRate, 2)
```

All rounding uses `Math.round(x * 100) / 100` (2 decimal places).
