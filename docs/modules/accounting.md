# Accounting & Payables

## Purpose and Business Context

The Accounting & Payables module is the financial clearance hub for The WorkVilla. It enforces strict separation of concerns between:

- **Procurement** (raises vendor bills, approves/rejects them) — happens in `/procurement`
- **Finance / Acc Payables** (records actual bank payments on approved bills) — happens in `/accounting`

This separation prevents the same team that approves spending from also releasing payments — a key internal control. Beyond vendor payments, the module handles petty cash disbursements, TDS tracking and challan management, and rent/lease payments.

---

## Routes and What Each Renders

| Route | File | Component | Purpose |
|-------|------|-----------|---------|
| `/accounting` | `src/app/(dashboard)/accounting/page.tsx` | `AccountingPage` (client) | Multi-tab hub: Vendor Payments, Petty Cash, TDS Payable, Rent |
| `/accounting?tab=vendor-payments` | same | — | Default tab. Lists approved unpaid/partially-paid bills + payment history |
| `/accounting?tab=petty-cash` | same | `PettyCashIssuance` | Petty cash issuance queue and approval |
| `/accounting?tab=tds` | embeds `src/app/(dashboard)/accounting/tds/page.tsx` | `TdsPayablePage` | TDS Payable + Receivable panels |
| `/accounting?tab=rent` | same page | — | Rent payments: approved-ready-to-pay and recently paid (90 days) |
| `/accounting/vendor-payments/[id]` | `src/app/(dashboard)/accounting/vendor-payments/[id]/page.tsx` | `VendorPaymentDetailPage` (client) | Full bill detail with document chain, KYC, payment dialog, hold/release, audit trail |
| `/accounting/vendor-email-audit` | `src/app/(dashboard)/accounting/vendor-email-audit/page.tsx` | — | Bulk-fix page for vendors missing contact email |
| `/accounting/inbox` | `src/app/(dashboard)/accounting/inbox/page.tsx` | — | Tally handoff inbox |
| `/accounting/receivables` | `src/app/(dashboard)/accounting/receivables/page.tsx` | — | Client receivables view |
| `/accounting/tds` | `src/app/(dashboard)/accounting/tds/page.tsx` | — | TDS Payable page (also embedded in main accounting page) |

---

## Key Source Files

### Pages
- `src/app/(dashboard)/accounting/page.tsx` — Main page (2,045 lines), client component
- `src/app/(dashboard)/accounting/vendor-payments/[id]/page.tsx` — Detail page (2,418 lines), client component
- `src/app/(dashboard)/accounting/tds/page.tsx` — TDS Payable page

### Components
- `src/components/accounting/petty-cash-issuance.tsx` — PettyCash tab render
- `src/components/finance-intelligence/vendor-email-banner.tsx` — Banner shown in payment dialog when vendor email is missing; blocks payment confirmation email
- `src/components/finance-intelligence/vendor-email-chip.tsx` — Inline chip shown on bill rows when vendor has no email
- `src/components/accounting/statement-lifecycle.tsx` — Billing statement lifecycle indicator
- `src/components/finance/finance-guide-card.tsx` — Onboarding guide card (shown to accounts role on first visit)

### API Routes (Accounting module)
- `POST /api/accounting/batch-payment` — Multi-bill single-instrument payment
- `GET /api/accounting/po-advances-pending` — PO advances queued for Finance to release
- `GET /api/accounting/rent-payments` — List lease payments (`?view=pending|paid`)
- `POST /api/accounting/rent-payments/[paymentId]/mark-paid` — Record rent payment
- `GET/POST /api/accounting/contract-payments` — Contract payment recording
- `GET /api/accounting/receivables` — Client receivables
- `GET /api/accounting/monthly-summary` — Monthly summary
- `GET /api/accounting/gst-invoices` — GST invoice list
- `GET /api/accounting/periods` — Accounting periods
- `GET /api/accounting/inbox` — Tally inbox

### API Routes (Procurement bills — used by accounting pages)
- `GET /api/procurement/bills` — List bills with filters; Acc Payables uses `?approval_status=approved`
- `PATCH /api/procurement/bills/[id]` — All bill mutations via `action` field:
  - `action: "record_payment"` — record a vendor payment
  - `action: "update_gst"` — set/update GST amount
  - `action: "hold_payment"` — place payment on hold
  - `action: "release_hold"` — release payment hold
  - `action: "sign_cheque"` — mark physical cheque as signed
  - `action: "tag_accounting"` — tag manual_department / manual_expenditure_type
- `GET /api/procurement/bills/[id]/chain` — Full document chain (bill + vendor + PO + MR + DCs + service reports + KYC docs + audit trail)
- `POST /api/procurement/bills/[id]/payment-email` — Send vendor payment confirmation email
- `PATCH /api/procurement/orders/[id]` (`action: "process_advance"`) — Release PO advance

### API Routes (TDS)
- `GET /api/tds/sections` — All TDS sections (lookup)
- `GET /api/tds/suggest?vendor_id=&po_type=` — Auto-suggest TDS section for a payment
- `GET /api/tds/payable` — TDS deductions pending challan
- `GET /api/tds/receivable` — TDS deducted by clients
- `POST /api/tds/challans` — Record ITNS 281 challan
- `GET /api/tds/26q` — 26Q quarterly return data
- `GET /api/tds/form16a` — Form 16A certificate data

