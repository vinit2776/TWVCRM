# Billing

## Purpose and Business Context

The Billing module is the accounts-receivable engine for The WorkVilla. It manages the complete monthly revenue cycle for all active coworking contracts:

1. **Advance rent collection** — proforma invoice for the *next* month's rent is sent at the end of the current month, before services are rendered (prepaid model).
2. **Usage billing** — meeting room overages, ad-hoc charges (printing, damages, etc.), facility usage overages, and service overages are rolled up into a usage statement for the *current* month.
3. **Payment tracking** — manual and Razorpay online payments are recorded against statements.
4. **GST tax invoice issuance** — official tax invoice is generated and emailed after payment is confirmed (proforma-first flow) or immediately (gst_direct flow).
5. **Accounting close** — statements are marked "accounted" once booked in Tally, closing the receivables loop.

The module is at `/billing` (page title: "Billing — Acc Receivables"). It also exposes accounting sub-views (walk-in collections, cash handovers, GST invoice list, refunds, retained payments, electricity bills) under the same page via section/tab navigation.

---

## Routes

### `/billing` (only page)

**File:** `src/app/(dashboard)/billing/page.tsx` — this is a single "use client" page that renders everything via tabs.

**URL tab parameter:** `?tab=<value>` — the tab is read from `window.location.search` on mount. The legacy `?tab=contracts` is silently redirected to `statements`.

**Three top-level sections (section selector buttons):**

| Section key | Label | Sub-tabs |
|---|---|---|
| `receivables` | Pre-invoice | `proposals`, `usage-charges` |
| `collections` | Collections | `walkin`, `cash`, `refunds` |
| `invoicing` | Invoicing | `statements`, `gst`, `retained-payments`, `electricity` |

**The primary billing workflow lives under `invoicing → statements` tab**, rendered by `<MonthlyBillingTabs>` component with a **Rent** sub-tab and a **Usage** sub-tab.

There is no separate `/billing/[id]` detail page — individual statements are viewed in-place via `<ViewStatementDialog>` (a modal).

---

## Key Source Files

### Pages and Components

| File | Purpose |
|---|---|
| `src/app/(dashboard)/billing/page.tsx` | Main billing page — all state, dialogs (record payment, void), tab navigation |
| `src/components/billing/monthly-billing-tabs.tsx` | Rent tab + Usage tab; primary operator workflow; calls `finalize-and-send` |
| `src/components/billing/proforma-billing-card.tsx` | "Monthly Rent Proforma" card — preview mode + live batch run |
| `src/components/billing/view-statement-dialog.tsx` | Statement detail modal (line items, payments, actions) |
| `src/components/billing/billing-lifecycle-status.tsx` | Status badge + next-action hint for a statement |
| `src/components/billing/billing-pipeline-bar.tsx` | Horizontal stage bar showing count/amount per stage |
| `src/components/billing/add-usage-charge-dialog.tsx` | Add ad-hoc charge (creates `usage_charge` row) |
| `src/components/billing/usage-review-dialog.tsx` | Per-contract usage review before finalizing |
| `src/components/billing/convert-to-gst-early-dialog.tsx` | PI → early GST override dialog (admin/manager) |
| `src/components/billing/electricity-bills-tab.tsx` | Electricity sub-billing tab |
| `src/components/billing/tally-status-badge.tsx` | Tally sync status badge on rent statements |
| `src/components/billing/billing-lifecycle-flow.tsx` | Visual lifecycle diagram |
| `src/components/billing/billing-mode-tag.tsx` | `proforma_first` / `gst_direct` label badge |
| `src/components/accounting/contract-accounting-row.tsx` | Per-contract row in the legacy Contracts tab |
| `src/components/accounting/manual-print-entry-dialog.tsx` | Log print usage (creates usage_charge) |

