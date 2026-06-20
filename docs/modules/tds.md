# TDS

## Purpose and Business Context

The TDS (Tax Deducted at Source) module covers two distinct flows within TWV CRM:

1. **TDS Payable** — TDS that *The WorkVilla* (Sree Design Infrastructure Pvt Ltd) deducts when paying vendors for services. The company withholds a percentage of the vendor payment, deposits it to the Income Tax department via ITNS 281 challan, then files Form 26Q quarterly and issues Form 16A certificates to each vendor.

2. **TDS Receivable** — TDS that *clients* deduct from their payments to The WorkVilla. When a corporate client pays a billing statement, they may withhold TDS on the invoice. The cash received is net; the TDS shortfall is declared explicitly by the operator and counts toward settlement of the invoice. The company later claims this TDS credit in its annual IT return by reconciling against Form 26AS.

**Entity details (hard-coded in DB seed and referenced throughout the codebase):**
- TAN: `CHEU00102E`
- Entity name: `Sree Design Infrastructure Pvt Ltd`
- Filing form: Form 26Q (non-salary deductions)

---

## Routes

| Route | File | What it renders |
|---|---|---|
| `/accounting/tds` (tab) | `src/app/(dashboard)/accounting/tds/page.tsx` embedded as `TdsPayablePage` inside `src/app/(dashboard)/accounting/page.tsx` | Two-tab page: TDS Payable and TDS Receivable |

The TDS page is **not a standalone route** — it is imported and rendered as the `tds` tab of the `/accounting` page:

```
<TabsContent value="tds" className="mt-0">
  <TdsPayablePage />
</TabsContent>
```

The accounting page mounts `TdsPayablePage` directly from `./tds/page`. The tab trigger is labelled "TDS Payable" even though the page itself also has a TDS Receivable sub-tab.

---

## Key Source Files

| File | Purpose |
|---|---|
| `src/app/(dashboard)/accounting/tds/page.tsx` | Single-file page: all components inlined (no separate component files) |
| `src/app/(dashboard)/accounting/page.tsx` | Host for the TDS tab; also contains batch-payment TDS logic for vendor bills |
| `src/app/(dashboard)/accounting/vendor-payments/[id]/page.tsx` | Vendor bill payment dialog — TDS deduction entry point |
| `src/app/api/tds/payable/route.ts` | `GET /api/tds/payable` — list vendor_bill_tds entries |
| `src/app/api/tds/challans/route.ts` | `GET/POST /api/tds/challans` — list and record ITNS 281 challans |
| `src/app/api/tds/receivable/route.ts` | `GET /api/tds/receivable` — billing payments with TDS deducted by clients |
| `src/app/api/tds/26q/route.ts` | `GET /api/tds/26q` — generate 26Q CSV export |
| `src/app/api/tds/form16a/route.ts` | `GET /api/tds/form16a` — data for Form 16A PDF per vendor per quarter |
| `src/app/api/tds/sections/route.ts` | `GET /api/tds/sections` — list all TDS section codes from lookup table |
| `src/app/api/tds/suggest/route.ts` | `GET /api/tds/suggest` — auto-suggest TDS section based on vendor category + PO type |
| `src/app/api/procurement/bills/[id]/route.ts` | PATCH `action: record_payment` — inserts `vendor_bill_tds` row atomically with payment |
| `src/app/api/billing-statements/[id]/payment/route.ts` | POST — records client payment with TDS columns |
| `src/lib/tally/enqueue.ts` | `enqueueTallyReceiptVoucher` — maps TDS section to Tally ledger, enqueues receipt voucher job |
| `src/lib/constants.ts` | `TDS_CLIENT_SECTIONS`, `TDS_SECTIONS`, `TDS_SECTION_LABELS`, `TDS_DEFAULT_RATES` |
| `src/components/billing/view-statement-dialog.tsx` | Statement dialog — TDS receivable entry on client payments |
| `src/app/(dashboard)/billing/page.tsx` | Billing list — record payment dialog with TDS receivable capture |