### API Routes (Petty Cash)
- `GET/POST /api/petty-cash/requests` — PC fund requests
- `GET/POST /api/petty-cash/entries` — PC spend entries (submit, list)
- `PATCH /api/petty-cash/entries/[id]` — Approve/reject/issue entry
- `GET /api/petty-cash/books` — PC books (per-user cash float)
- `GET /api/petty-cash/categories` — PC expense categories
- `GET /api/petty-cash/day-book` — Daily cashbook view

### API Routes (Finance Intelligence)
- `GET /api/finance-intelligence/vendor-email-nag/audit` — Vendors missing email (count + details)
- `POST /api/finance-intelligence/vendor-email-nag/dismiss` — Dismiss nag for a vendor
- `GET /api/finance-intelligence/vendor-email-nag/status` — Status of nag for a specific vendor

### Lib Files
- `src/lib/finance-intelligence.ts` — `listVendorsMissingEmail()` helper
- `src/lib/audit.ts` — `logAudit()` used throughout
- `src/lib/audit-labels.ts` — `summarizeAuditEvent()`, `AUDIT_TONE_DOT`, `AUDIT_TONE_TEXT` (used in audit trail component)

---

## Data Model

### `vendor_bills` (primary table)

Created in `00019_procurement_module.sql`, extended by many subsequent migrations.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `bill_number` | VARCHAR(20) UNIQUE | e.g. `BILL-2606-001` |
| `po_id` | UUID nullable FK → `purchase_orders` | NULL for direct-expense bills |
| `vendor_id` | UUID NOT NULL FK → `procurement_vendors` | |
| `invoice_number` | VARCHAR(100) nullable | Vendor's own invoice number |
| `invoice_date` | DATE NOT NULL | |
| `due_date` | DATE nullable | |
| `invoice_file_url` | TEXT nullable | Permanent URL to uploaded invoice scan |
| `invoice_signed_url` | TEXT nullable | Temporary signed URL (generated at query time) |
| `total_amount` | DECIMAL(12,2) NOT NULL | Pre-GST base amount (despite the name) |
| `base_amount` | DECIMAL(12,2) NOT NULL DEFAULT 0 | Explicit pre-GST base; same as `total_amount` for new bills |
| `gst_rate` | DECIMAL(5,2) NOT NULL DEFAULT 0 | GST slab: 0, 5, 12, 18, or 28 |
| `gst_amount` | DECIMAL(12,2) NOT NULL DEFAULT 0 | Additive GST on top of base (not included in `total_amount`) |
| `gst_set_by` | UUID nullable FK → `users` | Who last set/changed gst_amount |
| `gst_set_at` | TIMESTAMPTZ nullable | When gst_amount was last set |
| `gst_zero_confirmed` | BOOLEAN NOT NULL DEFAULT false | Explicit confirmation that GST = 0 |
| `gst_zero_confirmed_by` | UUID nullable FK → `users` | |
| `amount_paid` | DECIMAL(12,2) DEFAULT 0 | Running total across all `vendor_bill_payments` rows |
| `payment_status` | ENUM `bill_payment_status` | `unpaid` \| `partially_paid` \| `paid` |
| `payment_mode` | TEXT nullable | Last/only payment mode (legacy field; detail in `vendor_bill_payments`) |
| `payment_reference` | VARCHAR(255) nullable | Last/only payment reference (legacy) |
| `payment_date` | DATE nullable | Last/only payment date (legacy) |
| `approval_status` | TEXT DEFAULT `'pending'` | CHECK: `pending` \| `approved` \| `rejected` |
| `approved_by` | UUID nullable FK → `users` | |
| `approved_at` | TIMESTAMPTZ nullable | |
| `approval_code` | VARCHAR(20) nullable | Short reference code for approval |
| `rejection_reason` | TEXT nullable | |
| `rejection_outcome` | TEXT nullable | CHECK: NULL \| `return` \| `replacement` \| `void` |
| `approved_amount` | NUMERIC(12,2) nullable | NULL means full amount approved; lower value = partial approval |
| `approved_amount_note` | TEXT nullable | Free-text note for partial approval |
| `approved_amount_reason` | TEXT nullable | Categorical: `pending_delivery` \| `qc_hold` \| `invoice_discrepancy` \| `retention` \| `advance_adjustment` \| `other` |
| `payment_batch_type` | TEXT nullable | CHECK: `immediate` \| `15th` \| `25th` |
| `payment_batch_date` | DATE nullable | Target payment date in the batch |
| `payment_batch_assigned_by` | UUID nullable FK → `users` | |
| `payment_batch_assigned_at` | TIMESTAMPTZ nullable | |
| `payment_hold_status` | TEXT DEFAULT `'none'` | CHECK: `none` \| `on_hold` |
| `payment_hold_reason` | TEXT nullable | CHECK: `wrong_scan` \| `wrong_bank_details` \| `bank_rejected` \| `amount_mismatch` \| `duplicate_suspected` \| `pending_docs` \| `other` |
| `payment_hold_notes` | TEXT nullable | |
| `payment_held_by` | UUID nullable FK → `users` | |
| `payment_held_at` | TIMESTAMPTZ nullable | |
| `payment_hold_resolved_by` | UUID nullable FK → `users` | |
| `payment_hold_resolved_at` | TIMESTAMPTZ nullable | |
| `payment_hold_resolution_notes` | TEXT nullable | |
| `cheque_signed_at` | TIMESTAMPTZ nullable | NULL = cheque not yet signed (email blocked) |
| `cheque_signed_by` | UUID nullable FK → `users` | |
| `replaces_bill_id` | UUID nullable FK → `vendor_bills` (self) | Replacement lineage |
| `manual_department` | TEXT nullable | For direct-expense bills (no PO): override department |
| `manual_expenditure_type` | TEXT nullable | For direct-expense bills: override expenditure type |
| `notes` | TEXT nullable | |
| `created_by` | UUID NOT NULL FK → `users` | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**RLS**: All authenticated users can SELECT, INSERT, UPDATE. No role restriction at DB level — enforced in API routes.