### API Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/billing-statements` | GET | List statements (paginated); filters: `contract_id`, `booking_id`, `lead_id`, `status`, `statement_type` |
| `/api/billing-statements` | POST | Create a statement manually (Zod validated) |
| `/api/billing-statements/[id]` | GET | Fetch single statement with charges, facility, service, booking sub-items, and payment history |
| `/api/billing-statements/[id]` | PATCH | Finalize (`status: finalized`), export (`status: exported`), revert to draft (`action: revert_to_draft`), mark accounted (`accounted: true`), update notes |
| `/api/billing-statements/[id]/payment` | GET | List payments for a statement |
| `/api/billing-statements/[id]/payment` | POST | Record a manual payment (supports TDS split) |
| `/api/billing-statements/[id]/send-proforma` | POST | Finalize + dispatch proforma OR gst_direct invoice; routes by `billing_mode` |
| `/api/billing-statements/[id]/finalize-and-send` | POST | Atomic: finalize draft → dispatch proforma (rolls back to draft if dispatch fails) |
| `/api/billing-statements/[id]/generate-gst-invoice` | POST | Generate GST invoice PDF + email after payment; supports `skipAuth` for webhook calls |
| `/api/billing-statements/[id]/void` | POST | Void finalized/exported statement + create replacement draft |
| `/api/billing-statements/[id]/cancel-tally` | POST | Cancel a Tally-issued invoice (credit note path) |
| `/api/billing-statements/[id]/add-charge` | POST | Add ad-hoc charge to a draft statement (uses `add_statement_charge_atomic` RPC) |
| `/api/billing-statements/[id]/waive-charge` | POST | Waive/un-waive a usage charge on a draft statement |
| `/api/billing-statements/[id]/proforma-pdf` | POST | Download proforma PDF |
| `/api/billing-statements/[id]/gst-invoice-pdf` | GET | Download GST invoice PDF |
| `/api/billing-statements/[id]/gst-invoice-email` | POST | Resend GST invoice email |
| `/api/billing-statements/[id]/resend-gst-invoice` | POST | Re-dispatch an existing GST invoice |
| `/api/billing-statements/[id]/upload-gst-invoice` | POST | Upload a Tally-generated GST invoice PDF (v2 handoff flow) |
| `/api/billing-statements/[id]/extract-gst-invoice` | POST | Extract data from uploaded GST invoice PDF |
| `/api/billing-statements/[id]/preview-gst-stamp` | POST | Preview the QR/stamp overlay before upload |
| `/api/billing-statements/[id]/send-reminder` | POST | Send payment reminder to customer |
| `/api/billing-statements/[id]/convert-to-gst-early` | POST | PI override request (admin/manager only): cancels PI + Razorpay link, sets `handoff_state = direct_gst_requested` for Tally inbox — does NOT generate or send a GST invoice |
| `/api/billing-statements/[id]/inbox-send` | POST | v2 handoff: send from accounts inbox |
| `/api/billing-statements/[id]/inbox-complete` | POST | v2 handoff: mark complete |
| `/api/billing-statements/[id]/tally-retry` | POST | Retry a failed Tally sync job |
| `/api/billing-statements/[id]/confirm` | POST | Confirm a statement |
| `/api/billing-statements/pipeline` | GET | Per-stage counts/amounts for a month (used by `BillingPipelineBar`) |
| `/api/billing/auto-generate` | GET | DISABLED — returns 200 with `disabled: true`; billing is now manual-only |
| `/api/billing/auto-generate` | POST | Manual trigger: generates rent proformas and/or usage statement drafts |
| `/api/billing/usage-rollup` | GET | Usage rollup for a month |
| `/api/billing/usage-finalize-and-send-for-contract` | POST | Finalize + send usage statement for a single contract |
| `/api/billing/pending-carryforward` | GET | List pending carry-forward balances |
| `/api/billing/waive-carryforward-services` | POST | Waive carry-forward service charges |
| `/api/cron/billing-proforma-dispatch` | GET | Cron: auto-dispatch proformas on last day of month (CRON_SECRET header) |
| `/api/cron/billing-reminder` | GET | Cron: payment reminders (does NOT auto-bill) |

### Lib Files

| File | Purpose |
|---|---|
| `src/lib/billing.ts` | Core generators: `generateRentProformas()`, `generateUsageStatements()`, `generateMonthlyStatements()` (deprecated) |
| `src/lib/send-proforma.ts` | `dispatchProforma()` and `dispatchGstDirect()` — Razorpay link + PDF + email dispatch |
| `src/lib/gst-invoice-generator.ts` | jsPDF-based GST invoice PDF generation |
| `src/lib/pdf-generator.ts` | Proforma PDF generation |
| `src/lib/billing-pdf-utils.ts` | `resolveLineItemQty()`, `resolveLineItemRate()` for PDF line items |
| `src/lib/gst-math.ts` | `computeGstAndRounding()` — canonical GST split calculation |
| `src/lib/tally-handoff-server.ts` | `handleStatementFinalized()`, `handleStatementPaid()`, `isHandoffV2Enabled()` |
| `src/lib/tally/enqueue.ts` | `routeGstGenerationToTally()`, `isCrmGstEnabled()`, `isTallyIssuanceActive()` |
| `src/lib/audit.ts` | `logAudit()` — fire-and-forget audit trail |
| `src/lib/mailer.ts` | Resend email client (EMAIL_FROM, EMAIL_REPLY_TO) |

---

## Data Model

### `billing_statements` (primary table)

**Number format:** `TWV-BS-NNNN` (sequential auto-trigger `generate_statement_number()`).