---

## Data Model

### `tds_sections` (lookup table, migration 00158)

Static reference. Managed via migrations only — no INSERT/UPDATE policies for authenticated users (only SELECT).

| Column | Type | Notes |
|---|---|---|
| `code` | `TEXT` PRIMARY KEY | e.g. `194C`, `194J_a`, `194J_b`, `194I_a`, `194I_b`, `194H` |
| `description` | `TEXT NOT NULL` | Human-readable description |
| `rate_individual` | `NUMERIC(5,2) NOT NULL` | Rate for individuals/HUF |
| `rate_company` | `NUMERIC(5,2) NOT NULL` | Rate for companies |
| `rate_min` | `NUMERIC(5,2) NOT NULL` | Minimum applicable rate |
| `rate_max` | `NUMERIC(5,2) NOT NULL` | Maximum applicable rate |

**Seeded rows:**

| code | description | rate_individual | rate_company |
|---|---|---|---|
| `194C` | Contractors & Sub-contractors | 1.00 | 2.00 |
| `194J_a` | Technical Services | 2.00 | 2.00 |
| `194J_b` | Professional Services | 10.00 | 10.00 |
| `194I_a` | Rent – Plant & Machinery | 2.00 | 2.00 |
| `194I_b` | Rent – Land / Building | 10.00 | 10.00 |
| `194H` | Commission & Brokerage | 5.00 | 5.00 |

**Section 206AA override:** If `pan_available = false`, the effective rate is always **20%** regardless of section. This is enforced in the suggest API and in the payment dialog UI, but NOT by a DB constraint — the business logic lives in code.

**RLS:** `SELECT` for all `authenticated` users; no write policies (migration 00163).

---

### `vendor_bill_tds` (migration 00158, FK wired in 00159)

One row per TDS deduction event — created atomically when a vendor payment is recorded.

| Column | Type | Constraints / Notes |
|---|---|---|
| `id` | `UUID` PRIMARY KEY | `gen_random_uuid()` |
| `bill_id` | `UUID NOT NULL` | FK → `vendor_bills(id)` ON DELETE CASCADE |
| `payment_id` | `UUID` nullable | FK → `vendor_bill_payments(id)` ON DELETE SET NULL |
| `section_code` | `TEXT NOT NULL` | FK → `tds_sections(code)` |
| `vendor_type` | `TEXT NOT NULL DEFAULT 'company'` | CHECK `IN ('individual', 'huf', 'company')` |
| `base_amount` | `NUMERIC(12,2) NOT NULL` | CHECK `> 0`; pre-GST amount — TDS is NEVER on GST |
| `tds_rate` | `NUMERIC(5,2) NOT NULL` | CHECK `> 0` |
| `tds_amount` | `NUMERIC(12,2) NOT NULL` | CHECK `> 0` |
| `pan_available` | `BOOLEAN NOT NULL DEFAULT true` | If false, rate must be 20 per 206AA |
| `status` | `TEXT NOT NULL DEFAULT 'pending'` | CHECK `IN ('pending', 'deposited')` |
| `challan_id` | `UUID` nullable | FK → `tds_challans(id)` ON DELETE SET NULL (added migration 00159) |
| `period_month` | `INT NOT NULL` | CHECK `BETWEEN 1 AND 12`; derived from payment date |
| `period_year` | `INT NOT NULL` | CHECK `>= 2020`; calendar year (NOT FY year) |
| `created_by` | `UUID NOT NULL` | FK → `users(id)` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

**Indexes:** `idx_vbt_bill`, `idx_vbt_status`, `idx_vbt_period`, `idx_vbt_section`, `idx_vbt_challan`

**RLS:** SELECT/INSERT/UPDATE for all `authenticated` users. Role guard enforced at API level, not DB level.

---

### `tds_challans` (migration 00159)