**Computed payment ceiling** (critical for Acc Payables): `approved_amount ?? total_amount + gst_amount`. This is what Finance must not exceed when recording a payment.

---

### `vendor_bill_payments` (payment history)

Created in `00095_vendor_bill_payments.sql`, extended by `00174_batch_ref.sql` and `00259_vendor_bill_partial_clarity.sql`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `bill_id` | UUID NOT NULL FK → `vendor_bills` ON DELETE CASCADE | |
| `amount` | NUMERIC(12,2) NOT NULL | CHECK: amount > 0 |
| `payment_mode` | TEXT NOT NULL | `neft` \| `rtgs` \| `imps` \| `bank_transfer` \| `cheque` \| `cash` |
| `payment_reference` | TEXT nullable | UTR / cheque number |
| `payment_date` | DATE NOT NULL DEFAULT CURRENT_DATE | |
| `notes` | TEXT nullable | |
| `partial_reason` | TEXT nullable | Categorical reason when amount < approved_outstanding: `cashflow_hold` \| `retention` \| `dispute_pending` \| `awaiting_docs` \| `tds_adjustment` \| `advance_adjustment` \| `other` |
| `batch_ref` | UUID nullable | Shared UUID across all rows in one batch payment |
| `recorded_by` | UUID NOT NULL FK → `users` | |
| `created_at` | TIMESTAMPTZ NOT NULL | |

**RLS**: All authenticated can SELECT and INSERT.

---

### `vendor_bill_tds` (TDS deductions)

Created in `00158_tds_module_phase1.sql`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `bill_id` | UUID NOT NULL FK → `vendor_bills` ON DELETE CASCADE | |
| `payment_id` | UUID nullable FK → `vendor_bill_payments` ON DELETE SET NULL | |
| `section_code` | TEXT NOT NULL FK → `tds_sections` | |
| `vendor_type` | TEXT NOT NULL DEFAULT `'company'` | CHECK: `individual` \| `huf` \| `company` |
| `base_amount` | NUMERIC(12,2) NOT NULL | CHECK: > 0; pre-GST value TDS is calculated on |
| `tds_rate` | NUMERIC(5,2) NOT NULL | CHECK: > 0 |
| `tds_amount` | NUMERIC(12,2) NOT NULL | CHECK: > 0 |
| `pan_available` | BOOLEAN NOT NULL DEFAULT true | false → rate defaults to 20% per Section 206AA |
| `status` | TEXT NOT NULL DEFAULT `'pending'` | CHECK: `pending` \| `deposited` |
| `challan_id` | UUID nullable FK → `tds_challans` ON DELETE SET NULL | |
| `period_month` | INT NOT NULL | CHECK: 1-12 |
| `period_year` | INT NOT NULL | CHECK: >= 2020 |
| `created_by` | UUID NOT NULL FK → `users` | |
| `created_at` | TIMESTAMPTZ | |

---

### `tds_sections` (lookup)

Created in `00158_tds_module_phase1.sql`.

| code | description | rate_individual | rate_company |
|------|-------------|----------------|--------------|
| `194C` | Contractors & Sub-contractors | 1.00% | 2.00% |
| `194J_a` | Technical Services | 2.00% | 2.00% |
| `194J_b` | Professional Services | 10.00% | 10.00% |
| `194I_a` | Rent – Plant & Machinery | 2.00% | 2.00% |
| `194I_b` | Rent – Land / Building | 10.00% | 10.00% |
| `194H` | Commission & Brokerage | 5.00% | 5.00% |

---

### `tds_challans` (ITNS 281 register)

Created in `00159_tds_challans.sql`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `challan_ref` | TEXT UNIQUE NOT NULL | e.g. `TDSC-2605-001` |
| `bsr_code` | VARCHAR(7) NOT NULL | Bank BSR code |
| `challan_serial` | VARCHAR(10) NOT NULL | |
| `deposit_date` | DATE NOT NULL | |
| `period_month` | INT NOT NULL | CHECK: 1-12 |
| `period_year` | INT NOT NULL | CHECK: >= 2020 |
| `section_code` | TEXT NOT NULL FK → `tds_sections` | |
| `total_amount` | NUMERIC(12,2) NOT NULL | CHECK: > 0 |
| `receipt_url` | TEXT nullable | |
| `deposited_by` | UUID NOT NULL FK → `users` | |