**Key columns:**

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `statement_number` | VARCHAR(50) UNIQUE | Auto-generated `TWV-BS-NNNN` |
| `contract_id` | UUID NOT NULL FK → contracts | RLS: ON DELETE RESTRICT |
| `lead_id` | UUID NOT NULL FK → leads | RLS: ON DELETE RESTRICT |
| `booking_id` | UUID FK → bookings | Set for booking-only (non-contract) statements |
| `period_start` | DATE NOT NULL | First day of billing period |
| `period_end` | DATE NOT NULL | Last day of billing period |
| `due_date` | DATE | Payment due date; set to `period_end + 7 days` for usage statements, `send_date + 7 days` for rent statements |
| `statement_type` | TEXT | `combined` (legacy), `rent` (auto-dispatched), `usage` (admin-reviewed), `electricity` |
| `fixed_amount` | DECIMAL(12,2) | Prepaid rent subtotal |
| `usage_amount` | DECIMAL(12,2) | Ad-hoc charges + facility usage subtotals |
| `service_usage_amount` | DECIMAL(12,2) | Printer/service overage subtotal |
| `booking_usage_amount` | DECIMAL(12,2) | Meeting room booking subtotal |
| `subtotal` | DECIMAL(12,2) | Sum of all amounts before tax |
| `tax_percentage` | DECIMAL(5,2) | Locked from `contracts.tax_percentage` at generation time — never recalculated |
| `tax_amount` | DECIMAL(12,2) | GST (CGST+SGST or IGST) |
| `total_amount` | DECIMAL(12,2) | subtotal + tax_amount |
| `cgst_amount` | DECIMAL(12,2) | Central GST component |
| `sgst_amount` | DECIMAL(12,2) | State GST component |
| `igst_amount` | DECIMAL(12,2) | Integrated GST (always 0 — place of supply is always Tamil Nadu) |
| `is_interstate` | BOOLEAN | Always false (TWV services rendered in TN) |
| `buyer_gstin` | TEXT | Customer GSTIN from `leads.gst_number` |
| `place_of_supply` | TEXT | Always `"Tamil Nadu"` |
| `status` | TEXT | `draft`, `finalized`, `exported`, `voided` (note: enum was `billing_statement_status` but `voided` was added as TEXT, not in original enum) |
| `payment_status` | TEXT | `unpaid`, `partially_paid`, `paid` |
| `payment_mode` | TEXT | Payment mode values: `neft`, `rtgs`, `upi`, `cheque`, `cash`, `razorpay` |
| `line_items` | JSONB | Structured invoice breakdown — see Line Items Schema below |
| `prepaid_month` | INTEGER | Which month the rent covers (1-12), null for usage statements |
| `prepaid_year` | INTEGER | Which year the rent covers, null for usage statements |
| `gst_invoice_number` | TEXT | Sequential `TWV/INV/YY-YY/NNNN` format |
| `gst_invoice_path` | TEXT | Supabase storage path `invoices/<number>.pdf` |
| `razorpay_payment_link_id` | TEXT | Razorpay payment link ID |
| `razorpay_payment_link_url` | TEXT | Full payment link URL for customer |
| `proforma_sent_at` | TIMESTAMPTZ | When proforma was dispatched to customer |
| `proforma_sent_by` | UUID FK → users | |
| `finalized_at` | TIMESTAMPTZ | |
| `finalized_by` | UUID FK → users | |
| `exported_at` | TIMESTAMPTZ | |
| `gst_generated_by` | UUID FK → users | |
| `accounted` | BOOLEAN | |
| `accounted_at` | TIMESTAMPTZ | |
| `accounted_by` | UUID FK → users | |
| `emailed_at` | TIMESTAMPTZ | When proforma/GST email was sent |
| `emailed_to` | TEXT | Which email address |
| `voided_at` | TIMESTAMPTZ | |
| `voided_by` | UUID FK → users | |
| `void_reason` | TEXT | Required to void |
| `voided_statement_id` | UUID FK → billing_statements | Back-reference to voided original (on replacement draft) |
| `pi_cancelled_at` | TIMESTAMPTZ | Set when PI is overridden by early GST invoice |
| `pi_cancelled_by` | UUID FK → users | |
| `pi_override_reason` | TEXT | |
| `gst_invoice_due_date` | DATE | Override due date for early-issued GST invoices |
| `last_reminder_sent_at` | TIMESTAMPTZ | Reminder throttle (no two sends within 48h) |
| `reminder_count` | INT DEFAULT 0 | Reset on payment_status=paid |
| `issuance_channel` | TEXT NOT NULL DEFAULT 'crm' | `crm` or `tally` — stamped at GST-generation moment, never changes |
| `tally_delivered_at` | TIMESTAMPTZ | When Tally delivered the invoice to customer |
| `lifecycle_stage` | TEXT | Tally-side: `queued`, `issuing`, `awaiting_irn`, `issued`, `sent`, `failed` |
| `tally_invoice_number` | TEXT | Mirrored from Tally |
| `handoff_state` | TEXT | v2 handoff workflow state (see below) |
| `created_via` | TEXT | `cron`, `ad_hoc_request`, `manual_correction`, `legacy` |
| `accounting_period_id` | UUID FK → accounting_periods | |
| `notes` | TEXT | |

**`statement_type` CHECK constraint:** `CHECK (statement_type IN ('combined', 'rent', 'usage'))` — note `'electricity'` is in the TypeScript type but not in the DB CHECK (added later without migration update, handle carefully).

**`handoff_state` CHECK constraint:**
```sql
CHECK (handoff_state IS NULL OR handoff_state IN (
  'pi_awaiting_payment', 'pi_paid_awaiting_gst', 'direct_gst_requested',
  'name_check_pending', 'ready_to_send', 'gst_sent', 'gst_sent_awaiting_payment',
  'paid_awaiting_receipt_record', 'complete'
))
```

**`issuance_channel` CHECK constraint:** `CHECK (issuance_channel IN ('crm', 'tally'))`

**`lifecycle_stage` CHECK constraint:** `CHECK (lifecycle_stage IS NULL OR lifecycle_stage IN ('queued', 'issuing', 'awaiting_irn', 'issued', 'sent', 'failed'))`