One row per ITNS 281 challan deposit — covers all pending TDS entries for a month+section combination.

| Column | Type | Constraints / Notes |
|---|---|---|
| `id` | `UUID` PRIMARY KEY | |
| `challan_ref` | `TEXT UNIQUE NOT NULL` | System-generated: `TDSC-YYMM-NNN` (e.g. `TDSC-202605-001`) |
| `bsr_code` | `VARCHAR(7) NOT NULL` | Bank branch BSR code — exactly 7 digits |
| `challan_serial` | `VARCHAR(10) NOT NULL` | Bank challan serial number |
| `deposit_date` | `DATE NOT NULL` | Date paid to bank |
| `period_month` | `INT NOT NULL` | CHECK `BETWEEN 1 AND 12` |
| `period_year` | `INT NOT NULL` | CHECK `>= 2020` |
| `section_code` | `TEXT NOT NULL` | FK → `tds_sections(code)` |
| `total_amount` | `NUMERIC(12,2) NOT NULL` | CHECK `> 0` |
| `receipt_url` | `TEXT` nullable | Optional scan/upload |
| `notes` | `TEXT` nullable | |
| `deposited_by` | `UUID NOT NULL` | FK → `users(id)` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

**`challan_ref` generation algorithm** (server-side, not DB-generated):
```
prefix = "TDSC-{period_year}{period_month:02d}"
seq    = COUNT(existing challans LIKE prefix%) + 1 padded to 3 digits
ref    = "{prefix}-{seq}"   → e.g. TDSC-202605-001
```
This has a **race condition** — if two challans are created simultaneously for the same period, the count-then-insert can duplicate the sequence number. The `UNIQUE` constraint on `challan_ref` will catch it at the DB level and surface a 500.

**Indexes:** `idx_tds_challans_period`, `idx_tds_challans_section`

**RLS:** SELECT/INSERT/UPDATE for all `authenticated` users. Role guard at API level.

---

### `billing_payments` — TDS receivable columns (migration 00243)

Two columns added to the existing `billing_payments` table to track TDS deducted by clients:

| Column | Type | Notes |
|---|---|---|
| `tds_amount` | `NUMERIC NOT NULL DEFAULT 0` | Client's TDS deduction. 0 = normal payment. No constraint `> 0` — zero is valid for non-TDS payments |
| `tds_section` | `TEXT` nullable | Section code as entered by operator (free-form string, not FK-constrained to `tds_sections`) |

**Settlement logic (critical):** `total_paid = SUM(amount + tds_amount)`. A payment where the client deducted TDS is settled as: cash received (`amount`) + TDS withheld (`tds_amount`) = invoice total. The TDS shortfall is NEVER inferred — operators must explicitly declare it. A short payment without a declared TDS amount leaves the statement partially paid (balance still owed).

---

### `property_leases` — rent TDS columns (migration 00177)

Separate TDS subsystem for outgoing rent payments (not tracked in `vendor_bill_tds`):

| Column | Type | Constraints |
|---|---|---|
| `tds_applicable` | `BOOLEAN NOT NULL DEFAULT true` | |
| `tds_section` | `TEXT NOT NULL DEFAULT '194I'` | CHECK `IN ('194I', '194IB')` only — narrower than the vendor TDS section set |
| `tds_rate` | `NUMERIC(5,2) NOT NULL DEFAULT 10.00` | |

The `lease_payments` table has:
| Column | Type | Notes |
|---|---|---|
| `tds_amount` | `NUMERIC(12,2) NOT NULL DEFAULT 0` | TDS withheld from rent payment |
| `net_amount_paid` | `NUMERIC(12,2)` nullable | Gross minus TDS |

Rent TDS uses a separate type alias: `type TdsSection = "194I" | "194IB"` (in `src/types/index.ts`). Constants in `src/lib/constants.ts`: `TDS_SECTIONS`, `TDS_SECTION_LABELS`, `TDS_DEFAULT_RATES`. This is **completely separate** from vendor TDS and does NOT appear in the `/accounting/tds` module.