---

### `petty_cash_books`

One per user. Auto-created on first PC entry submission.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → `users` | |
| `current_balance` | DECIMAL | Cash float balance |

---

### `petty_cash_entries`

| Column | Type | Notes |
|--------|------|-------|
| `entry_number` | VARCHAR | Pattern: `PCE-YYMM-NNN` |
| `book_id` | UUID FK → `petty_cash_books` | |
| `date` | DATE | Expense date |
| `amount` | DECIMAL NOT NULL | CHECK: > 0 |
| `category_id` | UUID nullable FK → `petty_cash_categories` | |
| `description` | TEXT NOT NULL | min 1 char |
| `receipt_url` | TEXT nullable | |
| `po_id` | UUID nullable FK → `purchase_orders` | Link to PO if reimbursing a PO-linked expense |
| `status` | TEXT | `pending_manager` \| `pending_admin` \| `approved` \| `rejected` |
| `submitted_by` | UUID NOT NULL FK → `users` | |

---

### `petty_cash_requests`

Fund requests (someone requests cash float from admin).

| status | Meaning |
|--------|---------|
| `pending` | Submitted, not yet actioned |
| `approved` | Approved, awaiting physical issuance |
| `issued` | Cash physically handed over |
| `rejected` | Rejected |

---

### `lease_payments` (rent)

Created in `00177_rent_management.sql`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `lease_id` | UUID NOT NULL FK → `property_leases` | |
| `payment_month` | TEXT NOT NULL | Format: `YYYY-MM` |
| `due_date` | DATE NOT NULL | |
| `paid_date` | DATE nullable | |
| `gross_rent_amount` | NUMERIC(12,2) NOT NULL | |
| `tds_amount` | NUMERIC(12,2) NOT NULL DEFAULT 0 | |
| `net_amount_paid` | NUMERIC(12,2) nullable | gross - tds |
| `payment_mode` | TEXT nullable | CHECK: `bank_transfer` \| `cheque` \| `neft` \| `rtgs` \| `upi` |
| `payment_reference` | TEXT nullable | UTR / cheque number (required by API) |
| `bank_account_id` | UUID nullable FK → `landlord_bank_accounts` | |
| `status` | TEXT NOT NULL DEFAULT `'pending'` | CHECK: `pending` \| `approved` \| `paid` \| `overdue` \| `on_hold` \| `disputed` |
| `auto_approved` | BOOLEAN NOT NULL DEFAULT false | |
| `approved_by` | UUID nullable FK → `users` | |

---

### `procurement_vendors` (relevant columns)

| Column | Notes |
|--------|-------|
| `contact_email` | Used for vendor confirmation emails. Empty/null = email blocked |
| `pan_number` | Used for TDS rate determination (missing PAN → 20% per Section 206AA) |
| `bank_name`, `bank_account_holder`, `bank_account_number`, `bank_ifsc` | Bank details for payment verification |
| `kyc_verified` | Boolean; shown as "KYC ✓" badge in payment dialog |
| `gstin` | GST registration number |

---

### Supporting Tables

| Table | Purpose |
|-------|---------|
| `accounting_periods` | Monthly periods with `open`/`locked` status |
| `contract_facilities` | Per-contract facility definitions with free quotas |
| `facility_usage_records` | Monthly usage per contract per facility |
| `contract_payments` | Payments against billing statements; includes cash handover tracking |
| `finance_suggestion_log` | Audit log for AI/ML finance suggestions |
| `landlords` | Landlord master data |
| `landlord_bank_accounts` | Landlord bank accounts (one `is_primary=true` per landlord) |
| `property_leases` | Lease agreements per location |
| `vendor_bill_batch_changes` | Audit trail for batch date overrides on vendor bills |

---

## State Machines and Status Lifecycles

### Vendor Bill: `approval_status`

```
pending → approved  (Procurement: admin/manager)
pending → rejected  (Procurement: admin/manager)
rejected → [replacement bill created with replaces_bill_id]
```

Only `approved` bills appear in Acc Payables. Rejected bills with `rejection_outcome = 'replacement'` can have a replacement bill referencing them via `replaces_bill_id`.

### Vendor Bill: `payment_status`

```
unpaid → partially_paid  (partial payment recorded)
unpaid → paid            (full payment recorded)
partially_paid → paid    (remaining balance recorded)
```

Transition logic (computed server-side):
```
newAmountPaid = existing amount_paid + payment amount
paymentStatus = newAmountPaid >= (approved_amount ?? total_amount + gst_amount) - 0.01 ? "paid" : "partially_paid"
```

### Vendor Bill: `payment_hold_status`

```
none → on_hold     (accounts/admin/office_admin; only if not fully paid)
on_hold → none     (admin/manager only — "release hold")
```

While `on_hold`, the "Record Payment" button is hidden. Only "Release Hold" is visible to admin/manager.

### Vendor Bill: GST State

GST must be set **before** any payment can be recorded:
1. `gst_set_at IS NULL` → payment dialog blocked with error
2. `gst_amount = 0` without `gst_zero_confirmed = true` → blocked (accounts user must check confirmation box)
3. `gst_set_at IS NOT NULL` → payment dialog can open

### Petty Cash Entry: `status`