**RLS:** Enabled. All authenticated users can SELECT, INSERT, UPDATE. Admin-only operations (void) are enforced at the API layer, not RLS.

**Indexes of note:**
- `idx_billing_statements_ar_aging` on `(payment_status, due_date)` WHERE `payment_status IN ('unpaid', 'partially_paid')` — AR aging queries
- `billing_statements_type_period_idx` on `(contract_id, statement_type, period_start)` — idempotency queries in generators
- `idx_billing_statements_prepaid` on `(prepaid_year, prepaid_month)` WHERE `prepaid_month IS NOT NULL`
- `idx_billing_statements_handoff_state` WHERE `handoff_state IS NOT NULL AND handoff_state <> 'complete'`

### `billing_payments`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `billing_statement_id` | UUID NOT NULL FK → billing_statements | ON DELETE RESTRICT |
| `amount` | DECIMAL(12,2) NOT NULL | CHECK (amount > 0) |
| `payment_date` | DATE NOT NULL | |
| `payment_mode` | TEXT NOT NULL | `neft`, `rtgs`, `upi`, `cheque`, `razorpay`, `cash` |
| `payment_reference` | TEXT | UTR or cheque number |
| `razorpay_payment_id` | TEXT | Set by webhook |
| `proof_path` | TEXT | Supabase storage path |
| `notes` | TEXT | |
| `tds_amount` | DECIMAL(12,2) DEFAULT 0 | Customer TDS deduction |
| `tds_section` | TEXT | e.g. `194I` |
| `recorded_by` | UUID FK → users | |
| `created_at` | TIMESTAMPTZ | |

**TDS settlement math:** Invoice settles when `SUM(amount) + SUM(tds_amount) >= total_amount`. The cash receipt and TDS deduction together cover the invoice total.

**RLS:** Enabled. All authenticated users can read and insert. Payment recording is role-gated at the API layer.

### `usage_charges`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `contract_id` | UUID NOT NULL FK → contracts | |
| `lead_id` | UUID NOT NULL FK → leads | |
| `description` | VARCHAR(500) NOT NULL | |
| `quantity` | DECIMAL(10,2) DEFAULT 1 | |
| `unit_price` | DECIMAL(12,2) NOT NULL | |
| `total` | DECIMAL(12,2) NOT NULL | quantity × unit_price |
| `gst_rate` | DECIMAL | GST rate applied; forced to match statement's `tax_percentage` when added to a statement |
| `gst_amount` | DECIMAL | GST amount |
| `total_with_gst` | DECIMAL | Total including GST |
| `charge_date` | DATE NOT NULL | |
| `status` | `usage_charge_status` | `pending`, `billed`, `waived` |
| `billing_statement_id` | UUID FK → billing_statements | ON DELETE SET NULL — unlinked on void |
| `notes` | TEXT | |
| `proof_path` | TEXT | |
| `settled_in_booking_id` | UUID FK → bookings | |
| `waived_by` | UUID FK → users | |
| `waived_at` | TIMESTAMPTZ | |
| `waive_reason` | TEXT | |
| `booking_id` | UUID FK → bookings | If created from a booking |
| `created_by` | UUID FK → users | |

**Status transitions:**
- `pending` → `billed` (when picked up by generator or added to a statement)
- `pending` → `waived` (admin/manager)
- `billed` → `pending` (when statement is voided — generator then can repick up)
- `waived` → `pending` (un-waive)

### `accounting_periods`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `year` | INTEGER | |
| `month` | INTEGER | 1-12 |
| `status` | TEXT | `open`, `locked` |
| `locked_at` | TIMESTAMPTZ | |
| `locker` | joined user | |

Periods are created on-demand by billing generators (`ensureAccountingPeriod()`). Locking a period prevents mutations (enforced at the API layer, not DB).

### `line_items` JSONB Schema

```json
[
  {
    "type": "prepaid_rent" | "booking_usage" | "ad_hoc_charges" | "facility_usage" | "service_usage",
    "label": "string (human readable section header)",
    "items": [
      {
        // prepaid_rent items:
        "description": "Monthly rent (N seats)",
        "amount": 12000,
        "note": "Pro-rated N/M days"  // optional

        // booking_usage items:
        "booking_id": "uuid",
        "booking_number": "TWV-B-XXXX",
        "date": "2026-05-15",
        "space": "Conference Room A",
        "time": "10:00–12:00",
        "duration": "2h",
        "amount": 2000,
        "note": "Free quota"  // optional, shows ₹0

        // ad_hoc_charges items:
        "usage_charge_id": "uuid",
        "description": "Print - B/W",
        "quantity": 50,
        "unit_price": 2,
        "amount": 100

        // service_usage items:
        "service_usage_id": "uuid",
        "service_id": "uuid",
        "description": "Print - Colour",
        "qty": 10,
        "unit_price": 5,
        "amount": 50
      }
    ],
    "subtotal": 12000
  }
]
```

---

## Statement Lifecycle

### Status Machine