---

### `app_settings` — TDS org config keys

Three keys seeded in migration 00159. Used by `/api/tds/26q` and `/api/tds/form16a` when generating reports:

| key | seeded value | Purpose |
|---|---|---|
| `tds_tan_number` | `CHEU00102E` | Deductor TAN for 26Q and Form 16A headers |
| `tds_entity_name` | `Sree Design Infrastructure Pvt Ltd` | Deductor name |
| `tds_entity_pan` | `""` (empty) | Deductor PAN (not yet populated at migration time) |

These can be updated via the `app_settings` table directly. If `tds_entity_name` is missing from `app_settings`, the 26Q and Form 16A routes fall back to the hardcoded string `"Sree Design Infrastructure Pvt Ltd"`.

---

## Status Lifecycle

### TDS Payable (vendor_bill_tds.status)

```
pending → deposited
```

Only two states, no reversal. The transition from `pending` to `deposited` is triggered when a challan is recorded via `POST /api/tds/challans`. The API updates ALL `tds_entry_ids` atomically in a single `UPDATE ... IN (...)` call after the challan row is inserted.

There is no `void` or `cancelled` state. If a challan is incorrectly recorded, it must be handled directly in the database.

---

## Business Rules

### TDS Payable

1. **TDS is always on the pre-GST base amount.** Never on GST. The `base_amount` field is the pre-GST figure; `tds_amount = base_amount × tds_rate / 100`.

2. **No PAN → 20% rate (Section 206AA).** If `pan_available = false`, the effective rate must be 20% regardless of section. Enforced in the suggest API and the UI; not enforced by a DB constraint.

3. **TDS is optional at payment time.** An accounts user can record a vendor payment with or without TDS. TDS is never auto-deducted — the operator enables it explicitly.

4. **Goods POs → no TDS.** The suggest API returns `tds_applicable: false` when `po_type = "goods"`.

5. **Vendor category drives suggested section:**
   - `maintenance` → `194C`
   - `administration` → `194J_b`
   - `general` → `194J_a`
   - `pantry` → no TDS

6. **Deposit deadline:** TDS must be deposited by the **7th of the following month**. Exception: TDS deducted in **March** must be deposited by **30th April** (FY end). This logic lives in `depositDueDate()` and `isOverdue()` in the page component.

7. **Late deposit penalty:** 1.5% per month (Section 201(1A)) — informational only, not calculated by the system.

8. **Challan covers one section per period.** Each `tds_challans` row has one `section_code`. A month with multiple sections requires multiple challans.

9. **Period year/month = calendar year of payment date.** The `period_year` is NOT the financial year — it is the calendar year extracted from `paymentDate`. Q4 TDS (Jan–Mar) therefore has `period_year = calYear+1`.

### TDS Receivable

1. **Operator-declared only.** The system never infers TDS from a short payment. An unexplained short payment stays partially paid.

2. **Settlement arithmetic:** `payment_status = paid` when `SUM(amount + tds_amount) >= statement.total_amount`. The `tds_amount` on the payment row contributes to settlement.

3. **`tds_section` on `billing_payments` is a free-text string** (not FK-constrained). The client sections available in the UI are defined in `TDS_CLIENT_SECTIONS` in `src/lib/constants.ts`: `194C`, `194I`, `194J`, `194H`.

4. **Reconcile against Form 26AS.** The system does not connect to TRACES. The TDS Receivable tab is for internal reconciliation only — the company must separately download Form 26AS from the Income Tax portal.

---

## Validation Rules

### Challan creation (POST /api/tds/challans)

Enforced server-side via Zod schema (`createChallanSchema`):