```
pending_manager → pending_admin  (manager approves)
pending_manager → rejected       (manager rejects)
pending_admin   → approved       (admin approves + issues)
pending_admin   → rejected       (admin rejects)
```

### Petty Cash Request: `status`

```
pending → approved  (admin/manager)
pending → rejected  (admin/manager)
approved → issued   (admin physically hands over cash)
```

### Lease Payment: `status`

```
pending → approved  (admin: lease approval flow)
pending → on_hold   (admin)
pending → disputed  (admin)
approved → paid     (accounts/admin: mark-paid endpoint; requires payment_reference)
approved → overdue  (system, when due_date passes)
on_hold → approved  (admin: release)
```

The Finance > Rent tab only surfaces `approved` and `on_hold` payments in the "pending" view, and `paid` payments from the last 90 days in the "paid" view.

### TDS Deduction: `status`

```
pending → deposited  (after challan is created and linked)
```

---

## Business Rules (Hard Rules — Never Bypass)

### Payment Recording

1. **Role gate**: Only `admin`, `accounts`, `office_admin` can record vendor bill payments. `manager` can VIEW but cannot record.
2. **Approval gate**: `vendor_bills.approval_status` must be `'approved'`. Non-approved bills are filtered out of the Acc Payables queue.
3. **Already paid gate**: `payment_status = 'paid'` → reject. Server returns HTTP 409 on batch payment, HTTP 422 on single.
4. **GST must be set**: `gst_set_at IS NULL` → payment blocked client-side before dialog even opens; also validated server-side.
5. **Payment ceiling**: Amount cannot exceed `(approved_amount ?? total_amount) + gst_amount - amount_paid` (approved outstanding). Exceeding by more than ₹0.01 is rejected.
6. **Partial payment requires reason**: If amount < approved outstanding by more than ₹0.01, `partial_reason` field is required (client-side enforced; audit trail).
7. **Hold blocks payment**: If `payment_hold_status = 'on_hold'`, the "Record Payment" button is hidden. Payment cannot be recorded through the normal flow while on hold.
8. **TDS validation**: If TDS is enabled, `section_code` is required, `base_amount > 0` is required, `tds_amount > 0` is required.
9. **Payment mode restrictions by role**:
   - `accounts` → bank modes only: `neft`, `rtgs`, `imps`, `bank_transfer`, `cheque`
   - `office_admin` → `cash` only in practice (the UI restricts cash to admin + office_admin)
   - `admin` → all modes
10. **Batch payment requires at least 2 bills**: `bills` array minimum length = 2. Enforced by Zod schema.
11. **Batch payment requires full outstanding**: Each bill in a batch must be paid at exactly the full approved outstanding (within ₹0.50 tolerance). Partial batch payments are not allowed.

### Cheque Payment

1. After a cheque payment is recorded, `cheque_signed_at` is NULL.
2. The vendor confirmation email is NOT sent automatically for cheque payments.
3. An authorised user must click "Sign Cheque & Send" which calls `action: "sign_cheque"` then sends the email.
4. The payment history shows "⚠ Sign cheque" warning until signed.

### PO Advance Flow

PO advances with `advance_status = 'pending'` and `advance_amount > 0` appear in a separate purple section in the Vendor Payments tab. These are processed by Finance (not Procurement) via `PATCH /api/procurement/orders/[id]` with `action: "process_advance"`. A `payment_reference` (UTR) is required. Cash mode is not available for advances.

After advance is processed, when the vendor bill is created, `amount_paid` is pre-credited with the advance amount. The bill then shows as "partially paid" from birth, with the PO advance banner explaining why.

### GST Amount

- `total_amount` on `vendor_bills` is the **pre-GST base** (despite the column name).
- `gst_amount` is **additive on top** (not included in `total_amount`).
- Payment ceiling = `(approved_amount ?? total_amount) + gst_amount`.
- GST max validation (client-side): `gst_amount` cannot exceed 28% of `total_amount`.
- If GST = 0, must be explicitly confirmed with a checkbox ("I confirm this bill has no GST").

### Vendor Email

- Payment confirmation emails require the vendor to have a `contact_email`.
- If email is missing, `VendorEmailBanner` is shown first (inside the payment dialog), with `forceShow`, `hideSkip` props — it cannot be skipped.
- After email is saved, `sendConfirmation` defaults to `true`. For cheque mode, it defaults to `false`.
- Vendors missing email also trigger a dashboard alert widget showing count of affected vendors and count with pending bills ("high priority").

### TDS Suggestion Logic

`GET /api/tds/suggest?vendor_id=&po_type=`:
- `po_type = 'goods'` → TDS not applicable (never on goods POs)
- Vendor category mapping: `maintenance → 194C`, `administration → 194J_b`, `general → 194J_a`, `pantry → none`
- PAN not available → rate defaults to 20% per Section 206AA
- TDS base = pre-GST amount (GST is excluded from TDS calculation)

### Rent Payment

- Only `status = 'approved'` payments can be marked paid (HTTP 422 if not approved).
- `payment_reference` is required (min 1 char, Zod validated).
- `paid_date` must match regex `^\d{4}-\d{2}-\d{2}$`.
- Available modes: `bank_transfer`, `neft`, `rtgs`, `imps`, `cheque`, `upi`.
- Roles allowed: `admin`, `accounts` only (NOT `office_admin`).