```
draft
  │ PATCH {status: "finalized"}              (any authenticated)
  │ POST /finalize-and-send                  (admin/manager/accounts)
  ↓
finalized
  │ POST /send-proforma                      (admin/manager/accounts)
  │   → proforma dispatched (stamps proforma_sent_at)
  │   → razorpay_payment_link_url set
  │ PATCH {action: "revert_to_draft"}        (admin/manager only)
  ↓ PATCH {status: "exported"} OR
  ↓ POST /generate-gst-invoice               (admin/manager/accounts or webhook)
exported
  │ (already has gst_invoice_number)
  ↓
voided  ← POST /void  (admin only; blocked if payments exist; blocked if issuance_channel='tally')
  └─ creates new "draft" replacement with voided_statement_id back-reference
```

**payment_status transitions:**
```
unpaid → partially_paid  (some payment received; SUM < total)
unpaid OR partially_paid → paid  (SUM(amount + tds_amount) >= total_amount)
```

**Lifecycle stages (derived, used in BillingLifecycleStatus component):**

| Stage | Condition |
|---|---|
| `voided` | `status === 'voided'` |
| `draft` | `status === 'draft'` |
| `finalized` | `status === 'finalized'` AND no proforma sent |
| `proforma_sent` | finalized AND `proforma_sent_at` set AND no payment AND no GST |
| `partially_paid` | finalized AND `payment_status === 'partially_paid'` AND no GST |
| `paid` | finalized AND `payment_status === 'paid'` AND no GST |
| `gst_override_unpaid` | finalized AND GST exists AND `pi_cancelled_at` set (early PI cancel) |
| `gst_direct_unpaid` | finalized AND GST exists AND no proforma AND no `pi_cancelled_at` |
| `gst_sent_unpaid` | finalized AND GST exists AND unpaid (edge case) |
| `invoiced` | finalized AND GST exists AND `payment_status === 'paid'` |
| `complete` | `accounted === true` AND GST exists |

---

## Billing Modes (per contract)

`contracts.billing_mode` TEXT: `proforma_first` (default) or `gst_direct`

| Mode | Behavior |
|---|---|
| `proforma_first` | Sends proforma invoice (non-tax) first → customer pays → GST invoice generated after payment. This is the standard flow. |
| `gst_direct` | GST tax invoice sent immediately after finalization. No PI step. Payment link attached to GST invoice. |

---

## Statement Types

`billing_statements.statement_type` TEXT:

| Value | Description |
|---|---|
| `rent` | Advance rent proforma for NEXT month. Auto-dispatched by `generateRentProformas()`. `period_start` = 1st of next month. `prepaid_month` and `prepaid_year` set. |
| `usage` | Usage charges for CURRENT month. Created as draft; admin reviews and sends. `period_start` = 1st of current month. `prepaid_month` / `prepaid_year` = null. |
| `combined` | Legacy: both rent and usage in one statement. Generated by deprecated `generateMonthlyStatements()`. Still used by contract activation hook. |
| `electricity` | Electricity sub-billing statements. |

---

## Business Rules — Hard Constraints

### Void Rules
1. **Admin only.** No other role can void.
2. **Blocked if any payments exist.** If `billing_payments` has any rows for the statement, void returns 409. Must reverse/delete payments first.
3. **Blocked on Tally-issued invoices.** If `issuance_channel === 'tally'`, the plain void is blocked (409 with `issuance_channel` in response body). The client code auto-routes to `cancel-tally` (credit note flow).
4. **Only finalized or exported statements can be voided.** Draft and voided statements return 400.
5. **Void always creates a replacement draft.** The replacement carries over all billing data but strips finalization artifacts. `voided_statement_id` on the replacement points back to the original.
6. **Void un-links all usage charges, bookings, and service usage records** so they can be re-billed on the replacement. `usage_charges.status` returns to `pending`.

### GST Invoice Rules
1. **Cannot generate GST invoice if `gst_invoice_number` already set** — returns 409.
2. **Statement must be finalized** (not draft) before GST generation.
3. **Statement must not be voided.**
4. **`payment_status` must be `paid`** before a GST invoice can be issued (standard flow). Exception: `gst_direct` mode and the early-override path bypass this.
5. **GST invoice number format:** `TWV/INV/YY-YY/NNNN` — sequential within fiscal year. Fiscal year starts April. Year computed as `fyStart = (month >= 3) ? year : year - 1`.
6. **GST tax rates are locked** at the contract's `tax_percentage` — never recalculated dynamically. GST recalculation at invoice time re-reads `statement.tax_percentage`.
7. **Place of supply is always Tamil Nadu** — always CGST+SGST split (never IGST), regardless of buyer state. `is_interstate = false` is hardcoded.

### Early GST Override Rules ("Issue GST Invoice (Override)")
The override is a **request action only** — it does NOT generate or send a GST invoice. It:
1. Cancels the existing Razorpay proforma payment link (if one exists).
2. Stamps `pi_cancelled_at`, `pi_cancelled_by`, `pi_override_reason` on the statement.
3. Sets `handoff_state = 'direct_gst_requested'` — queuing the statement to the accounts team's Tally Inbox.
4. The accounts team then creates the GST invoice in Tally and uploads it via the Tally Inbox. That upload step sends the invoice and payment link to the customer.