| Field | Rule | Where enforced |
|---|---|---|
| `bsr_code` | `string.length(7)` exactly 7 characters | Zod (server) + UI strips non-digits and caps at 7 |
| `challan_serial` | `string.min(1).max(10)` | Zod (server) |
| `deposit_date` | `string.min(1)` | Zod (server); UI defaults to today |
| `period_month` | `int.min(1).max(12)` | Zod (server) + DB CHECK |
| `period_year` | `int.min(2020)` | Zod (server) + DB CHECK |
| `section_code` | `string.min(1)` | Zod (server) |
| `total_amount` | `number.positive()` | Zod (server) |
| `tds_entry_ids` | `array(uuid).min(1)` | Zod (server) |

UI additionally validates BSR before calling the API: `if (!bsr || bsr.length !== 7) { toast.error("BSR code must be exactly 7 digits"); return; }`.

### TDS vendor payment (`action: record_payment` with `tds` payload)

Enforced by `tdsSchema` in `src/app/api/procurement/bills/[id]/route.ts`:

| Field | Rule |
|---|---|
| `section_code` | `string.min(1)` |
| `vendor_type` | `enum(['individual','huf','company'])`, default `'company'` |
| `base_amount` | `number.positive()` |
| `tds_rate` | `number.positive()` |
| `tds_amount` | `number.positive()` |
| `pan_available` | `boolean`, default `true` |

UI validation (in `vendor-payments/[id]/page.tsx`) before submitting:
- `tdsSectionCode` must be set
- `tdsBaseAmount` must be > 0
- `tdsAmount` must be > 0

### TDS receivable (POST /api/billing-statements/[id]/payment)

No Zod schema for the TDS fields — validation is minimal:
- `tds_amount = Math.max(0, Number(body.tds_amount) || 0)` — coerced to 0 if absent/invalid
- `tds_section = body.tds_section?.trim() || null` — empty string becomes null

**Gotcha:** An empty-string `tds_section` with `body.tds_section = ""` results in `null` being stored. The check is `body.tds_section.trim()` — a blank/whitespace string correctly becomes null.

---

## Role Permissions

### TDS Payable Module (`/accounting/tds`)

| Action | Allowed roles |
|---|---|
| View TDS Payable list (`GET /api/tds/payable`) | `admin`, `manager`, `accounts`, `office_admin` |
| Record challan (`POST /api/tds/challans`) | `admin`, `accounts`, `office_admin` |
| View challans (`GET /api/tds/challans`) | `admin`, `accounts`, `office_admin` |
| Generate 26Q CSV (`GET /api/tds/26q`) | `admin`, `accounts`, `office_admin` |
| Generate Form 16A data (`GET /api/tds/form16a`) | `admin`, `accounts`, `office_admin` |
| View TDS sections (`GET /api/tds/sections`) | All authenticated users |
| TDS suggest (`GET /api/tds/suggest`) | All authenticated users |

### TDS Receivable

| Action | Allowed roles |
|---|---|
| View TDS receivable (`GET /api/tds/receivable`) | All authenticated users (no role check in this route) |
| Record client payment with TDS (`POST /api/billing-statements/[id]/payment`) | `admin`, `manager`, `accounts` |

---

## API Routes Reference

### `GET /api/tds/payable?status=pending|deposited|all`

Returns `vendor_bill_tds` rows with joins to `vendor_bills`, `procurement_vendors`, `tds_challans`, `tds_sections`, and creator user. Ordered by `period_year DESC, period_month DESC, created_at DESC`.

Default status filter: `pending`.

### `GET /api/tds/challans?year=YYYY&month=MM`

Returns `tds_challans` rows with `depositor` user and `section`. Optional filters by year/month.

### `POST /api/tds/challans`

Creates a challan and atomically updates all `tds_entry_ids` to `status = 'deposited'` with `challan_id` set.

Returns: `{ data: { id, challan_ref } }`

### `GET /api/tds/receivable?fy_year=YYYY&quarter=1|2|3|4`

