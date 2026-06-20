# Tally Inbox

## Purpose and Business Context

The Tally Inbox is the human-mediated handoff layer between TWV CRM (which generates billing statements) and Tally Prime (which is the company's authoritative accounting and GST filing system). It lives at `/accounting/inbox` and is gated behind the `tally_handoff_v2_enabled` feature flag.

**Business problem it solves:** Tally is the sole system that can mint a legally valid GST tax invoice and IRN (Invoice Reference Number from NIC's IRP portal). The CRM generates proforma invoices (PI) and tracks billing. Once a payment comes in (or for direct-GST contracts, when a statement is finalized), accounts must:
1. Create the GST invoice in Tally
2. Generate the IRN if the customer is GST-registered
3. Upload the PDF back to the CRM
4. Dispatch it to the customer (with Razorpay payment link if still unpaid)
5. Record the receipt in Tally once payment is confirmed

The inbox is a worklist that tracks every open task, prevents double-sends, detects amount mismatches between Tally and CRM, and auto-closes tasks when the bridge verifies receipt vouchers.

---

## Routes

| Route | What it renders |
|-------|-----------------|
| `/accounting/inbox` | The full Tally Inbox worklist page |

The page is a Next.js Server Component (`force-dynamic`) that:
- Verifies the session and enforces `isInboxRole()` check; redirects to `/dashboard` if the user's role is not permitted.
- Reads the `tally_handoff_v2_enabled` flag from `app_settings` using `createAdminClient()`.
- If flag is `false`, renders an amber notice telling admin how to enable it.
- If flag is `true`, renders `<TallyInboxClient />`.

---

## Key Source Files

| File | Purpose |
|------|---------|
| `src/app/(dashboard)/accounting/inbox/page.tsx` | Server component, auth + flag gate |
| `src/components/accounting/tally-inbox-client.tsx` | Client worklist component (stat cards, tabs, rows, actions) |
| `src/components/accounting/tally-inbox-upload-form.tsx` | Inline upload form rendered inside an expanded row |
| `src/lib/tally-handoff.ts` | Shared types, state constants, label maps, bucket logic (client-safe) |
| `src/lib/tally-handoff-server.ts` | Server-only: `setHandoffState`, `handleStatementPaid`, `handleStatementFinalized`, intimation emails |
| `src/lib/tally-pdf-extract.ts` | PDF text-parse extraction (invoice number, IRN, date, amount) via pdf-parse |
| `src/lib/tally/dispatch-tally-invoice.ts` | Legacy/bridge dispatch path — builds CRM-generated GST PDF from Tally ack |
| `src/lib/tally/enqueue.ts` | Receipt voucher enqueue for the Tally bridge |
| `src/app/api/accounting/inbox/route.ts` | `GET /api/accounting/inbox` — main data feed |
| `src/app/api/billing-statements/[id]/upload-gst-invoice/route.ts` | Upload, validate, store PDF, transition state, create Razorpay link, email customer |
| `src/app/api/billing-statements/[id]/inbox-send/route.ts` | "Save & send" — email the uploaded PDF, transition state |
| `src/app/api/billing-statements/[id]/inbox-complete/route.ts` | Manually close a row |
| `src/app/api/billing-statements/[id]/extract-gst-invoice/route.ts` | PDF autofill cascade (text parse + bridge cross-check) |
| `src/app/api/billing-statements/[id]/resend-gst-invoice/route.ts` | Resend the GST invoice email for a closed row |
| `src/app/api/billing-statements/[id]/preview-gst-stamp/route.ts` | Preview-only: returns stamped PDF bytes, no DB writes |
| `src/app/api/billing-statements/[id]/convert-to-gst-early/route.ts` | Override: cancel PI, queue to inbox as `direct_gst_requested` |
| `src/app/api/billing-statements/[id]/proforma-pdf/route.ts` | Download the CRM proforma PDF (PI) |
| `src/app/api/billing-statements/[id]/gst-invoice-pdf/route.ts` | Download the uploaded GST invoice PDF |
| `src/app/api/billing-statements/[id]/payment/route.ts` | Manual payment entry — calls `handleStatementPaid` on full payment |
| `src/app/api/payments/webhook/route.ts` | Razorpay webhook — calls `handleStatementPaid` on `payment_link.paid` |
| `src/app/api/tally/sync-pull/route.ts` | Bridge upserts voucher snapshots; auto-completes `paid_awaiting_receipt_record` rows |
| `src/app/api/cron/inbox-digest/route.ts` | Daily 09:30 IST digest email of open items |

---

## Data Model

### Table: `billing_statements` (extended by migration 00255)

New columns added for handoff v2:

| Column | Type | Notes |
|--------|------|-------|
| `handoff_state` | `text` (nullable) | Accounts-inbox state machine. `NULL` = legacy bridge flow. |
| `created_via` | `text` (nullable) | `'cron' \| 'ad_hoc_request' \| 'manual_correction' \| 'legacy'` |
| `pi_cancelled_at` | `timestamptz` (nullable) | Set by `convert-to-gst-early`; marks PI as cancelled |
| `pi_cancelled_by` | `uuid` → `users(id)` | Who cancelled the PI |
| `pi_override_reason` | `text` (nullable) | Required min-5-char reason for the cancel |
| `gst_invoice_number` | `text` | Mirrored from `tally_invoice_number` on upload |
| `tally_invoice_number` | `text` | The Tally voucher number (e.g. `SD/A/26-27/175`) |
| `tally_total_amount` | `numeric` | Tally's authoritative total, mirrored on upload |
| `issuance_channel` | `text` | Set to `'tally'` on upload (blocks CRM-side GST gen) |
| `tally_sync_status` | `text` | Set to `'issued'` on upload |
| `gst_invoice_sent_at` | `timestamptz` | Timestamp of last successful email send |
| `gst_invoice_sent_to` | `text` | Recipient email of last send |
| `tally_delivered_at` | `timestamptz` | D3 gate — set on `inbox-send`; blocks re-dispatch |

**CHECK constraint** `billing_statements_handoff_state_check`:
```sql
handoff_state IS NULL OR handoff_state IN (
  'pi_awaiting_payment', 'pi_paid_awaiting_gst', 'direct_gst_requested',
  'name_check_pending', 'ready_to_send', 'gst_sent', 'gst_sent_awaiting_payment',
  'paid_awaiting_receipt_record', 'complete'
)
```

**Partial index** `idx_billing_statements_handoff_state`:
```sql
ON billing_statements (handoff_state)
WHERE handoff_state IS NOT NULL AND handoff_state <> 'complete'
```
Only open items are indexed — inbox queries are always filtered to this set.

**Related columns on `contracts`** (migration 00230):
- `billing_mode TEXT NOT NULL DEFAULT 'proforma_first'` with CHECK `IN ('proforma_first', 'gst_direct')`

---

### Table: `gst_invoice_uploads`

Stores one row per accounts upload. Multiple uploads per statement are allowed (re-upload supersedes earlier); only the row with `superseded_by IS NULL` is the live upload.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid PK` | |
| `billing_statement_id` | `uuid NOT NULL` → `billing_statements(id) ON DELETE RESTRICT` | FK; RESTRICT prevents deleting a statement that has an upload |
| `uploaded_by` | `uuid NOT NULL` → `auth.users(id)` | Auth user UUID (not `users.id`) |
| `uploaded_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `tally_invoice_number` | `text NOT NULL` | e.g. `SD/A/26-27/175` or `SD/B/26-27/89` |
| `tally_invoice_series` | `text NOT NULL` | `'SDIPL-REG'` (A-series, GST customer) or `'SDIPL-UNREG'` (B-series, no GST) |
| `irn` | `text` (nullable) | 64-char hex IRN from NIC portal — required for SDIPL-REG per compliance, optional since migration 00265 |
| `invoice_date` | `date NOT NULL` | |
| `invoice_amount` | `numeric(12,2) NOT NULL` | Must equal `billing_statements.total_amount` to 2 decimal places |
| `invoice_pdf_url` | `text NOT NULL` | Path in `crm-documents` Supabase Storage bucket under `tally-handoff/<contract_id>/<timestamp>-<safe_number>.<ext>` |
| `qr_payload` | `jsonb` (nullable) | Decoded JWT from QR code if present |
| `autofill_source` | `text NOT NULL` | `'qr' \| 'pdf_text' \| 'bridge_match' \| 'manual'` |
| `nic_signature_verified` | `boolean NOT NULL DEFAULT false` | |
| `name_check_status` | `text NOT NULL DEFAULT 'pending'` | `'pending' \| 'approved' \| 'overridden'` |
| `name_check_decided_by` | `uuid` → `auth.users(id)` | |
| `name_check_decided_at` | `timestamptz` | |
| `name_check_notes` | `text` | |
| `superseded_by` | `uuid` → `gst_invoice_uploads(id)` | Self-referential; non-null means this row is superseded |
| `notes` | `text` | |

**Critical CHECK constraint** `gst_invoice_uploads_irn_matches_series` (updated in migration 00265):
```sql
(tally_invoice_series = 'SDIPL-REG'   AND (irn IS NULL OR length(irn) = 64)) OR
(tally_invoice_series = 'SDIPL-UNREG' AND irn IS NULL)
```

The original constraint (migration 00255) required `irn IS NOT NULL AND length(irn) = 64` for SDIPL-REG. Migration 00265 relaxed this to allow `irn IS NULL` for A-series, because Tally PDFs may not expose the IRN as extractable text (it may be only in the QR code). A wrong-length IRN still fails.

**CHECK constraint** `gst_invoice_uploads_amount_positive`: `invoice_amount > 0`

**Indexes:**
- `idx_gst_uploads_statement` on `(billing_statement_id)`
- `idx_gst_uploads_irn` on `(irn)` WHERE irn IS NOT NULL
- `idx_gst_uploads_invoice_number` on `(tally_invoice_number)`
- `idx_gst_uploads_uploaded_at` on `(uploaded_at DESC)`

**RLS policies** (fixed in migration 00263 — original 00255 had a bug using `users.id` instead of `users.auth_id`):
- SELECT: `accounts`, `admin`, `office_admin`, `manager`
- INSERT: `accounts`, `admin` only
- UPDATE: `accounts`, `admin` only
- No DELETE policy — uploads are permanent audit records; supersede via `superseded_by`

---

### Table: `tally_voucher_snapshots`

Read-only mirror of Tally vouchers, populated only by the bridge via `/api/tally/sync-pull` using the service role. Authenticated users can only SELECT.

| Column | Type | Notes |
|--------|------|-------|
| `voucher_master_id` | `text NOT NULL` | Tally's REMOTEID |
| `company_name` | `text NOT NULL` | Guard against wrong-company sync |
| `voucher_kind` | `text NOT NULL` | `'sales' \| 'receipt' \| 'credit_note'` |
| `voucher_series` | `text` | SDIPL-REG, SDIPL-UNREG, CREDIT NOTE-REG, Receipt |
| `invoice_number` | `text` | e.g. `SD/A/26-27/175` |
| `party_name` | `text` | |
| `party_gstin` | `text` | |
| `voucher_date` | `date` | |
| `voucher_amount` | `numeric(12,2)` | |
| `irn` | `text` | |
| `against_voucher` | `text` | For receipts: the sales voucher cleared |
| `custom_fields` | `jsonb NOT NULL DEFAULT '{}'` | Narration, cost center, voucher class, dispatch info |
| `matched_statement_id` | `uuid` → `billing_statements(id)` | Best-effort CRM match |
| `match_confidence` | `text` | `'exact' \| 'probable' \| 'unmatched'` |
| `last_synced_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `sync_batch_id` | `uuid NOT NULL` | |
| `first_seen_at` | `timestamptz NOT NULL DEFAULT now()` | |

**PRIMARY KEY**: `(voucher_master_id, company_name)` — composite, prevents cross-company collision.

---

## Feature Flag

| Key | Table | Expected value to enable |
|-----|-------|--------------------------|
| `tally_handoff_v2_enabled` | `app_settings` | `'true'` (string, not boolean) |

The flag was enabled in production by migration 00263 (`UPDATE app_settings SET value = 'true' WHERE key = 'tally_handoff_v2_enabled'`).

The flag is readable by authenticated users whose role is permitted, via the `app_settings` RLS policy (migration 00264 adds it to the whitelist: `key IN ('razorpay_enabled', 'razorpay_key_id', 'upi_id', 'upi_qr_code_path', 'tally_handoff_v2_enabled')`).

Reading the flag from server routes that use `createClient()` (user-scoped RLS) requires this whitelist. Reading from routes that use `createAdminClient()` bypasses RLS and works unconditionally.

---

## State Machine / Handoff State Lifecycle

### All valid states

```
HANDOFF_STATES = [
  "pi_awaiting_payment",
  "pi_paid_awaiting_gst",
  "direct_gst_requested",
  "name_check_pending",        // reserved; not currently written
  "ready_to_send",
  "gst_sent",
  "gst_sent_awaiting_payment",
  "paid_awaiting_receipt_record",
  "complete",
]
```

`NULL` is also valid and means "legacy bridge flow — not managed by inbox v2".

### State transitions and triggers

```
NULL → direct_gst_requested
  trigger: billing cron finalizes a gst_direct contract statement
           (handleStatementFinalized in billing.ts)

NULL → direct_gst_requested
  trigger: admin/manager calls POST /convert-to-gst-early
           (overrides PI, cancels Razorpay link)

payment captured (proforma_first) → pi_paid_awaiting_gst
  trigger: Razorpay webhook payment_link.paid (handleStatementPaid)
  trigger: Manual payment brings total to fully paid (handleStatementPaid)

payment captured (gst_direct) → paid_awaiting_receipt_record
  trigger: Same as above but gst_direct billing_mode

pi_paid_awaiting_gst → ready_to_send
  trigger: Accounts uploads GST invoice PDF (upload-gst-invoice route)

direct_gst_requested → ready_to_send
  trigger: Same as above

ready_to_send → gst_sent_awaiting_payment
  trigger: upload-gst-invoice auto-sends email for unpaid statements

ready_to_send → gst_sent_awaiting_payment
  trigger: inbox-send route (Save & send button) for unpaid

ready_to_send → gst_sent (if already paid)
  trigger: inbox-send route; immediately transitions to complete

gst_sent → complete
  trigger: inbox-send detects payment_status=paid, sets complete directly

gst_sent_awaiting_payment → complete
  trigger: inbox-complete route (manual Mark as done)

gst_sent_awaiting_payment → paid_awaiting_receipt_record
  trigger: customer pays (webhook or manual entry calls handleStatementPaid)

paid_awaiting_receipt_record → complete
  trigger: bridge sync-pull detects a receipt voucher matching the statement
           (bridge_receipt_verified trigger in sync-pull route)

paid_awaiting_receipt_record → complete
  trigger: inbox-complete route (manual fallback when bridge can't match)

gst_sent → complete
  trigger: inbox-complete route (defensive; should auto-close normally)
```

### Bucket mapping (for stat cards and filter tabs)

| State(s) | Bucket | UI tab |
|----------|--------|--------|
| `pi_paid_awaiting_gst`, `direct_gst_requested` | `gst_to_issue` | GST to issue |
| `paid_awaiting_receipt_record` | `payment_to_record` | Payments |
| any state with `has_discrepancy=true` | `discrepancy` | Discrepancies |
| `name_check_pending`, `ready_to_send`, `gst_sent`, `gst_sent_awaiting_payment`, `pi_awaiting_payment` | `in_flight` | All open |
| `complete` | `complete` | Closed |

---

## Three Billing Flows

### Flow 1: PI-first (proforma_first contracts, most common)

Steps visible in the lifecycle tracker:
1. PI Sent (billing cron sends proforma to customer)
2. Payment Received → triggers `pi_paid_awaiting_gst`
3. GST in Tally (accounts uploads invoice → `ready_to_send`)
4. Invoice Sent → `gst_sent` or `gst_sent_awaiting_payment`
5. Done → `complete`

### Flow 2: Override / PI-cancelled

Admin/manager calls `convert-to-gst-early`. This:
- Cancels existing Razorpay payment link via Razorpay API
- Sets `pi_cancelled_at`, `pi_cancelled_by`, `pi_override_reason`
- Clears `razorpay_payment_link_id`, `razorpay_payment_link_url`
- Sets `handoff_state = 'direct_gst_requested'`

Lifecycle tracker shows: PI Cancelled → GST in Tally → Link + Email Sent → Payment Received → Done.

Guards on `convert-to-gst-early`:
- `status` must be `'finalized'` (not draft)
- `payment_status` must not be `'paid'` (already fully paid → use standard flow)
- `gst_invoice_number` must be null (GST not already issued)
- `pi_cancelled_at` must be null (not already overridden)

### Flow 3: GST Direct (gst_direct contracts)

When a statement is finalized by the billing cron, `handleStatementFinalized` checks the flag. For gst_direct: sets `handoff_state = 'direct_gst_requested'`, returns `skipLegacyDispatch: true` (so the cron does not try to send a proforma). Payment comes after the GST invoice is sent.

Lifecycle tracker shows: GST Requested → GST in Tally → Invoice + Link Sent → Payment Received → Done.

---

## Business Rules (Hard — Never Bypass)

### Amount equality
The `invoice_amount` in the upload form must equal `billing_statements.total_amount` to exactly 2 decimal places (`toFixed(2)` comparison). No override is allowed. Violation returns HTTP 422. If amounts differ, accounts must either:
- Fix the Tally voucher, or
- Void + reissue the CRM statement

Enforced: client-side (validation array in upload form), server-side (`upload-gst-invoice` route), and at DB level via `gst_invoice_uploads_amount_positive` (ensures positive, but amount-equality is only enforced server-side).

### Series ↔ GSTIN parity
- Customer has GSTIN → must upload `SDIPL-REG` (A-series), invoice number must start with `SD/A/`
- Customer has no GSTIN → must upload `SDIPL-UNREG` (B-series), invoice number must start with `SD/B/`
- Violation returns HTTP 422 with a clear message

Enforced: server-side in `upload-gst-invoice`. DB enforces via `gst_invoice_uploads_irn_matches_series` CHECK.

### IRN rules
- A-series (`SDIPL-REG`): IRN is optional but if provided must be exactly 64 characters
- B-series (`SDIPL-UNREG`): IRN must be absent (null); providing one returns HTTP 422
- Empty-string IRN is normalised to `null` server-side (`if (!meta.irn?.trim()) meta.irn = null`) before the DB CHECK runs

Enforced: server-side, plus DB CHECK constraint (migration 00265).

### D3 gate (deliver once)
`inbox-send` route checks `tally_delivered_at`. If already set, returns HTTP 409 "Statement already delivered." Admin can bypass via the `admin/tally/redispatch` route.

`upload-gst-invoice` auto-sends for unpaid statements immediately on upload; if email fails, it returns `email_warning` in the response body (HTTP 200 with `email_warning` field) and leaves state at `ready_to_send` for retry via "Save & send".

### issuance_channel lock
When an upload is accepted, `issuance_channel = 'tally'` and `tally_sync_status = 'issued'` are stamped on the statement. This is the "D2: decide once" gate that prevents the CRM from generating its own GST invoice after Tally has taken ownership.

### Upload immutability
No DELETE policy on `gst_invoice_uploads`. To replace an upload, insert a new row and set `superseded_by` on the old row. The live upload is always the one with `superseded_by IS NULL`.

### No PI cancel if already overridden
`convert-to-gst-early` checks `pi_cancelled_at IS NULL`; returns HTTP 409 if already set.

---

## Validation Rules

### Client-side (upload form — `tally-inbox-upload-form.tsx`)

These are `useMemo` computed and block form submission but do NOT block the server:

| Rule | Error message |
|------|--------------|
| `invoiceNumber.trim()` is empty | "Tally invoice number is required." |
| `invoiceNumber` doesn't start with `expectedPrefix` | "Invoice number must start with `${expectedPrefix}` for this customer." |
| Customer has GSTIN AND `irn.trim().length > 0` AND `irn.trim().length !== 64` | "IRN must be exactly 64 characters if provided." |
| Customer has no GSTIN AND `irn.trim().length > 0` | "B-series (non-GST customer) must NOT have an IRN." |
| `invoiceDate` is empty | "Invoice date is required." |
| `amount` is not finite or `<= 0` | "Invoice amount must be positive." |
| `amount.toFixed(2) !== row.statement_total_amount.toFixed(2)` | "Amount ₹X does not match statement total ₹Y. Fix Tally or void+reissue — no override." |
| `pdfFile` is null | "Invoice PDF is required." |

### Server-side (`upload-gst-invoice/route.ts`)

| Rule | HTTP | Message |
|------|------|---------|
| `invoice_amount.toFixed(2) !== total_amount.toFixed(2)` | 422 | "Tally amount ₹X does not match statement total ₹Y..." |
| Customer has GSTIN but `tally_invoice_series !== 'SDIPL-REG'` | 422 | "Customer has GSTIN in CRM — must use A-series (SDIPL-REG) invoice with IRN." |
| Customer has no GSTIN but `tally_invoice_series !== 'SDIPL-UNREG'` | 422 | "Customer has no GSTIN in CRM — must use B-series (SDIPL-UNREG) invoice without IRN." |
| Series is SDIPL-REG AND `irn` is present AND `irn.length !== 64` | 422 | "IRN must be exactly 64 characters if provided." |
| Series is SDIPL-UNREG AND `irn` is not null | 422 | "B-series invoices must NOT carry an IRN." |
| `tally_invoice_number` doesn't start with `expectedPrefix` | 422 | "Invoice number "X" does not match expected Y prefix for series Z." |
| File type not in `['application/pdf', 'image/jpeg', 'image/png']` | 422 | "Only PDF / JPEG / PNG files are allowed." |
| `tally_handoff_v2_enabled` flag is false | 409 | "Tally handoff v2 is not enabled." |
| Role not `accounts` or `admin` | 403 | "Forbidden" |

### Empty-string vs null for IRN

**Critical gotcha:** The server normalises empty-string IRN to `null` before the DB CHECK:
```ts
if (!meta.irn?.trim()) meta.irn = null;
```
Without this, an empty-string `""` from the form would fail the DB CHECK `(tally_invoice_series = 'SDIPL-UNREG' AND irn IS NULL)` because `"" IS NOT NULL`. This normalisation must be preserved in any refactor.

### GSTIN format (client-side inline edit)

Regex: `/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/`

Applied when accounts edits the customer GSTIN inline from the inbox row. After save, it PATCHes `/api/leads/[leadId]` with `{ gst_number: val }`.

---

## Autofill Cascade

When accounts picks a PDF file (type `application/pdf`), the upload form automatically calls:
```
POST /api/billing-statements/[id]/extract-gst-invoice
```

Cascade layers:
1. **PDF text parse** (`src/lib/tally-pdf-extract.ts`): Uses `pdf-parse` (lazy-imported). Extracts:
   - Invoice number via regex `/SD\/(?:A|B)\/\d{2}-\d{2}\/\d+/i`
   - IRN via 4-strategy finder (label + hex, standalone 64-char hex, etc.)
   - GSTIN via `/\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2})\b/`
   - Date: tries `dd-MMM-yyyy` first, then `dd/mm/yyyy`
   - Amount: `/total\s+(?:invoice\s+)?(?:value|amount)[^\d]*([\d,]+\.\d{2})/i`
2. **Bridge cross-check**: If invoice number was extracted, checks `tally_voucher_snapshots` for a matching row. Sets `bridge_match: true` in response if found.
3. **Manual fallback**: If text parse fails (e.g. scanned image PDF), returns `source: 'manual'` and `fields: {}`. Upload form shows amber "Could not auto-extract" warning; accounts fills fields manually.

Image files (JPEG, PNG) skip extraction and go straight to `source: 'manual'`.

`maxDuration = 30` on the extract route (Vercel function timeout: 30 seconds for pdf-parse).

`extract-gst-invoice` is read-only — it never persists anything.

---

## Discrepancy Detection

Computed at query time in `GET /api/accounting/inbox` — not a DB column:

```ts
// Upload amount ≠ statement total
if (upload && Number(upload.invoice_amount).toFixed(2) !== Number(s.total_amount).toFixed(2)) {
  hasDiscrepancy = true;
  discrepancyReason = `Upload amount ₹${upload.invoice_amount} does not match statement total ₹${s.total_amount}`;
}
// OR: Tally bridge snapshot amount ≠ statement total
else if (snapshot && snapshot.voucher_amount != null &&
         Number(snapshot.voucher_amount).toFixed(2) !== Number(s.total_amount).toFixed(2)) {
  hasDiscrepancy = true;
  discrepancyReason = `Tally voucher amount ₹${snapshot.voucher_amount} does not match...`;
}
```

A discrepancy overrides the bucket to `"discrepancy"` and blocks "Save & send" (`canSend` is false when `has_discrepancy`). The row shows a red banner with the reason.

---

## Role Permissions

### Page access

`isInboxRole()` in `src/lib/tally-handoff.ts`:
```ts
INBOX_ROLES = ["accounts", "admin", "office_admin", "manager"]
```

Redirect to `/dashboard` if role not in this list. Checked on both the Server Component (page.tsx) and the GET /api/accounting/inbox route.

### Action permissions

| Action | Allowed roles |
|--------|--------------|
| View inbox page | `accounts`, `admin`, `office_admin`, `manager` |
| Upload GST invoice | `accounts`, `admin` |
| Save & send (inbox-send) | `accounts`, `admin` |
| Mark as done (inbox-complete) | `accounts`, `admin` |
| Resend GST invoice email | `accounts`, `admin` |
| Preview stamped PDF | `accounts`, `admin` |
| Extract/autofill (extract-gst-invoice) | All `isInboxRole` roles |
| Convert to GST early (PI cancel override) | `admin`, `manager` |
| SELECT on `gst_invoice_uploads` | `accounts`, `admin`, `office_admin`, `manager` |
| INSERT on `gst_invoice_uploads` | `accounts`, `admin` |
| SELECT on `tally_voucher_snapshots` | `accounts`, `admin`, `office_admin`, `manager` |
| Write to `tally_voucher_snapshots` | Service role only (bridge) |

---

## Inbox API: `GET /api/accounting/inbox`

### Query parameters

| Param | Values | Effect |
|-------|--------|--------|
| `tab` | `'open'` (default) or `'closed'` | Open: rows where `handoff_state IN (INBOX_OPEN_STATES)`. Closed: `handoff_state = 'complete' OR voided_at IS NOT NULL`. |
| `q` | Any string | JS post-filter across statement number, GST invoice number, Tally invoice number, contract number, title, customer GSTIN, name, email |
| `id` | UUID | Single-row mode: returns exactly that statement regardless of state. Used by lifecycle badge / contract page deep links. |
| `page` | integer (default 1) | Only honored for `tab=closed`. Page size = 50. |
| `include` | `'timeline'` | Only honored with `?id=`. Returns `timeline_events[]` synthesized from audit_trail, billing_payments, gst_invoice_uploads. |

### `?focus=<statement_id>` URL parameter (not an API param)

On the client, the inbox reads `window.location.search` for `?focus=`. It scrolls the matching row into view and briefly adds a blue ring highlight. Does not auto-expand the upload form.

### Response shape

```ts
{
  stats: { gst_to_issue, payments_to_record, discrepancies, aging_over_48h, total_open },
  rows: InboxRow[],
  last_synced_at: string | null,  // most recent tally_voucher_snapshots.last_synced_at
  has_more?: boolean,             // closed tab pagination
}
```

### Performance

Four sub-queries (uploads, snapshots, last sync, payments) run in parallel via `Promise.all`. The index `idx_billing_payments_billing_statement_id` (migration 00256) was added specifically to speed up the inbox.

### Aging calculation

`aging_hours = Math.round((Date.now() - Date.parse(updated_at)) / 3_600_000)`. Uses `billing_statements.updated_at` as the reference. Escalation threshold: `AGING_ESCALATE_HOURS = 48`.

---

## Inbox Worklist UI

### Stat cards
- GST to issue (blue)
- Payments to record (green)
- Discrepancies (red, `variant="danger"`)
- Aging > 48h (amber, `variant="warning"`)

### Filter tabs
- All open / GST to issue / Payments / Discrepancies / Closed
- Client-side filter on `visibleRows` for most tabs; "Closed" tab re-fetches with `tab=closed`.
- Closed tab has cursor-style pagination (Prev / Next buttons, page stored in `closedPage` state).

### Search
- Debounced 300ms input → `searchTerm` → triggers re-fetch
- Searches: statement number, GST invoice number, Tally invoice number, contract number, title, customer GSTIN, company name, first/last name, email

### Per-row actions (shown conditionally)

| Button | Condition |
|--------|-----------|
| View PI | Always (links to `/api/billing-statements/[id]/proforma-pdf`) |
| View GST | When `hasUpload` (links to `/api/billing-statements/[id]/gst-invoice-pdf`) |
| Upload ▼ | When `handoff_state IN ('pi_paid_awaiting_gst', 'direct_gst_requested')` AND not closed |
| Save & send | When `handoff_state === 'ready_to_send'` AND `!has_discrepancy` |
| Mark as done | When `handoff_state IN ('gst_sent', 'gst_sent_awaiting_payment', 'paid_awaiting_receipt_record')` |
| Resend email | When `handoff_state === 'complete'` AND `latest_upload !== null` |

### Lifecycle tracker

Each row renders an `InboxRowLifecycleTracker` that shows a 5-step visual pipeline. The steps differ by flow:
- **PI-first**: PI Sent → Payment Received → GST in Tally → Invoice Sent → Done
- **Override** (`pi_was_cancelled`): PI Cancelled → GST in Tally → Link + Email Sent → Payment Received → Done
- **GST Direct**: GST Requested → GST in Tally → Invoice + Link Sent → Payment Received → Done

Steps are coloured: green = done, blue = current, grey = pending.

### Bridge status pill

Derived from `latest_snapshot` and `has_discrepancy`:
- `has_discrepancy` → "Tally: drift" (red)
- `latest_snapshot.match_confidence === 'exact'` → "Tally: matched" (green)
- `latest_snapshot` present but not exact → "Tally: partial" (amber)
- No snapshot → "Tally: not synced" (grey)

---

## Email Notifications

### Intimation emails to accounts

Sent fire-and-forget from `setHandoffState` for these transitions only:

| Target state | Subject verb |
|-------------|-------------|
| `pi_paid_awaiting_gst` | "Payment received — please issue GST invoice in Tally" |
| `direct_gst_requested` | "New direct GST invoice request" |
| `paid_awaiting_receipt_record` | "Payment received — please record receipt in Tally" |

Email goes to `EMAIL_REPLY_TO` (the accounts inbox address). Contains: customer name, contract number, statement number, amount, and a link to `/accounting/inbox`.

### GST invoice email to customer

Sent from `upload-gst-invoice` (auto-send for unpaid statements) or `inbox-send` (manual "Save & send"):
- From: `EMAIL_FROM`
- To: `lead.email`
- BCC: `EMAIL_REPLY_TO`
- Reply-To: `EMAIL_REPLY_TO`
- Attachment: stamped PDF
- Subject: `Tax Invoice {invoiceNumber} — {contractNumber} — The WorkVilla`
- Body varies: unpaid → payment options + Razorpay link; paid → "for your records" receipt message

If `lead.email` is null, `inbox-send` returns HTTP 422. `upload-gst-invoice` skips email silently for statements without email.

### Daily digest

`GET /api/cron/inbox-digest` runs daily at 09:30 IST (04:00 UTC, per `vercel.json`). Protected by `CRON_SECRET`. Skips silently if v2 disabled or no open items. Sends a summary table to `EMAIL_REPLY_TO`.

---

## Razorpay Payment Link Creation

Created automatically in `upload-gst-invoice` for unpaid statements:
- Amount: `Math.round(totalAmount * 100)` paise
- `reference_id`: `{invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}-gst`
- Expires: 30 days
- `reminder_enable: true`
- `notify`: SMS if phone present, email if email present
- Notes: `{ statement_id, contract_number, gst_invoice }` (for webhook reconciliation)
- `callback_url`: `{APP_URL}/billing`

Razorpay credentials are fetched at runtime from `app_settings` keys `razorpay_enabled`, `razorpay_key_id`, `razorpay_key_secret`, `upi_id`. Not from env vars.

---

## PDF Stamping

Before storing, uploaded PDFs go through `stampSignatureOnPdf()` from `src/lib/uploads/stamp-pdf-signature.ts`. This function adds the company signature and seal to the PDF.

`preview-gst-stamp` lets accounts preview the stamped result before submitting. It accepts only `application/pdf`, max 50 MB, returns `Content-Disposition: inline; filename="preview-stamped.pdf"`. Opens in a new tab via `URL.createObjectURL`.

---

## Storage

Uploaded PDFs are stored in the `crm-documents` Supabase Storage bucket at:
```
tally-handoff/{contract_id}/{timestamp}-{safe_invoice_number}.{ext}
```

Where `safe_invoice_number = tally_invoice_number.replace(/[^\w-]/g, "_")`.

The path is stored in `gst_invoice_uploads.invoice_pdf_url`.

---

## Integration Points with Other Modules

| Trigger | Module | Effect on Inbox |
|---------|--------|-----------------|
| Monthly billing cron finalizes statement | `src/lib/billing.ts` | Calls `handleStatementFinalized`. For `gst_direct`: sets `direct_gst_requested`. For `proforma_first`: returns `skipLegacyDispatch: false` (no inbox action at this point). |
| Razorpay `payment_link.paid` webhook | `src/app/api/payments/webhook/route.ts` | Calls `handleStatementPaid`. Routes to `pi_paid_awaiting_gst` or `paid_awaiting_receipt_record` based on `billing_mode`. |
| Manual payment entry | `src/app/api/billing-statements/[id]/payment/route.ts` | On full payment (v2 enabled), calls `handleStatementPaid`. |
| Tally bridge sync-pull | `src/app/api/tally/sync-pull/route.ts` | Upserts `tally_voucher_snapshots`. For receipt vouchers matching a `paid_awaiting_receipt_record` statement, calls `setHandoffState(..., 'complete', 'bridge_receipt_verified')`. |
| Convert to GST early | `src/app/api/billing-statements/[id]/convert-to-gst-early/route.ts` | Sets `direct_gst_requested`, cancels Razorpay PI link. |
| Lead GSTIN update (inline in inbox) | `PATCH /api/leads/[id]` | Updates `leads.gst_number`. Triggers row refresh. Changes which series/prefix will be expected on the next upload. |

### Legacy path (v2 disabled)

When `tally_handoff_v2_enabled = 'false'`:
- Payment capture: triggers CRM-side GST invoice generation instead of `handleStatementPaid`
- Monthly cron: calls legacy bridge-writer dispatch
- Manual payment route: calls `enqueueTallyReceiptVoucher` for bridge receipt sync
- `handoff_state` stays `NULL` on all statements

---

## Known Pitfalls and Gotchas

### IRN empty-string vs null
The single biggest source of potential future bugs: an empty `irn` input `""` must be normalised to `null` before the DB INSERT. The server does this. If any future route inserts into `gst_invoice_uploads` without this normalisation, the `gst_invoice_uploads_irn_matches_series` CHECK will fail with a cryptic Postgres error for B-series invoices. The relevant line in `upload-gst-invoice`:
```ts
if (!meta.irn?.trim()) meta.irn = null;
```

### RLS bug history (migration 00263)
The original RLS policies (migration 00255) used `users.id = auth.uid()`. This was wrong: `users.id` is the internal PK (a UUID different from the auth UUID); `auth.uid()` returns the `auth.users.id`. The correct column is `users.auth_id`. Migration 00263 fixed this and also enabled the feature flag. If you see "no rows returned" when accounts queries gst_invoice_uploads despite being logged in, check that `users.auth_id` is populated and matches `auth.uid()`.

### IRN constraint history (migration 00265)
The original constraint (00255) required `irn IS NOT NULL AND length(irn) = 64` for SDIPL-REG. This blocked valid uploads where Tally's PDF didn't expose the IRN as text (only in the QR code). Migration 00265 relaxed this. If testing locally against an old migration state, IRN will be required even when absent — apply 00265.

### Discrepancy computed at query time
`has_discrepancy` is not stored in the DB. It is computed on every `GET /api/accounting/inbox` response by comparing upload amount vs statement total and snapshot amount vs statement total. If you add logic that writes `invoice_amount` somewhere, make sure it stays in sync with `total_amount`.

### D3 gate split update
In `dispatch-tally-invoice.ts` (legacy bridge path), the `tally_delivered_at` gate is written in a separate `update` call before the metadata update. This is intentional: if the metadata update fails (e.g. unknown column), the gate is already closed so no retry will double-send. Do not collapse these two updates.

### `pi_was_cancelled` flag
`InboxRow.pi_was_cancelled` is derived from `billing_statements.pi_cancelled_at IS NOT NULL`. It determines which lifecycle tracker flow variant to show (Override vs PI-first). Statements that went through `convert-to-gst-early` have this set.

### Closed tab pagination (off-by-one)
The closed tab queries `page * CLOSED_PAGE_SIZE + 1` rows (one extra sentinel) to detect `has_more`, then slices the response. If you refactor the pagination, preserve this sentinel pattern.

### `uploaded_by` references `auth.users(id)`, not `users(id)`
`gst_invoice_uploads.uploaded_by` is a FK to `auth.users(id)`, not to the CRM's `users.id`. When displaying the uploader's name, you'd need to join `auth.users` or cross-reference `users.auth_id`. This is intentional (mirrors the pattern in other audit tables), but easy to confuse.

### "Save & send" vs auto-send
For unpaid statements, `upload-gst-invoice` auto-sends the email immediately after upload AND creates the Razorpay link. If email fails, it returns `email_warning` in the body (HTTP 200, not an error), leaves state at `ready_to_send`, and the "Save & send" button becomes available for retry. This means the invoice is already uploaded (state = ready_to_send) but the email hasn't gone out yet.

### `inbox-send` blocks re-dispatch via `tally_delivered_at`
Once `tally_delivered_at` is set (by `inbox-send`), calling `inbox-send` again returns HTTP 409. The `resend-gst-invoice` route bypasses this check intentionally — it is designed for explicit resends and logs every attempt to `audit_trail`.

---

## Environment / Config Dependencies

| Key | Source | Used for |
|-----|--------|---------|
| `tally_handoff_v2_enabled` | `app_settings` table | Master gate for all handoff v2 logic |
| `razorpay_enabled` | `app_settings` | Razorpay link creation on upload |
| `razorpay_key_id` | `app_settings` | Razorpay auth |
| `razorpay_key_secret` | `app_settings` | Razorpay auth |
| `upi_id` | `app_settings` | Shown in email payment options |
| `NEXT_PUBLIC_APP_URL` / `APP_URL` | env var | Links in intimation emails, Razorpay callback URL |
| `CRON_SECRET` | env var | Auth header for `/api/cron/inbox-digest` |
| `RESEND_API_KEY` | env var | Transactional email via Resend |

---

## Step-by-Step User Flows

### Flow A: Normal PI-first (most common)

1. Monthly billing cron finalizes a `proforma_first` contract's statement → sends proforma to customer (legacy dispatch unchanged). `handoff_state` stays `NULL` at this point.
2. Customer pays via Razorpay link → webhook fires `handleStatementPaid` → `handoff_state = 'pi_paid_awaiting_gst'` → intimation email sent to accounts.
3. Accounts sees row in "GST to issue" bucket. Clicks "Upload ▼".
4. Inline form expands. PDF is picked → autofill runs (`extract-gst-invoice`) → fields prefill.
5. Accounts reviews fields (invoice number, IRN if applicable, date, amount), verifies all correct.
6. Optionally clicks "Preview stamped" to see the signature-stamped PDF in a new tab.
7. Clicks "Save upload" → `POST /upload-gst-invoice`:
   - Validates amount equality, series/GSTIN parity, IRN length
   - Stamps PDF, uploads to `crm-documents/tally-handoff/{contract_id}/...`
   - Inserts `gst_invoice_uploads` row with `name_check_status = 'approved'`
   - Mirrors numbers onto `billing_statements`
   - Sets `handoff_state = 'ready_to_send'`
   - Since `payment_status = 'paid'`, skips Razorpay link + email
   - Returns `handoff_state: 'ready_to_send'`
8. Row now shows "Save & send" button. Accounts clicks it → `POST /inbox-send`:
   - Checks `tally_delivered_at IS NULL` (D3 gate)
   - Confirms `handoff_state === 'ready_to_send'`
   - Fetches non-superseded upload, downloads PDF from storage
   - Sends email with PDF attachment: subject "GST tax invoice X — receipt" (since paid)
   - Stamps `tally_delivered_at`, `lifecycle_stage = 'sent'`, `status = 'exported'`
   - Since `payment_status = 'paid'`, `nextState = 'complete'`
9. Row moves to "Closed" tab.

### Flow B: GST Direct (unpaid after invoice)

1. Monthly cron finalizes a `gst_direct` statement → `handleStatementFinalized` sets `handoff_state = 'direct_gst_requested'` and returns `skipLegacyDispatch: true` (no proforma sent). Intimation email to accounts.
2. Accounts sees row in "GST to issue" bucket. Uploads GST invoice as in Flow A.
3. On upload: since `payment_status !== 'paid'`, `upload-gst-invoice` creates Razorpay link + emails customer (with Razorpay "Pay Now" button). Sets `handoff_state = 'gst_sent_awaiting_payment'`.
4. Row shows "Mark as done" button. Customer pays (webhook fires `handleStatementPaid` → `paid_awaiting_receipt_record`).
5. Accounts records receipt in Tally. Bridge sync-pull verifies it → auto-completes.
6. Or: accounts clicks "Mark as done" to manually close.

### Flow C: Override (convert-to-gst-early)

1. Admin/manager notices customer needs GST invoice before they've paid the PI.
2. On the billing page, clicks "Convert to GST early", provides a reason (min 5 chars).
3. `convert-to-gst-early` route: cancels existing Razorpay PI link, sets `pi_cancelled_at`, sets `handoff_state = 'direct_gst_requested'`.
4. Row appears in inbox "GST to issue". Proceed as in Flow B.

### Flow D: Resend (completed row)

1. Customer complains they didn't receive the invoice.
2. Accounts finds the row in "Closed" tab (search by customer name or invoice number).
3. Clicks "Resend email" → `POST /resend-gst-invoice`:
   - Fetches non-superseded upload, downloads PDF
   - Sends same email again
   - Updates `gst_invoice_sent_at`, `gst_invoice_sent_to`
   - Logs to `audit_trail` with `action = 'email_resent'`
4. Row shows "Sent successfully" momentarily.