---

## Validation Rules (Where Each Is Enforced)

### Vendor Bill Payment

| Rule | Client-side | Server-side | DB Constraint |
|------|-------------|-------------|---------------|
| Payment mode required | `toast.error` if empty | Zod enum validation | — |
| Amount > 0 | `toast.error` | Zod `.positive()` | CHECK amount > 0 on `vendor_bill_payments` |
| Amount ≤ approved outstanding (±0.01) | `toast.error` if exceeds | Validated in `record_payment` action | — |
| Partial reason required if amount < outstanding | `toast.error` if empty | Checked in action handler | `partial_reason` is nullable at DB level |
| GST must be set before payment | `openPaymentDialog()` checks `!bill.gst_set_at` | Also blocked in action | — |
| TDS section required if TDS enabled | `toast.error` | Validated in action handler | NOT NULL on section_code when inserting `vendor_bill_tds` |
| TDS base amount > 0 | `toast.error` | Zod `.positive()` in batch schema | CHECK base_amount > 0 |
| Role gate | Role checked from `useCurrentUser()` hook | Checked against `dbUser.role` | — |
| Hold gate (blocked if on hold) | "Record Payment" button hidden | No explicit server block (button absent) | — |
| Batch minimum 2 bills | Button only shows for `selectedBillIds.size >= 2` | Zod `.min(2)` | — |
| Batch amount matches outstanding (±0.50) | Computed and shown as default | Validated per bill | — |

### GST Update

| Rule | Where |
|------|-------|
| gst_amount ≤ 28% of total_amount | Client-side before `handleSaveInlineGst()` |
| Zero GST requires checkbox confirm | Client-side (checkbox must be checked) |
| gst_amount IS NOT NULL | DB default 0, effectively always set |

### Rent Payment

| Rule | Where |
|------|-------|
| paid_date regex `^\d{4}-\d{2}-\d{2}$` | Zod on server |
| payment_reference min 1 char | Zod `.min(1)` on server; client also validates |
| status must be 'approved' | Server: HTTP 422 |
| Already paid guard | Server: HTTP 409 |
| Role: admin or accounts only | Server: `["admin", "accounts"].includes(role)` |

### Petty Cash Entry

| Rule | Where |
|------|-------|
| amount > 0 | Zod `.positive()` server |
| description min 1 char | Zod `.min(1)` server |
| date required | Zod `.min(1)` server |
| PO-linked amount cap | Server: sum of existing PC entries linked to same PO + new amount ≤ PO total_ordered_amount |
| Entry number auto-generated | Server: `PCE-YYMM-NNN` pattern |

---

## Role Permissions

### Vendor Payments Tab

| Action | Roles |
|--------|-------|
| View vendor payments list | All authenticated |
| Record payment (bank modes) | `admin`, `accounts` |
| Record payment (cash mode) | `admin`, `office_admin` |
| Record batch payment | `admin`, `accounts`, `office_admin` (mode-restricted per role) |
| Place payment on hold | `admin`, `accounts`, `office_admin` |
| Release payment hold | `admin`, `manager` |
| Process PO advance | `admin`, `accounts`, `office_admin` (view: + `manager`) |
| Accounting head tagging | Any user (no role restriction shown in UI) |

### Rent Tab

| Action | Roles |
|--------|-------|
| View rent tab | `admin`, `accounts`, `viewer` (`RENT_PAYABLE_ROLES`) |
| Mark rent payment as paid | `admin`, `accounts` |

### Petty Cash Tab

| Action | Roles |
|--------|-------|
| Submit PC entry | Any authenticated user |
| View all entries | `admin`, `manager`, `accounts` |
| View own entries only | All other roles |
| Approve/issue PC requests | `admin`, `office_admin` (shown in `PettyCashIssuance` component) |

### TDS Tab

| Action | Roles |
|--------|-------|
| View TDS payable/receivable | `admin`, `manager`, `accounts`, `office_admin` |
| Create challan | `admin`, `accounts` (de facto — deposited_by tracked) |

---

## Integration Points with Other Modules

### Procurement Module

The Acc Payables queue is entirely fed by Procurement:
- Bills created in `/procurement/bills` → appear in Acc Payables when `approval_status = 'approved'`
- PO advances queued with `advance_status = 'pending'` → appear in the purple PO Advances panel
- Document chain: clicking a bill in Acc Payables shows the full MR → PO → Delivery Challan / Service Reports → Invoice chain via `GET /api/procurement/bills/[id]/chain`

### Billing / Contract Payments

The `contract_payments` table and `accounting_periods` are used for client-side billing (receivables). The Acc Payables tab (`vendor-payments`) is the payables side only.

### Finance Intelligence

The `finance_suggestion_log` table is used to track which batch-date suggestions, amount anomalies, etc. the system made and whether users accepted them. Configured via `app_settings` keys:
- `finance_intelligence_enabled` (bool string)
- `finance_intelligence_lookback_months`
- `fi_feature_*` toggle keys

Vendor email nag: `GET /api/finance-intelligence/vendor-email-nag/audit` is called on every refresh of the bills list to update the dashboard widget.

### TDS Module (cross-module)