Queries `billing_payments` where `tds_amount > 0`, filtered by payment date range. Joins through `billing_statements → contracts → leads` to get client name and PAN.

Returns: `{ rows, summary: { grand_total, by_section, count }, period }`.

Quarter-to-month mapping (FY basis):
- Q1: months 4,5,6 (calendar year = fy_year)
- Q2: months 7,8,9 (calendar year = fy_year)
- Q3: months 10,11,12 (calendar year = fy_year)
- Q4: months 1,2,3 (calendar year = fy_year+1)

### `GET /api/tds/26q?quarter=1-4&year=YYYY`

Returns only `deposited` TDS entries (i.e., entries with a linked challan). Fetches org settings (`tds_tan_number`, `tds_entity_name`, `tds_entity_pan`) from `app_settings`. Returns flat CSV-ready rows.

**Important:** Only deposited entries appear in 26Q. Pending entries are excluded.

### `GET /api/tds/form16a?vendor_id=UUID&quarter=1-4&year=YYYY`

Returns only deposited entries for the specified vendor in the quarter. Form 16A PDF is generated **client-side** using jsPDF in the browser from this data. The API returns JSON — it does not return a PDF.

Vendor filtering: entries are fetched by `period_month IN months AND period_year = calYear`, then filtered in memory by `entry.bill.vendor_id === vendorId`. This means the query fetches all deposited entries for the quarter and filters in JS — not a DB-level vendor filter.

### `GET /api/tds/sections`

Returns all rows from `tds_sections` ordered by `code`. No role check.

### `GET /api/tds/suggest?vendor_id=UUID&po_type=goods|service`

- `po_type = "goods"` → always returns `{ tds_applicable: false, section_code: null }`
- No `vendor_id` → returns `{ tds_applicable: false }`
- Looks up `procurement_vendors.category` and maps to section via `CATEGORY_SECTION_MAP`
- If no mapping found → `{ tds_applicable: false }`
- If PAN missing → `suggested_rate: 20` (Section 206AA)

---

## User Flows

### TDS Payable: Record payment with TDS

1. Navigate to Finance > Acc Payables → open an approved vendor bill.
2. In the payment dialog, the system calls `GET /api/tds/suggest?vendor_id=...&po_type=...` to pre-populate section and rate.
3. Operator enables the "TDS Deduction" toggle.
4. Selects TDS section from dropdown (populated from `GET /api/tds/sections`).
5. Enters the **pre-GST base amount** (not total invoice amount).
6. System calculates `tds_amount = base_amount × rate / 100`.
7. System displays `net_to_vendor = payment_amount - tds_amount`.
8. On submit, `PATCH /api/procurement/bills/[id]` with `action: record_payment` and `tds: {...}` payload.
9. API inserts `vendor_bill_payments` row first, then inserts `vendor_bill_tds` row with `payment_id` linkage and `period_month/year` derived from payment date.

### TDS Payable: Deposit to government and record challan

1. Pay the TDS via ITNS 281 challan at bank (online/branch). Obtain BSR code, challan serial, deposit date.
2. Navigate to Finance > TDS → TDS Payable tab.
3. Expand the relevant month group.
4. Click "Record Challan" next to the section with pending entries.
5. Enter BSR code (7 digits), challan serial, deposit date.
6. Submit → `POST /api/tds/challans` → creates challan row and marks all listed entries as `deposited`.

### TDS Payable: Generate 26Q CSV

1. Navigate to Finance > TDS → Reports & Exports panel.
2. Select quarter and FY start year.
3. Click "Download 26Q CSV".
4. `GET /api/tds/26q?quarter=N&year=YYYY` — returns only deposited entries.
5. CSV is generated client-side and downloaded.
6. Upload CSV to TRACES (www.tdscpc.gov.in) before filing deadline.

### TDS Payable: Generate Form 16A