**Allowed roles:** `admin` and `manager` only (enforced in both UI and API). `accounts` cannot initiate an override.

**Conditions for the button to appear:**
- `statement.status === 'finalized'`
- No `gst_invoice_number` yet
- No prior `pi_cancelled_at` (can only override once)
- `payment_status !== 'paid'`

**The button is not gated behind any feature flag (Tally Sync or CRM GST settings).** Since the override only creates a request and does not itself generate an invoice, it is always available to eligible roles when the above conditions are met.

### Payment Recording Rules
1. **Roles:** Only `admin` or `accounts` can record payments (`PAYMENT_RECORDING_ROLES` in `src/lib/constants.ts`). Everyone else uses **Report paid** to tell accounts about a payment they were told about; accounts verify it against the bank and record it.
2. **Cannot record payment on a draft statement** — returns 400.
3. **TDS settlement:** `cash_received + tds_amount = invoice_total` for full settlement. TDS alone (without cash) does NOT settle the invoice.
4. **Auto-triggers GST invoice** when a payment causes `payment_status → paid` (legacy CRM path). In v2 handoff mode, routes to `handleStatementPaid()` instead.
5. **Auto-enqueues Tally receipt voucher** (legacy path; `RECEIPT_VOUCHER_ENABLED = false` currently suppressed).

### Finalize Rules
1. **Cannot finalize a voided statement.**
2. **`total_amount` must be > 0** to finalize-and-send (zero-amount statements must be voided instead).
3. **`/finalize-and-send` rolls back to draft** if the proforma dispatch fails, so the statement is never stuck in "finalized but unsent" limbo.

### Accounted Rules
1. **Roles:** Only `admin`, `manager`, or `accounts` can mark as accounted.
2. **`gst_invoice_number` must exist** before marking as accounted — returns 400 if not.

### Charge Addition Rules
1. **Only draft statements** can have charges added.
2. **GST rate is forced to match the statement's `tax_percentage`** — client-supplied `gst_rate` is ignored.
3. **Uses `add_statement_charge_atomic` RPC** to prevent race conditions on concurrent charge additions.

### Idempotency Rules (generators)
- A statement is never generated if a covering statement already exists for the period.
- `rent` generator: covering = any `rent` or `combined` statement where `prepaid_month/prepaid_year` matches, OR a `combined` statement with matching `period_start` and `prepaid_month IS NULL`.
- `usage` generator: covering = any `usage` or `combined` statement where `period_start` matches.
- If a covering statement was **never sent** (no `proforma_sent_at`, no `gst_invoice_number`, no payments), it is **superseded** (auto-voided + replaced).
- If a covering statement **was sent**, it is skipped (`alreadySent`).

### Quarterly Billing Gate
- Contracts with `billing_cycle = 'quarterly'` are only billed when `next_billing_date` falls in the target period.
- `next_billing_date` is advanced by exactly 3 months (day clamped to fit target month) after confirmed delivery.

---

## Role Permissions

| Action | Allowed Roles |
|---|---|
| View statements, usage charges | All authenticated |
| Finalize statement | All authenticated (via PATCH) |
| Finalize + send (one-click) | `admin`, `manager`, `accounts` |
| Record payment | `admin`, `accounts` |
| Generate GST invoice | `admin`, `manager`, `accounts` (or webhook with `x-internal-secret`) |
| Add charge to draft | `admin`, `manager`, `accounts` |
| Waive usage charge | `admin`, `manager` |
| Revert to draft | `admin`, `manager` |
| Mark accounted | `admin`, `manager`, `accounts` |
| Void statement | `admin` ONLY |
| Convert PI → early GST (override request) | `admin`, `manager` |
| Log print usage | `admin`, `accounts`, `manager` |
| Lock/unlock accounting period | Checked at page level via `userRole` |
| Run billing generators (POST /api/billing/auto-generate) | `admin`, `manager`, `accounts` |

---

## GST Math

**Canonical function:** `computeGstAndRounding(subtotal, taxPercentage)` in `src/lib/gst-math.ts`

Returns: `{ cgst, sgst, igst, taxAmount, totalAmount }`

- CGST = SGST = `taxPercentage / 2` applied to `subtotal`
- IGST = 0 (always, for TWV)
- Rounding is applied within this function

Do NOT recalculate GST inline — always use `computeGstAndRounding`.

---

## Integration Points

### Razorpay
- Payment links created by `dispatchProforma()` and `dispatchGstDirect()` in `src/lib/send-proforma.ts`.
- Keys fetched at runtime from `app_settings` table: `razorpay_key_id`, `razorpay_key_secret`, `razorpay_enabled`.
- Webhook at `/api/payments/webhook` handles `payment.captured` → triggers GST invoice generation.
- Void flow: if a statement has a Razorpay payment link, `convert-to-gst-early` cancels it via Razorpay API before overriding.