TDS deductions from vendor payments link to `tds_challans`. The `/accounting?tab=tds` page shows both payable (from vendor bill payments) and receivable (TDS deducted by clients on billing statement payments).

TDS org config lives in `app_settings`:
- `tds_tan_number`: `CHEU00102E`
- `tds_entity_name`: `Sree Design Infrastructure Pvt Ltd`
- `tds_entity_pan`: (empty, to be filled)

---

## Known Pitfalls and Gotchas

### 1. `total_amount` IS the pre-GST base (not total-with-GST)

Despite the name, `vendor_bills.total_amount` stores the **pre-GST base amount**. GST is additive and stored in `gst_amount`. The actual payable to the vendor is `total_amount + gst_amount`. This naming confusion is well-established in the codebase and commented in migration 00168.

**Never compute ceiling as just `total_amount`.**

### 2. `approved_amount` can be NULL (means "fully approved")

`approved_amount = NULL` means the full `total_amount` is approved. Only when `approved_amount IS NOT NULL AND approved_amount < total_amount` is there a partial approval. The ceiling formula is:
```
(approved_amount ?? total_amount) + gst_amount
```

### 3. Batch payments require FULL outstanding per bill

Unlike single-bill payments (which allow partial via `partial_reason`), batch payments enforce that each bill's amount equals the full approved outstanding (within ₹0.50). The client pre-populates this amount. If the outstanding changes between loading and submitting, the server validation will fail.

### 4. PO advance pre-credits the bill at creation

When a PO advance is processed, the subsequent vendor bill is created with `amount_paid` pre-populated with the advance amount (no `vendor_bill_payments` row). This makes the bill appear "partially paid" from birth. The detail page shows a purple banner explaining this. Finance should only record the **remaining balance**, not the full invoice amount.

### 5. Cheque email is blocked until signed

For `payment_mode = 'cheque'`, `sendConfirmation` defaults to `false` in the payment dialog. The email is only sent when "Sign Cheque & Send" is clicked. If the sign-cheque step is skipped, the vendor never receives confirmation. The payment history shows "⚠ Sign cheque" as a reminder.

### 6. GST must be set before recording payment — even for zero-GST bills

The `openPaymentDialog()` function checks `!bill.gst_set_at` and shows an error toast if GST hasn't been set. Zero-GST bills still require going through the GST workflow (enter 0, check confirmation box, click Apply). Bills approved before this workflow existed will need GST set retrospectively.

### 7. `upi` is a valid payment mode for rent but NOT for vendor bills

Rent payments accept `upi` (`mark-paid` route Zod schema includes it). Vendor bill payments do not include `upi` in their mode list. Do not add `upi` to vendor bill payment mode without updating both the Zod schema and the batch payment schema.

### 8. Cash payment mode restricted at role level

`accounts` → bank modes only (not cash). `office_admin` → cash only. `admin` → all. This is enforced server-side in both the single-payment PATCH handler and the batch payment POST handler. The client also restricts UI based on `canRecordCash = userRole === "admin" || userRole === "office_admin"`.

### 9. Vendor email nag is non-blocking but warning shows high priority

Missing vendor email is flagged in the dashboard widget and inside the payment dialog (`VendorEmailBanner` with `forceShow` and `hideSkip`). The banner CANNOT be skipped — the accounts user must add the email before proceeding. The payment itself can still be recorded (the send-confirmation toggle gets set to false), but the confirmation email won't go out.

### 10. `payment_hold_resolved_at` field is named differently in the type vs DB

In `ChainData.bill` TypeScript type (detail page), the field is `payment_hold_resolved_at`. In the migration (00160), the DB column is `payment_hold_resolved_at` as well — they match. But `payment_hold_resolved_by` in the type is `hold_resolver` (a joined user object), while the raw column is `payment_hold_resolved_by` UUID.

### 11. Expense classification (`classifyExpense`) logic

```typescript
if (!dept) return "unclassified"
if (dept === "asset") return "capex"
if (expType === "capital") return "capex"
return "opex"
```

Direct-expense bills (no PO) that lack `manual_department` are shown as "Unclassified" with a "Tag now" link. Finance can tag them without going to Procurement.

### 12. Batch bucket "overdue" escalation

A bill with `payment_batch_type = '15th'` or `'25th'` is moved into the Immediate bucket if its `payment_batch_date < today`. This is computed client-side in `batchBuckets`. Server filtering is separate — the API doesn't handle this escalation.

---

## Environment and Config Dependencies

### `app_settings` Table Keys

| Key | Value | Purpose |
|-----|-------|---------|
| `tds_tan_number` | `CHEU00102E` | TAN for TDS deductions |
| `tds_entity_name` | `Sree Design Infrastructure Pvt Ltd` | Entity name for Form 16A/26Q |
| `tds_entity_pan` | (empty) | Entity PAN |
| `finance_intelligence_enabled` | `'true'` | Master toggle for finance intelligence features |
| `finance_intelligence_lookback_months` | `'6'` | History lookback for suggestions |
| `fi_feature_batch_date_suggestion` | `'true'` | Batch date suggestions on/off |
| `fi_feature_duplicate_detector` | `'true'` | Duplicate bill detection |

### Environment Variables

No specific env vars for the Acc Payables module itself. Email sending uses standard SMTP/Resend vars. File storage (invoice scans) uses Backblaze B2 vars.