1. In Reports & Exports, select quarter, year, and vendor (dropdown populated from deposited entries).
2. Click "Download Form 16A PDF".
3. `GET /api/tds/form16a?vendor_id=...&quarter=N&year=YYYY` returns JSON.
4. jsPDF generates PDF entirely in the browser. The PDF includes: deductor details, deductee details, a row per bill (bill number, invoice date, section, base amount, rate, TDS amount, BSR/challan, deposit date), and totals.
5. Issue PDF to vendor within 15 days of the 26Q filing deadline.

### TDS Receivable: Record client payment with TDS

**From billing page (`/billing`):**
1. Open a finalized billing statement.
2. Click "Record Payment".
3. Toggle "Client deducted TDS on this payment".
4. Select TDS section from `TDS_CLIENT_SECTIONS` dropdown (`194C`, `194I`, `194J`, `194H`).
5. Enter TDS amount (cash received is separate — the full invoice amount is declared implicitly).
6. Submit → `POST /api/billing-statements/[id]/payment` with `tds_amount` and `tds_section`.
7. Settlement check: `SUM(amount + tds_amount) >= statement.total_amount` → marks as `paid`.

**From view-statement-dialog (`src/components/billing/view-statement-dialog.tsx`):**
Same flow with identical logic, different UI entry point.

---

## Integration Points

### Procurement Module

TDS on vendor payments originates in `/accounting/vendor-payments/[id]` and the batch-payment flow in `/accounting` (tab `vendor-payments`). Both write to `vendor_bill_tds`. The batch payment handler in `accounting/page.tsx` also supports per-bill TDS using the same `tdsSchema` structure.

### Billing / Receivables Module

TDS receivable is captured in `billing_payments.tds_amount` and `billing_payments.tds_section`. The settlement computation in `billing-statements/[id]/payment` and `billing/page.tsx` both use `amount + tds_amount` for the paid total.

### Tally Integration

When a client payment is recorded with TDS (legacy bridge mode, i.e., `handoff_v2` flag OFF), `enqueueTallyReceiptVoucher` maps the `tds_section` to a Tally ledger name via `TDS_LEDGER_MAP`. All client-side TDS sections map to the single ledger `"TDS Paid (Deducted by the Party)"`. The bridge enqueues a `receipt_voucher` job in `tally_sync_jobs` with:
- `amount`: net cash received
- `tds_amount`: customer's deduction
- `tds_section`: section code
- `tds_ledger`: resolved Tally ledger name

When `handoff_v2` is ON, Tally receipt entry is done directly by accounts; the bridge does not enqueue receipt vouchers.

### Rent Management Module

Property leases (`property_leases`) have their own TDS fields (`tds_applicable`, `tds_section` constrained to `194I`/`194IB`, `tds_rate`) and lease payments track `tds_amount`. This is an entirely separate subsystem that does NOT feed into `vendor_bill_tds` or appear on the `/accounting/tds` page.

### Payroll

`salary_definitions.tds_applicable` and `salary_definitions.tds_monthly_amount` (Section 192). `payroll_runs.tds_deduction` tracks TDS per payroll run. Also separate from the vendor TDS module — not surfaced on the TDS page.

---

## Fiscal Year and Quarter Mapping

The codebase uses two different FY conventions:

**For TDS Receivable (`/api/tds/receivable`):**
- FY start year is passed as `fy_year` parameter (e.g., `2024` means FY 2024-25)
- Q4 (Jan–Mar) uses `calYear = fy_year + 1`
- Date filter is constructed as date ranges on `billing_payments.payment_date`

**For TDS Payable (`vendor_bill_tds`):**
- `period_year` stores the **calendar year** of the payment date
- Q4 entries (Jan–Mar) have `period_year = next_calendar_year`
- The 26Q route accounts for this: `calYear = quarter === 4 ? year + 1 : year`

**26Q filing deadlines:**
- Q1 (Apr–Jun): 31 July
- Q2 (Jul–Sep): 31 October
- Q3 (Oct–Dec): 31 January
- Q4 (Jan–Mar): 31 May