### Tally (two-track)
- **Legacy (v1):** CRM generates GST invoice PDF → enqueues `sales_voucher` job in `tally_sync_jobs` → bridge picks up and posts to Tally → bridge acks back with Tally invoice number.
- **Handoff v2:** CRM sends to accounts inbox (`handoff_state`). Accounts opens Tally, creates invoice, uploads PDF to CRM via `/upload-gst-invoice`. CRM verifies upload. Payment receipt is also manually entered in Tally.
- **Feature flag:** `app_settings.tally_handoff_v2_enabled = 'true'` enables v2. Read via `isHandoffV2Enabled()`.
- **Issuance routing:** `routeGstGenerationToTally()` — stamps `issuance_channel = 'tally'` at the GST-generation moment (decide-once). Subsequent operations branch on the stamp, not the live switch.

### Email
- Proforma: `dispatchProforma()` sends via Resend (from `EMAIL_FROM`, `replyTo EMAIL_REPLY_TO`).
- GST invoice: sent with PDF attachment to customer, CC'd to all active `admin` and `accounts` users.
- No email sent if `lead.email` is null — `noContact: true` in result.

### WhatsApp/SMS
- WhatsApp notification sent when statement is finalized via `messaging.billingStatementReady()`.
- Payment reminder sent via `send-reminder` route.

### Contracts
- Statement generation queries `contracts` for `status IN ('active', 'renewal_in_progress')`.
- `contract.tax_percentage` is locked into the statement at generation.
- `contract.billing_cycle` controls quarterly gate.
- `contract.billing_mode` controls proforma vs. gst_direct dispatch.
- `contract.next_billing_date` is advanced by 3 months after quarterly delivery.
- `contract.subtotal` (not `total_amount`) is the base for rent calculation.

### Bookings
- Contract-holder bookings with `status IN ('confirmed', 'checked_in', 'checked_out')` and `customer_type = 'contract_holder'` are auto-rolled into the usage statement.
- Free-quota bookings (`payment_status = 'posted_to_bill'` or `'waived'`) appear at ₹0 on the invoice.
- `bookings.billing_statement_id` is set when a booking is included in a statement; unlinked on void.

### PDF Generation
- Proforma PDF: `src/lib/pdf-generator.ts`
- GST invoice PDF: `src/lib/gst-invoice-generator.ts` using jsPDF
- PDFs uploaded to Supabase Storage bucket `crm-documents` at path `invoices/<invoice-number>.pdf`

---

## Cron Jobs

| Cron | Schedule (UTC) | IST | Purpose |
|---|---|---|---|
| `/api/cron/billing-proforma-dispatch` | `0 16 28-31 * *` | 21:30 IST | Auto-dispatch proformas on last day of month; verifies `todayDate === daysInMonth` |
| `/api/cron/billing-reminder` | Daily 13:00 UTC | 18:30 IST | Payment reminder nudge (does NOT generate statements) |

**Important:** `/api/billing/auto-generate` GET is intentionally disabled (`disabled: true`). Billing is now manual-only. The old vercel.json cron entry has been removed.

---

## Key User Flows

### Monthly Rent Proforma Flow (end-of-month)

1. Finance opens `/billing` → Invoicing section → Statements tab.
2. Sees "Monthly Rent Proforma" card for next month.
3. Clicks **Preview** → `POST /api/billing/auto-generate { dry_run: true, mode: 'rent' }` → shows per-contract amounts.
4. Clicks **Run & Send** → `POST /api/billing/auto-generate { mode: 'rent' }` → generator runs:
   a. Finds active contracts overlapping the prepaid month.
   b. Calculates prepaid rent (prorated if contract ends mid-month).
   c. Calculates add-ons (from `contract_addons` table).
   d. Inserts statement as `draft`, immediately auto-finalizes to `finalized`.
   e. Calls `dispatchProforma()` or `dispatchGstDirect()` based on `billing_mode`.
   f. Dispatch: creates Razorpay link + generates PDF + sends email + sends WhatsApp.
   g. Stamps `proforma_sent_at`.
   h. Advances quarterly `next_billing_date` if delivered.
5. Summary toast shows counts: generated, skipped, no-contact.

### Monthly Usage Statement Flow

1. After month closes, finance opens Usage tab.
2. Each contract row shows usage rollup (ad-hoc, facility, service, booking overages).
3. Finance expands a row to review line items.
4. Clicks **Verify & Send** → `POST /api/billing-statements/[id]/finalize-and-send` (if statement exists) or `POST /api/billing/usage-finalize-and-send-for-contract`.
5. Statement is finalized + proforma dispatched in one atomic call. Rollback to draft if dispatch fails.

### Record Payment Flow

1. Finance sees statement row with balance due.
2. Clicks **Record Payment** → dialog opens with balance pre-filled.
3. Enters amount, date, mode, reference. Optionally toggles TDS block.
4. Submits → `POST /api/billing-statements/[id]/payment`.
5. System calculates `SUM(amount + tds_amount)` vs `total_amount`.
6. Updates `payment_status` to `unpaid` / `partially_paid` / `paid`.
7. If `paid`: auto-triggers GST invoice generation (legacy) or routes to v2 handoff.

### Void and Re-issue Flow

1. Admin finds a statement with errors (wrong amount, wrong charges).
2. Clicks **Void** → Void dialog with mandatory reason field.
3. Submits → `POST /api/billing-statements/[id]/void`.
4. If Tally-issued (409 with `issuance_channel: 'tally'`): client auto-calls `cancel-tally` instead (credit note path).
5. On success: original is voided, replacement draft is created. Charges are unlinked.
6. Finance reviews and corrects the new draft, then re-sends.