---

## Key User Flows

### Flow 1: Recording a Standard Vendor Payment

1. Navigate to `/accounting?tab=vendor-payments` (default tab).
2. The page loads approved bills from `GET /api/procurement/bills?approval_status=approved&limit=500`.
3. Bills are split into Pending and Payment History sections.
4. Cash-flow bucket strip shows totals by batch type (Immediate, 15th, 25th, Unscheduled).
5. User clicks a bill row → navigates to `/accounting/vendor-payments/[id]`.
6. Detail page loads full chain via `GET /api/procurement/bills/[id]/chain`.
7. TDS sections are pre-fetched from `GET /api/tds/sections`.
8. User clicks "Record Payment" → `openPaymentDialog()` checks:
   - GST is set (`gst_set_at IS NOT NULL`) — if not, toast error
   - No unapplied GST input in progress
9. Payment dialog opens. TDS suggestion is fetched from `GET /api/tds/suggest?vendor_id=&po_type=`.
10. If vendor has no email, `VendorEmailBanner` is shown first (cannot be bypassed).
11. User fills: amount (pre-populated with approved outstanding), payment mode, UTR reference, payment date.
12. If amount < approved outstanding, `partial_reason` dropdown appears.
13. If TDS applicable (auto-suggested or manually enabled):
    - User selects section, vendor type, enters pre-GST base amount
    - TDS amount = `round(base × rate / 100)`
    - Net to vendor = payment amount − TDS amount
14. User clicks "Record Payment" → `handleRecordPayment()` validates client-side.
15. Confirmation dialog appears showing all details.
16. User confirms → `executeRecordPayment()` calls `PATCH /api/procurement/bills/[id]` with `action: "record_payment"`.
17. On success, if `sendConfirmation = true`, calls `POST /api/procurement/bills/[id]/payment-email`.
18. Page refreshes chain data.

### Flow 2: Batch Payment (2+ Bills)

1. In the pending bills table, user selects 2+ bill checkboxes.
2. "Pay N bills · ₹X" button appears.
3. User clicks → batch wizard opens (step 0: GST review per bill, step 1: payment details).
4. User sets payment date, mode (same for all), UTR reference, notes.
5. Optionally enables TDS per bill.
6. Submits → `POST /api/accounting/batch-payment`.
7. Server validates ALL bills before touching any (pre-validation pass).
8. Processes sequentially: update GST if changed → insert `vendor_bill_payments` row → optionally insert `vendor_bill_tds` row → update `vendor_bills` totals.
9. Returns 207 if some failed, 200 if all succeeded.
10. Toast shows success count and any failures.

### Flow 3: Place / Release Payment Hold

**Place hold** (accounts/admin/office_admin):
1. Click "Hold Payment" on detail page.
2. Select reason from: `wrong_scan`, `wrong_bank_details`, `bank_rejected`, `amount_mismatch`, `duplicate_suspected`, `pending_docs`, `other`.
3. Optionally add notes.
4. `PATCH /api/procurement/bills/[id]` with `action: "hold_payment"`.
5. Bill shows orange "Payment On Hold" badge. Record Payment button disappears.

**Release hold** (admin/manager only):
1. "Release Hold" button visible only to admin/manager.
2. Optionally add resolution notes.
3. `PATCH /api/procurement/bills/[id]` with `action: "release_hold"`.
4. `payment_hold_status` → `'none'`. Record Payment button re-appears.

### Flow 4: GST Workflow on a Bill

1. Detail page shows "GST Amount Not Set" amber box if `gst_set_at IS NULL`.
2. Accounts user enters GST amount (number input).
3. If amount = 0, must check confirmation box.
4. Clicks "Apply" → `PATCH /api/procurement/bills/[id]` with `action: "update_gst"`.
5. Server validates: gst_amount ≤ 28% of total_amount.
6. Sets `gst_amount`, `gst_set_by`, `gst_set_at`. If zero: also sets `gst_zero_confirmed`, `gst_zero_confirmed_by`.
7. Payment ceiling recalculates. `payAmount` input pre-populates with new approved outstanding.

### Flow 5: Rent Payment

1. Navigate to `/accounting?tab=rent`.
2. "Approved — Ready to Pay" view fetches `GET /api/accounting/rent-payments?view=pending` which returns `status IN ('approved', 'on_hold')` records.
3. User clicks "Mark Paid" on a row.
4. Dialog: paid_date (required), payment_mode (required), payment_reference (required, min 1 char), optionally bank_account_id.
5. `POST /api/accounting/rent-payments/[id]/mark-paid`.
6. Server: checks status = 'approved', not already paid.
7. Sets status → 'paid', records paid_date, payment_mode, payment_reference.

### Flow 6: TDS Payable Management

1. `/accounting?tab=tds` → TDS Payable panel.
2. Lists `vendor_bill_tds` records with `status = 'pending'`.
3. Admin/accounts groups pending deductions by period/section.
4. Records ITNS 281 challan: BSR code, challan serial, deposit date, total amount.
5. `POST /api/tds/challans` creates `tds_challans` row.
6. Links pending TDS rows to challan → updates `status` to `'deposited'`.
7. TDS Receivable panel shows TDS deducted by clients from billing statement payments.