**Deposit deadline:** 7th of the following month; March → 30th April.

---

## Known Pitfalls and Gotchas

1. **`period_year` is calendar year, not FY year.** A deduction in January 2026 has `period_year = 2026`, which belongs to FY 2025-26. The 26Q query must adjust for Q4 (`calYear = year + 1`). The receivable route does the same adjustment. Missing this causes Q4 data to be empty.

2. **Form 16A vendor filter is in-memory, not SQL.** The API fetches all deposited entries for the quarter and filters by `bill.vendor_id === vendorId` in JavaScript. If a vendor has many bills across many vendors in the same quarter, this is wasteful. A bug here would be accidentally including entries from other vendors.

3. **`challan_ref` has a race condition.** The sequential reference number (TDSC-YYMM-NNN) uses count-then-insert with no locking. Simultaneous challan creation for the same period can produce a duplicate ref that fails on the UNIQUE constraint. Handle the 500 error gracefully on the client.

4. **`tds_section` on `billing_payments` is not FK-constrained.** Any string can be stored. If a caller passes `"194I_b"` (vendor TDS style with underscore) instead of `"194I"` (client TDS style without underscore), both are stored. The receivable tab groups by section code, so mixed formats produce separate summary cards.

5. **Vendor TDS section codes use underscore notation** (`194I_a`, `194I_b`, `194J_a`, `194J_b`) matching the `tds_sections.code` primary key. Client TDS sections in constants use no underscore (`194C`, `194I`, `194J`, `194H`). These are different sets. The `fmtSection()` helper in the page converts `194J_b` → `194J(b)` for display.

6. **No PAN → 20% is business logic only.** The DB allows any `tds_rate` value. The 20% enforcement happens in the suggest API (`effectiveRate = panAvailable ? section.rate_company : 20`) and in the payment dialog UI (resetting rate to 20 when PAN toggle is turned off). A direct API call can store any rate.

7. **TDS Receivable has no role guard in its API route.** `GET /api/tds/receivable` only checks `user` (session exists) and does not verify role. Any authenticated user can access it.

8. **Reports panel vendor list is populated from deposited entries only.** The `ReportsPanel` fetches vendors from `GET /api/tds/payable?status=deposited`. If a vendor has TDS entries but no challan yet (all pending), they won't appear in the Form 16A vendor dropdown.

9. **Form 16A PDF is purely client-side.** No server-side PDF is stored. Each generation is ephemeral. There is no history of Form 16A issuance.

10. **Batch payment TDS in `/accounting` page.** The Acc Payables batch payment flow in `accounting/page.tsx` (not the individual payment page) also supports per-bill TDS. The TDS state is maintained in a `batchTds: Record<string, BatchTdsState>` map keyed by `bill_id`. The same `POST /api/accounting/batch-payment` route accepts the `tds` payload per bill.

11. **`tds_entity_pan` seeded as empty string.** The entity PAN in `app_settings` was seeded blank. If not updated, Form 16A and 26Q will have an empty `deductor_pan` field. This must be populated manually in `app_settings`.

---

## Environment / Config Dependencies

| Dependency | Key/Setting | Notes |
|---|---|---|
| `app_settings` table key `tds_tan_number` | `CHEU00102E` (seeded) | Required for 26Q and Form 16A headers |
| `app_settings` table key `tds_entity_name` | `Sree Design Infrastructure Pvt Ltd` (seeded) | Falls back to hardcoded string if missing |
| `app_settings` table key `tds_entity_pan` | `""` (seeded blank) | Must be updated manually |
| Tally handoff v2 flag (`handoff_v2` in `app_settings`) | — | When ON, TDS receipt voucher is NOT enqueued to Tally bridge |

No environment variables are specific to the TDS module. The module uses the standard Supabase client and `createClient()` / `createAdminClient()` pattern.