---

## Environment and Config Dependencies

| Key | Source | Purpose |
|---|---|---|
| `app_settings.razorpay_key_id` | DB table | Razorpay API key |
| `app_settings.razorpay_key_secret` | DB table | Razorpay API secret |
| `app_settings.razorpay_enabled` | DB table | Enable/disable Razorpay link creation |
| `app_settings.upi_id` | DB table | UPI ID printed on GST invoice PDF |
| `app_settings.tally_sync_enabled` | DB table | Master switch: Tally issuance active |
| `app_settings.crm_gst_enabled` | DB table | CRM-side GST generation active (standby flag) |
| `app_settings.tally_handoff_v2_enabled` | DB table | Enable v2 handoff (human-mediated Tally flow) |
| `CRON_SECRET` | env var | Authorizes cron endpoints and internal `generate-gst-invoice` calls |
| `NEXT_PUBLIC_APP_URL` / `APP_URL` | env var | Used to construct absolute URLs for internal self-calls |
| `RESEND_API_KEY` | env var | Resend transactional email |
| `MSG91_AUTH_KEY` / `MSG91_WHATSAPP_SENDER` | env var | WhatsApp/SMS notifications |

---

## Known Pitfalls and Gotchas

### PDF Smoke Test Required
Any change to `src/lib/billing.ts`, `src/lib/send-proforma.ts`, `src/lib/pdf-generator.ts`, `src/lib/gst-invoice-generator.ts`, or `/api/billing-statements/` routes must be followed by a manual PDF smoke test (open a statement, trigger send, open the PDF, verify Qty × Rate = Amount for every line item). The UI cannot catch PDF rendering bugs.

### `subtotal` vs `total_amount` on contracts
Rent calculation uses `contract.subtotal` (the pre-tax amount), NOT `contract.total_amount` (which includes tax). Using `total_amount` as the rent base would over-bill. Both columns exist on the contracts table.

### GST invoice idempotency
`generate-gst-invoice` returns 409 if `gst_invoice_number` is already set. Callers must handle 409 gracefully (it means "already done").

### Sequential GST invoice numbering race
GST invoice number is generated with `COUNT(like fyPrefix%) + 1`. This is NOT atomic. Concurrent generation for two statements in the same fiscal year can produce the same number. In practice this is rare (generation is sequential or low-concurrency), but it is a known gap. The `gst_invoice_number` column has no UNIQUE constraint in the DB.

### Void does not delete the voided statement
The original is marked `status = 'voided'` and stays in the DB. The replacement draft has `voided_statement_id` pointing back. Queries that list "active" statements should filter out `status = 'voided'`.

### Tally-issued invoices cannot be plain-voided
The void API returns 409 with `issuance_channel: 'tally'` when a Tally-issued invoice is attempted. The billing page auto-routes to `cancel-tally` (credit note). Any code calling the void route must handle this 409 case.

### `statement_type = 'electricity'` not in DB CHECK
The TypeScript type includes `'electricity'` as a valid `statement_type`, but the DB CHECK constraint in migration `00223` only lists `('combined', 'rent', 'usage')`. Inserting `electricity` bypasses the TEXT CHECK if the Postgres CHECK hasn't been updated. Verify before inserting electricity statements.

### Due date semantics differ by statement type
- **Rent statements:** `due_date = send_date + 7 days` (7 days from when the proforma is dispatched, NOT from period_end — period_end is the last day of the prepaid month, which would be a month away).
- **Usage statements:** `due_date = period_end + 7 days`.

### Quarterly billing only advances if delivered
`next_billing_date` is only advanced if `delivered === true`, meaning an email was actually sent OR a payment link was created. A no-contact failure (no email + no phone) does NOT advance the anchor, preventing the next quarter from being silently skipped.

### Free-quota bookings appear on the invoice at ₹0
Bookings with `payment_status = 'posted_to_bill'` or `'waived'` are included in the `booking_usage` section of the line items at ₹0. They are informational — to show what space was used under the free quota. They do NOT contribute to totals.

### `add-charge` forces GST rate to match statement's `tax_percentage`
Any client-supplied `gst_rate` on the charge body is silently ignored. The charge GST rate is always `statement.tax_percentage`. This prevents line items from having different GST rates on the same invoice.

### Concurrent charge addition race condition
Always use the `add_statement_charge_atomic` RPC when adding charges. Direct insert + update-totals is subject to a lost-update race condition. The RPC holds a row lock.

### Monthly summary vs. statements fetch are separate
The `/billing` page fetches monthly summary (`/api/accounting/monthly-summary`) separately from the statements list (`/api/billing-statements`). They use different filtering approaches: summary is keyed to a specific month/year; statements fetch all (up to 100) and filter client-side for type. After mutations, call both `fetchStatements()` AND `fetchData()` to keep both views consistent.

### Auto-billing GET is permanently disabled
`GET /api/billing/auto-generate` returns `{ disabled: true }` always. Do not rely on it for any automated billing. The cron entry in vercel.json has been removed. All billing generation is triggered manually via POST.
