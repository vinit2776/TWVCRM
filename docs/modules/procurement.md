# Procurement

## Purpose and Business Context

The Procurement module manages the full inbound supply chain for The WorkVilla coworking space. It covers four sequential workflows:

1. **Material Requests (MR/PR)** — staff raise needs; managers approve or reject
2. **Purchase Orders (PO)** — approved MRs become orders placed with vendors
3. **Goods/Service Delivery** — delivery challans or service completion reports confirm receipt
4. **Vendor Bills (invoices)** — vendor invoices are uploaded, approved by admin/manager, then paid by Accounts from a separate Finance screen

**Critical architectural rule**: Procurement (`/procurement/*`) handles everything up to and including invoice approval. **Payment recording never happens here** — it lives in Finance > Acc Payables (`/accounting/vendor-payments/[id]`). This is a hard separation enforced at the API level.

---

## All Routes

| Route | File | Purpose |
|-------|------|---------|
| `/procurement` | `src/app/(dashboard)/procurement/page.tsx` | Dashboard: KPI cards, budget bars, approval pipeline, intelligence panels |
| `/procurement/requests` | `src/app/(dashboard)/procurement/requests/page.tsx` | List / filter / paginate MRs |
| `/procurement/requests/new` | `src/app/(dashboard)/procurement/requests/new/page.tsx` | Create new MR |
| `/procurement/requests/[id]` | `src/app/(dashboard)/procurement/requests/[id]/page.tsx` | MR detail + approve/reject/resubmit |
| `/procurement/orders` | `src/app/(dashboard)/procurement/orders/page.tsx` | List POs |
| `/procurement/orders/new` | `src/app/(dashboard)/procurement/orders/new/page.tsx` | Create goods PO |
| `/procurement/orders/new-service` | `src/app/(dashboard)/procurement/orders/new-service/page.tsx` | Create service PO |
| `/procurement/orders/[id]` | `src/app/(dashboard)/procurement/orders/[id]/page.tsx` | PO detail + mark ordered/received, add delivery challan / service report, advance payment |
| `/procurement/bills` | `src/app/(dashboard)/procurement/bills/page.tsx` | List vendor bills |
| `/procurement/bills/new` | `src/app/(dashboard)/procurement/bills/new/page.tsx` | Upload new vendor invoice |
| `/procurement/bills/[id]` | `src/app/(dashboard)/procurement/bills/[id]/page.tsx` | Bill detail + approve / reject / update GST / override batch |
| `/procurement/vendors` | `src/app/(dashboard)/procurement/vendors/page.tsx` | Vendor directory: list, create, edit, KYC toggle |
| `/procurement/vendors/[id]` | `src/app/(dashboard)/procurement/vendors/[id]/page.tsx` | Vendor detail + spend analytics + document upload |
| `/procurement/catalog` | `src/app/(dashboard)/procurement/catalog/page.tsx` | Item catalog management |
| `/procurement/catalog/[id]` | `src/app/(dashboard)/procurement/catalog/[id]/page.tsx` | Item detail + price history + order history |
| `/procurement/amc` | `src/app/(dashboard)/procurement/amc/page.tsx` | AMC contract tracking (annual maintenance contracts) |
| `/procurement/inventory` | `src/app/(dashboard)/procurement/inventory/page.tsx` | Inventory view |
| `/procurement/consumption` | `src/app/(dashboard)/procurement/consumption/page.tsx` | Consumption tracking |
| `/procurement/consumption/history` | `src/app/(dashboard)/procurement/consumption/history/page.tsx` | Consumption history |
| `/procurement/transfers` | `src/app/(dashboard)/procurement/transfers/page.tsx` | Stock transfers between locations |
| `/procurement/transfers/new` | `src/app/(dashboard)/procurement/transfers/new/page.tsx` | New stock transfer |
| `/procurement/transfers/[id]` | `src/app/(dashboard)/procurement/transfers/[id]/page.tsx` | Transfer detail |
| `/procurement/payables` | `src/app/(dashboard)/procurement/payables/page.tsx` | Payables overview (redirects to Finance side) |
| `/procurement/verify` | `src/app/(dashboard)/procurement/verify/page.tsx` | Approval code verification |
| `/procurement/electricity` | `src/app/(dashboard)/procurement/electricity/page.tsx` | Electricity sub-billing |

---

## Key Source Files

### Pages
- `src/app/(dashboard)/procurement/page.tsx` — dashboard with KPIs and intelligence panels
- `src/app/(dashboard)/procurement/bills/[id]/page.tsx` — bill detail (1904 lines; most complex page)

### API Routes
| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `GET /api/procurement/dashboard` | GET | Dashboard KPIs and pipeline data |
| `GET /api/procurement/budget` | GET | Department budget rows + AMC budget |
| `GET,POST /api/procurement/requests` | GET, POST | List MRs with filters / pagination; create MR |
| `GET,PATCH /api/procurement/requests/[id]` | GET, PATCH | Fetch MR detail + lifecycle (submit/approve/reject/resubmit) |
| `GET,POST /api/procurement/requests/[id]/quotations` | GET, POST | Manage vendor quotation attachments on an MR |
| `DELETE /api/procurement/requests/[id]/quotations/[quotationId]` | DELETE | Remove quotation |
| `GET,POST /api/procurement/requests/[id]/lifecycle` | POST | Lifecycle transitions |
| `GET,POST /api/procurement/orders` | GET, POST | List / create POs |
| `GET,PATCH /api/procurement/orders/[id]` | GET, PATCH | PO detail; actions: mark_ordered, mark_received, cancel, partial_cancel, process_advance, update_amc_details |
| `GET,POST /api/procurement/orders/[id]/deliveries` | GET, POST | List / add delivery challans to a goods PO |
| `GET,POST /api/procurement/orders/[id]/email` | POST | Send PO to vendor by email |
| `GET,POST /api/procurement/bills` | GET, POST | List / create vendor bills |
| `GET,PATCH /api/procurement/bills/[id]` | GET, PATCH | Bill detail + all actions (approve/reject/pay/gst/hold/etc.) |
| `GET /api/procurement/bills/[id]/chain` | GET | Full MR→PO→bill document chain + audit trail |
| `GET /api/procurement/bills/[id]/timeline` | GET | Timeline entries only |
| `POST /api/procurement/bills/[id]/payment-email` | POST | Send payment confirmation to vendor |
| `POST /api/procurement/bills/check-duplicate` | POST | Duplicate invoice detection (finance intelligence) |
| `GET /api/procurement/bills/export` | GET | CSV export of filtered bills |
| `GET,POST /api/procurement/vendors` | GET, POST | List / create vendors |
| `GET,PATCH,DELETE /api/procurement/vendors/[id]` | GET, PATCH, DELETE | Vendor detail / update / deactivate |
| `POST /api/procurement/vendors/[id]/documents` | POST | Upload KYC document (multipart/form-data) |
| `GET /api/procurement/vendors/[id]/documents` | GET | Get signed URL for a KYC document |
| `GET /api/procurement/vendors/[id]/insights` | GET | Vendor analytics |
| `POST /api/procurement/vendors/[id]/email` | POST | Save vendor email from payment confirmation history |
| `GET,POST /api/procurement/items` | GET, POST | Catalog items |
| `GET,PATCH,DELETE /api/procurement/items/[id]` | GET, PATCH, DELETE | Item detail |
| `GET /api/procurement/items/[id]/history` | GET | Order history for a catalog item |
| `GET /api/procurement/items/[id]/price-history` | GET | Price trend for a catalog item |
| `GET /api/procurement/items/[id]/insights` | GET | Item analytics |
| `GET,POST /api/procurement/amc` | GET, POST | AMC contracts |
| `POST /api/procurement/amc/[id]/events` | POST | Log AMC service event |
| `GET,POST /api/procurement/transfers` | GET, POST | Stock transfers |
| `GET,PATCH /api/procurement/transfers/[id]` | GET, PATCH | Transfer detail |
| `GET,POST /api/procurement/consumption` | GET, POST | Consumption records |
| `GET,PATCH,DELETE /api/procurement/consumption/[id]` | GET, PATCH, DELETE | Consumption record detail |
| `GET /api/procurement/inventory` | GET | Inventory snapshot |
| `GET,POST /api/procurement/service-reports` | GET, POST | Service reports |
| `GET,POST /api/procurement/vendor-prices` | GET, POST | Vendor-item price records |
| `GET,POST /api/procurement/reorder-config` | GET, POST | Reorder point config per item |
| `GET,POST /api/procurement/batch-summary` | GET | Payment batch summary |
| `GET,PATCH /api/procurement/settings` | GET, PATCH | Procurement settings (approval threshold, etc.) |
| `GET /api/procurement/budget/check` | GET | Check budget headroom before raising MR |
| `POST /api/procurement/verify` | POST | Verify approval code |

### Lib Files
- `src/lib/procurement/pr-status.ts` — `computeOrderedQtyMap()` and `recalculatePrStatus()` for automatically updating PR status as PO items are ordered/cancelled
- `src/lib/procurement/approval-code.ts` — `generateSignedApprovalCode("pr"|"bill"|"transfer", seqNo, entityId)` — generates human-readable, tamper-evident approval reference codes (e.g. `PR-0042-A1B2`)
- `src/lib/payment-batch.ts` — `computeBatchDate(type: "immediate"|"15th"|"25th")` and `toISODateString()` — determines the calendar date when accounts should process the payment
- `src/lib/approval-display.ts` — `poValidity()`, `PO_VALIDITY_CLASS`, `staleBannerFor()` — client-side helpers that render stale PO warnings on bill pages
- `src/lib/finance-intelligence.ts` — duplicate detector logic, vendor email nag helpers, finance suggestion logging

### Components
- `src/components/procurement/bill-search-bar.tsx` — search input for bills list
- `src/components/procurement/material-request-quotations.tsx` — quotation attachment UI within MR detail
- `src/components/procurement/item-history-dialog.tsx` — item order history dialog
- `src/components/procurement/amc-event-dialog.tsx` — dialog to log an AMC service event
- `src/components/procurement/consumption-correction-dialog.tsx` — consumption correction UI
- `src/components/finance-intelligence/vendor-email-banner.tsx` — `VendorEmailBanner` rendered on bill detail when vendor lacks email; prompts user to add it
- `src/components/settings/procurement-settings.tsx` — approval threshold and settings UI
- `src/components/settings/procurement-budget-settings.tsx` — department budget configuration

---

## Data Model

### Tables

#### `procurement_vendors`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `name` | VARCHAR(255) NOT NULL | |
| `category` | `vendor_category` ENUM | `pantry`, `maintenance`, `administration`, `general` |
| `contact_name` | VARCHAR(255) | |
| `contact_phone` | VARCHAR(50) | |
| `contact_email` | VARCHAR(255) | Comma-separated if multiple. Missing triggers VendorEmailBanner |
| `address` | TEXT | |
| `gstin` | VARCHAR(15) | Stored uppercase, max 15 chars |
| `payment_terms` | VARCHAR(100) | Free text |
| `terms_and_conditions` | TEXT | |
| `notes` | TEXT | |
| `is_active` | BOOLEAN DEFAULT true | |
| `bank_name` | TEXT | |
| `bank_account_holder` | TEXT | |
| `bank_account_number` | TEXT | |
| `bank_ifsc` | TEXT | Stored uppercase, max 11 chars |
| `pan_number` | TEXT | Stored uppercase |
| `msme_number` | TEXT | |
| `kyc_verified` | BOOLEAN NOT NULL DEFAULT false | |
| `kyc_verified_at` | TIMESTAMPTZ | |
| `kyc_verified_by` | UUID → users | |
| `pan_doc_path` | TEXT | Supabase Storage path |
| `gst_cert_path` | TEXT | |
| `reg_cert_path` | TEXT | |
| `aadhar_doc_path` | TEXT | |
| `msme_cert_path` | TEXT | |
| `created_by` | UUID → users | |

RLS: all `authenticated` users can SELECT/INSERT/UPDATE. DELETE allowed too but soft-deactivation (`is_active = false`) is preferred.

#### `procurement_items` (item catalog)
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `name` | VARCHAR(255) NOT NULL | |
| `department` | `procurement_department` ENUM | `pantry`, `maintenance`, `administration` (original enum); `asset` and `amc` added later at app layer |
| `unit` | `item_unit` ENUM | `kg`, `litre`, `packet`, `box`, `piece`, `roll`, `dozen`, `bottle`, `bag`, `set`, `pair`, `month`, `quarter`, `year`, `nos`, `can`, `ton` |
| `item_type` | TEXT DEFAULT `'goods'` | `goods` or `service` |
| `standard_price` | DECIMAL(12,2) | Optional catalog price |
| `gst_rate` | NUMERIC | Optional GST % |
| `description` | TEXT | |
| `is_active` | BOOLEAN DEFAULT true | |
| `is_suggested` | BOOLEAN NOT NULL DEFAULT false | Flagged by system for suggested re-order |

#### `purchase_requests` (Material Requests / MRs)
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `pr_number` | VARCHAR(20) UNIQUE NOT NULL | Auto-generated sequential (e.g. `MR-2025-0042`) |
| `department` | `procurement_department` ENUM | `pantry`, `maintenance`, `administration`, `asset`, `amc` |
| `location_id` | UUID → locations | Optional |
| `status` | `pr_status` ENUM | See state machine below |
| `requested_by` | UUID NOT NULL → users | |
| `approved_by` | UUID → users | Set on approve/reject |
| `approved_at` | TIMESTAMPTZ | |
| `approval_code` | VARCHAR(20) UNIQUE | Set only when approved; signed code for verification |
| `rejection_reason` | TEXT | |
| `notes` | TEXT | |
| `expenditure_type` | TEXT NOT NULL DEFAULT `'operational'` | CHECK: `operational` or `amc` |
| `total_estimated_amount` | DECIMAL(12,2) DEFAULT 0 | Sum of line items |
| `issue_id` | UUID FK `facility_issues(id) ON DELETE SET NULL` | nullable — set when this MR is generated from a facility issue (migration 00293); drives asset cost-of-ownership reporting via `GET /api/facility/assets/[id]/cost-summary` |

#### `purchase_request_items`
| Column | Type | Notes |
|--------|------|-------|
| `pr_id` | UUID NOT NULL → purchase_requests ON DELETE CASCADE | |
| `item_id` | UUID → procurement_items | Optional; can be free-text item |
| `item_name` | VARCHAR(255) NOT NULL | |
| `quantity` | DECIMAL(10,2) NOT NULL | |
| `unit` | `item_unit` ENUM | |
| `estimated_price` | DECIMAL(12,2) | Per-unit price |
| `total_estimated` | DECIMAL(12,2) | `quantity × estimated_price` |

Computed at API time (not DB columns): `already_ordered_qty`, `remaining_qty`.

#### `material_request_quotations`
| Column | Type | Notes |
|--------|------|-------|
| `pr_id` | UUID NOT NULL → purchase_requests ON DELETE CASCADE | |
| `vendor_name` | VARCHAR(255) NOT NULL | |
| `amount` | DECIMAL(12,2) NOT NULL CHECK(≥0) | |
| `file_path` | TEXT NOT NULL | Supabase Storage path |
| `file_name` | VARCHAR(255) NOT NULL | |
| `file_mime_type` | VARCHAR(100) NOT NULL | |
| `notes` | TEXT | |
| `uploaded_by` | UUID → users ON DELETE SET NULL | |

**At least 1 quotation must be attached before an MR can be approved** (enforced at API server side).

#### `purchase_orders`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `po_number` | VARCHAR(20) UNIQUE NOT NULL | |
| `po_type` | TEXT NOT NULL DEFAULT `'goods'` | CHECK: `goods` or `service` |
| `pr_id` | UUID → purchase_requests | Optional; PO can be created without MR |
| `vendor_id` | UUID NOT NULL → procurement_vendors | |
| `location_id` | UUID → locations | |
| `status` | `po_status` ENUM | See state machine below |
| `ordered_by` | UUID NOT NULL → users | |
| `expected_delivery_date` | DATE | For goods POs |
| `actual_delivery_date` | DATE | Set when received |
| `service_start_date` | DATE | Service POs only |
| `billing_cycle` | TEXT | CHECK: `monthly`, `quarterly`, `yearly` |
| `cycle_count` | INTEGER | Number of billing cycles |
| `unit_cost_per_cycle` | DECIMAL(12,2) | Per-cycle cost for service POs — used as the bill ceiling per cycle |
| `notes` | TEXT | |
| `payment_terms` | TEXT | |
| `terms_and_conditions` | TEXT | |
| `total_ordered_amount` | DECIMAL(12,2) DEFAULT 0 | Sum of PO line items |
| `total_gst_amount` | DECIMAL(12,2) | |
| `total_amount_with_gst` | DECIMAL(12,2) | |
| `advance_amount` | NUMERIC(12,2) | |
| `advance_payment_mode` | TEXT | `cash`, `upi`, `bank_transfer` |
| `advance_payment_reference` | TEXT | UTR / cheque number |
| `advance_notes` | TEXT | |
| `advance_status` | TEXT | `not_required`, `pending`, `processed` |
| `advance_processed_by` | UUID → users | |
| `advance_processed_at` | TIMESTAMPTZ | |
| `advance_payment_date` | DATE | |
| `amc_start_date` | DATE | AMC contracts only |
| `amc_end_date` | DATE | |
| `amc_visits_covered` | INTEGER | NULL = unlimited visits |
| `amc_visits_used` | INTEGER NOT NULL DEFAULT 0 | |
| `amc_contact_name` | TEXT | AMC vendor contact |
| `amc_helpline_number` | TEXT | |
| `amc_contact_email` | TEXT | |
| `amc_status` | TEXT NOT NULL DEFAULT `'inactive'` | CHECK: `inactive`, `active`, `expiring`, `exhausted`, `expired` |

`amc_status` is computed by DB function `compute_amc_status(start, end, visits_covered, visits_used)`: expired by date → `expired`; exhausted visits → `exhausted`; within 60 days of end → `expiring`; else → `active` or `inactive`.

#### `purchase_order_items`
| Column | Type | Notes |
|--------|------|-------|
| `po_id` | UUID NOT NULL → purchase_orders ON DELETE CASCADE | |
| `pr_item_id` | UUID → purchase_request_items | Optional linkage |
| `item_id` | UUID → procurement_items | Optional |
| `item_name` | VARCHAR(255) NOT NULL | |
| `quantity_ordered` | DECIMAL(10,2) NOT NULL | |
| `quantity_received` | DECIMAL(10,2) DEFAULT 0 | Cumulative across all delivery receipts |
| `unit` | `item_unit` ENUM | |
| `unit_price` | DECIMAL(12,2) | |
| `total_amount` | DECIMAL(12,2) | |
| `gst_rate` | NUMERIC | |
| `gst_amount` | NUMERIC | |

#### `po_delivery_receipts` (goods delivery — delivery challans)
| Column | Type | Notes |
|--------|------|-------|
| `po_id` | UUID NOT NULL → purchase_orders ON DELETE CASCADE | |
| `dc_number` | TEXT | Optional; the vendor's DC reference number |
| `dc_date` | DATE | DC issue date |
| `file_url` | TEXT | Supabase Storage URL |
| `notes` | TEXT | |
| `received_by` | UUID NOT NULL → users | |
| `received_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

#### `po_delivery_receipt_items`
| Column | Type | Notes |
|--------|------|-------|
| `delivery_receipt_id` | UUID NOT NULL → po_delivery_receipts ON DELETE CASCADE | |
| `po_item_id` | UUID NOT NULL → purchase_order_items | |
| `qty_received` | NUMERIC NOT NULL DEFAULT 0 | |

#### `po_service_reports` (service completion — per billing cycle)
| Column | Type | Notes |
|--------|------|-------|
| `po_id` | UUID NOT NULL → purchase_orders ON DELETE CASCADE | |
| `cycle_number` | INTEGER NOT NULL | UNIQUE per `(po_id, cycle_number)` |
| `period_from` | DATE NOT NULL | |
| `period_to` | DATE NOT NULL | |
| `report_file_url` | TEXT | |
| `notes` | TEXT | |
| `recorded_by` | UUID → users | |

#### `vendor_bills`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `bill_number` | VARCHAR(20) UNIQUE NOT NULL | Auto-generated |
| `po_id` | UUID → purchase_orders | Optional; bills can be direct-expense (no PO) |
| `vendor_id` | UUID NOT NULL → procurement_vendors | |
| `invoice_number` | VARCHAR(100) | Vendor's own invoice reference |
| `invoice_date` | DATE NOT NULL | |
| `due_date` | DATE | |
| `total_amount` | DECIMAL(12,2) NOT NULL | **This IS the base pre-GST amount** |
| `amount_paid` | DECIMAL(12,2) DEFAULT 0 | Running total across all payments |
| `payment_status` | `bill_payment_status` ENUM | `unpaid`, `partially_paid`, `paid` |
| `payment_mode` | TEXT | Last payment mode (reflects most recent `vendor_bill_payments` row) |
| `payment_reference` | VARCHAR(255) | Last payment reference |
| `payment_date` | DATE | Last payment date |
| `notes` | TEXT | |
| `invoice_file_url` | TEXT | Supabase Storage public URL (`vendor-invoices` bucket) |
| `service_report_id` | UUID → po_service_reports | Set for service invoices |
| `approval_status` | TEXT DEFAULT `'pending'` | CHECK: `pending`, `approved`, `rejected` |
| `approved_by` | UUID → users | |
| `approved_at` | TIMESTAMPTZ | Also used for rejection timestamp |
| `approval_code` | VARCHAR(20) | Signed code set on approval |
| `approved_amount` | NUMERIC(12,2) | NULL → full amount; set for partial approvals |
| `approved_amount_note` | TEXT | Required for partial approvals (note to Accounts) |
| `approved_amount_reason` | TEXT | Categorical reason for partial approval; required when partial |
| `rejection_reason` | TEXT | |
| `rejection_outcome` | TEXT | CHECK: `return`, `replacement`, `void` |
| `gst_rate` | DECIMAL(5,2) DEFAULT 0 NOT NULL | The GST slab (0/5/12/18/28) — stored but `gst_amount` is entered directly |
| `gst_amount` | DECIMAL(12,2) DEFAULT 0 NOT NULL | Additive on top of `total_amount`. Total payable = `total_amount + gst_amount` |
| `base_amount` | DECIMAL(12,2) DEFAULT 0 NOT NULL | Equals `total_amount` (stored redundantly for clarity) |
| `gst_set_by` | UUID → users | Who set the GST amount |
| `gst_set_at` | TIMESTAMPTZ | When GST was set — used as sentinel: NULL = not yet set |
| `gst_zero_confirmed` | BOOLEAN NOT NULL DEFAULT false | Explicit zero-GST acknowledgement flag |
| `gst_zero_confirmed_by` | UUID → users | |
| `payment_batch_type` | TEXT | CHECK: `immediate`, `15th`, `25th` |
| `payment_batch_date` | DATE | Computed from `payment_batch_type` at approval time |
| `payment_batch_assigned_by` | UUID → users | |
| `payment_batch_assigned_at` | TIMESTAMPTZ | |
| `replaces_bill_id` | UUID → vendor_bills ON DELETE SET NULL | Set when this bill replaces a previously rejected one |
| `manual_department` | TEXT | For direct-expense bills without a PO |
| `manual_expenditure_type` | TEXT | For direct-expense bills without a PO; CHECK: `operational`, `amc`, `capital` |
| `payment_hold_status` | TEXT DEFAULT `'none'` | CHECK: `none`, `on_hold` |
| `payment_hold_reason` | TEXT | CHECK: `wrong_scan`, `wrong_bank_details`, `bank_rejected`, `amount_mismatch`, `duplicate_suspected`, `pending_docs`, `other` |
| `payment_hold_notes` | TEXT | |
| `payment_held_by` | UUID → users | |
| `payment_held_at` | TIMESTAMPTZ | |
| `payment_hold_resolved_by` | UUID → users | |
| `payment_hold_resolved_at` | TIMESTAMPTZ | |
| `payment_hold_resolution_notes` | TEXT | |
| `cheque_signed_at` | TIMESTAMPTZ | Set via `sign_cheque` action |
| `cheque_signed_by` | UUID → users | |
| `created_by` | UUID NOT NULL → users | |

**Critical amount semantics**: `total_amount` = base pre-GST amount. `gst_amount` is additive. Approved payment ceiling = `approved_amount + gst_amount`. This is counterintuitive — `total_amount` is NOT the total payable; it is the base. Don't change this without migrating all payment arithmetic.

#### `vendor_bill_payments` (payment history per bill)
| Column | Type | Notes |
|--------|------|-------|
| `bill_id` | UUID NOT NULL → vendor_bills ON DELETE CASCADE | |
| `amount` | NUMERIC(12,2) NOT NULL CHECK(> 0) | |
| `payment_mode` | TEXT NOT NULL | `bank_transfer`, `neft`, `rtgs`, `imps`, `cheque`, `cash` |
| `payment_reference` | TEXT | UTR / cheque number |
| `payment_date` | DATE NOT NULL DEFAULT CURRENT_DATE | |
| `notes` | TEXT | |
| `partial_reason` | TEXT | Categorical reason when paying less than approved outstanding; required by app layer when partial |
| `recorded_by` | UUID NOT NULL → users | |

#### `vendor_bill_tds`
Linked per payment row (`bill_id`, `payment_id`). Contains `section_code`, `vendor_type` (`individual`/`huf`/`company`), `base_amount`, `tds_rate`, `tds_amount`, `pan_available`, `period_month`, `period_year`. Integrated with the TDS module.

#### `vendor_bill_batch_changes` (audit log for payment batch overrides)
| Column | Type | Notes |
|--------|------|-------|
| `vendor_bill_id` | UUID NOT NULL → vendor_bills ON DELETE CASCADE | |
| `changed_by` | UUID → users | |
| `changed_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| `old_batch_type` | TEXT | |
| `new_batch_type` | TEXT | |
| `old_batch_date` | DATE | |
| `new_batch_date` | DATE | |
| `reason` | TEXT | |

#### `department_budgets`
| Column | Type | Notes |
|--------|------|-------|
| `department` | TEXT NOT NULL | `pantry`, `maintenance`, `administration`, `asset`, `amc` |
| `location_id` | UUID → locations | NULL = global (no location) |
| `monthly_budget` | NUMERIC(12,2) NOT NULL CHECK(≥ 0) | For AMC: `budget_period = 'annual'` repurposes this as annual budget |
| `is_active` | BOOLEAN NOT NULL DEFAULT true | |
| `budget_period` | TEXT NOT NULL DEFAULT `'monthly'` | CHECK: `monthly`, `annual` |
| `financial_year` | INTEGER | Only for AMC annual rows; e.g. `2025` = FY 2025-26 |

UNIQUE constraints: `(department, location_id)` for monthly rows; partial unique index on `(financial_year)` WHERE `department = 'amc' AND location_id IS NULL AND budget_period = 'annual'`.

#### `amc_service_events`
| Column | Type | Notes |
|--------|------|-------|
| `po_id` | UUID NOT NULL → purchase_orders ON DELETE CASCADE | |
| `event_number` | INTEGER NOT NULL | UNIQUE per `(po_id, event_number)` |
| `event_type` | TEXT NOT NULL | CHECK: `breakdown`, `preventive`, `remote_support`, `annual_service` |
| `event_date` | DATE NOT NULL | |
| `technician_name` | TEXT | |
| `issue_description` | TEXT NOT NULL | |
| `resolution_notes` | TEXT | |
| `next_scheduled_date` | DATE | |
| `report_file_url` | TEXT | |
| `logged_by` | UUID → users | |

---

## State Machines

### Material Request (PR) Status

Values (from `PR_STATUSES`): `draft`, `submitted`, `approved`, `rejected`, `partially_ordered`, `po_created`, `cancelled`

```
draft → submitted        (requester submits — only requester can do this)
submitted → approved     (admin/manager approves — requires ≥1 quotation attached)
submitted → rejected     (admin/manager rejects)
rejected → submitted     (resubmit — any procurement role; can include price edits)
approved → partially_ordered  (auto, when some PO items ordered but not all — set by recalculatePrStatus())
approved → po_created         (auto, when all MR qty consumed by non-cancelled POs)
partially_ordered → po_created (auto, when remaining qty filled)
draft|submitted → cancelled    (requester or admin/manager/office_admin)
```

`recalculatePrStatus()` (in `src/lib/procurement/pr-status.ts`) is called after any PO creation / cancellation affecting items from the MR. It computes `already_ordered_qty` (sum of `quantity_ordered` across non-cancelled POs per item) and derives status from that.

**Key validation**: Only the requester can submit (`pr.requested_by === dbUser.id`). Any procurement role can resubmit a rejected MR.

### Purchase Order Status

Values (from `PO_STATUSES`): `pending`, `ordered`, `partially_received`, `received`, `invoice_received`, `invoice_approved`, `cancelled`, `partially_cancelled`

```
pending → ordered               (mark_ordered action; admin/manager/office_admin)
ordered → partially_received    (mark_received when some items short)
ordered → received              (mark_received when all items received)
partially_received → received   (mark_received)
received → invoice_received     (auto-set when bill is created against the PO)
invoice_received → invoice_approved  (auto-set when bill is approved by admin)
pending|ordered → cancelled     (cancel action; admin/manager)
ordered → partially_cancelled   (partial_cancel action — some items confirmed, rest cancelled)
```

For **service POs**: status never transitions through `partially_received`/`received`. Rejection of a service bill **voids the bill** (hard deletes it) rather than rejecting it, so the cycle can accept a new invoice.

### Vendor Bill Approval Status

Values: `pending`, `approved`, `rejected`

```
pending → approved   (admin/manager — approve or approve_partial)
pending → rejected   (admin/manager — reject with reason)
approved → approved  (approve_balance — elevates partial approval to full)
rejected → pending   (update_amount_and_resubmit — corrects amount and re-queues)
```

**Special case**: When a service PO bill is rejected, the bill is **deleted** from the database (not marked rejected). The response returns `{ data: null }`. Client must navigate away.

### Vendor Bill Payment Status

Values: `unpaid`, `partially_paid`, `paid`

```
unpaid → partially_paid   (record_payment when amount < approved_ceiling)
unpaid → paid             (record_payment when amount >= approved_ceiling)
partially_paid → paid     (record_payment brings total to approved_ceiling)
```

`approved_ceiling = approved_amount + gst_amount` (where `approved_amount` defaults to `total_amount` for full approvals).

### Payment Hold Status

Values: `none`, `on_hold`

```
none → on_hold     (hold_payment; by accounts/admin/office_admin)
on_hold → none     (release_hold; admin only)
```

---

## Business Rules (Hard — Must Not Be Violated)

### Material Requests
1. Only the requester can submit their own draft MR.
2. At least **one vendor quotation** must be attached to an MR before it can be approved (`material_request_quotations` count ≥ 1).
3. MRs above **₹25,000** (`PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE`) require admin approval; managers cannot approve them. This threshold is also configurable via `app_settings.key = 'procurement_approval_threshold'` which takes precedence at runtime.
4. Managers are **blocked from approving** if the department's monthly budget would be exceeded (operational) or the annual AMC budget would be exceeded (AMC). Admins can always approve regardless of budget.
5. On resubmit, only `estimated_price` per line item can change — item identity (`item_id`, `item_name`, `quantity`, `unit`, `notes`) is locked.

### Purchase Orders
1. Advance payment must include `advance_payment_reference` (UTR/cheque number) — no reference = 422.
2. A goods PO bill amount cannot exceed the PO's `total_amount`. A service PO bill amount cannot exceed `unit_cost_per_cycle`.
3. When a PO is cancelled, `recalculatePrStatus()` is called on the linked MR to potentially revert its status from `po_created` back to `approved`.

### Vendor Bills — Approval
1. Only **admin** can approve or reject bills (`canApproveOrReject = dbUser.role === 'admin'`). Note: the page UI shows this for admin/manager but the API enforces admin-only.
2. A bill's `due_date` must be on or after today to be approved. If past, the API returns `{ code: "due_date_in_past" }` and the UI shows an inline "Fix Due Date" dialog.
3. GST amount cannot exceed **28% of the invoice base** (`total_amount × 0.28`). Validated both client-side and server-side.
4. For partial approvals: both `approved_amount_reason` (categorical, from `PARTIAL_APPROVAL_REASONS`) and `approved_amount_note` (free-text explanation) are required by the API.
5. `payment_batch_type` is mandatory at approval — approver must choose `immediate`, `15th`, or `25th`.

### Vendor Bills — Payment (Finance > Acc Payables)
1. Bill must be `approval_status = 'approved'` before payment can be recorded. 422 if not.
2. `gst_set_at` must be non-null before payment can be recorded. Accounts must set GST (or confirm zero-GST) first.
3. Payment amount cannot exceed `approvedCeiling - alreadyPaid` (= `(approved_amount + gst_amount) - amount_paid`).
4. For partial payments (less than `remainingApproved`): `partial_reason` is required.
5. Payment mode restrictions by role:
   - `accounts`: bank modes only (`bank_transfer`, `neft`, `rtgs`, `imps`, `cheque`)
   - `office_admin`: `cash` only
   - `manager`: cannot record payments (403)
   - `admin`: all modes
6. For cheque payments: `sign_cheque` action must be called before `payment-email` can be sent. Auto-signs sibling bills with the same vendor + same cheque number in one click.
7. Paid bills (`payment_status = 'paid'`) cannot have GST updated.

### Vendor Bills — Service PO Rejection
When a service PO bill is rejected: the bill record is **hard deleted** from the database. The API returns `{ data: null, message: "..." }`. The client detects `json.data === null` and navigates to `/procurement/bills`. Do not attempt to render a deleted service bill.

---

## Validation Rules (Where Enforced)

| Rule | Client | Server | DB |
|------|--------|--------|----|
| Vendor name required | Yes (form guard) | No | NOT NULL |
| MR: only requester can submit | No | Yes (403) | No |
| MR: ≥1 quotation to approve | No | Yes (422, `quotations_required: true`) | No |
| MR: threshold for admin | Shown in UI badge | Yes (403) | No |
| MR: budget headroom (manager) | No | Yes (403, `budget_exceeded: true`) | No |
| Bill: due_date ≥ today to approve | UI (date input) | Yes (422, `code: "due_date_in_past"`) | No |
| Bill: GST ≤ 28% of base | Yes (real-time) | Yes (422) | No |
| Bill: zero-GST requires `gst_zero_confirmed` | Yes (checkbox) | Yes (422) | No |
| Bill: `gst_set_at` before payment | No | Yes (422) | No |
| Bill: partial approval requires reason + note | Yes (form) | Yes (422) | No |
| Bill: batch_type required at approval | Yes (form) | Yes (400 via Zod) | No |
| Bill: payment ≤ approved ceiling | No | Yes (422) | No |
| Bill: partial payment requires `partial_reason` | No | Yes (422) | No |
| Bill: accounts = bank only, office_admin = cash only | No | Yes (403) | No |
| MR resubmit: price-only edits | No | Yes (validates item belongs to MR) | No |
| Bill resubmit: amount vs PO ceiling | No | Yes (422) | No |
| Email validation on vendor email field | Yes (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) | Yes (Zod `.email()`) | No |
| Invoice amount > 0 | Yes (input min) | Yes (Zod `.positive()`) | CHECK on `vendor_bill_payments.amount > 0` |
| Quotation amount ≥ 0 | No | No | CHECK on `material_request_quotations.amount >= 0` |
| Advance payment reference required | No | Yes (Zod `.min(1)`) | No |

---

## Role Permissions

| Action | `admin` | `manager` | `accounts` | `office_admin` | Others |
|--------|---------|-----------|------------|----------------|--------|
| View procurement pages | Yes | Yes | Yes | Yes | Varies |
| Create MR | Yes | Yes | No | Yes | Role-dependent |
| Submit MR | Yes (any) | Yes (own) | No | Yes (own) | Yes (own) |
| Approve MR ≤ ₹25k | Yes | Yes | No | No | No |
| Approve MR > ₹25k | Yes | No | No | No | No |
| Reject MR | Yes | Yes | No | No | No |
| Create PO | Yes | Yes | No | Yes | No |
| Mark PO ordered/received | Yes | Yes | No | Yes | No |
| Cancel PO | Yes | Yes | No | No | No |
| Process PO advance | Yes | Yes | No | Yes | No |
| Create vendor bill | Yes | Yes | Yes | Yes | Varies |
| **Approve bill** | **Yes** | **No (UI shows it; API enforces admin-only)** | No | No | No |
| Reject bill | Yes | No | No | No | No |
| Update GST on bill | Yes | Yes | Yes | No | No |
| Override payment batch | Yes | Yes | Yes | No | No |
| Record bank payment | Yes | No | Yes | No | No |
| Record cash payment | Yes | No | No | Yes | No |
| Hold payment | Yes | No | Yes | Yes | No |
| Release payment hold | Yes | No | No | No | No |
| Sign cheque | Yes | No | Yes | Yes | No |
| Send payment confirmation email | Yes | No | Yes | No | No |
| View prices/amounts | Yes | Yes | Yes | Limited | No |
| View department budgets | Yes (admin) | Yes (manager) | No | No | No |
| Add/edit vendor | Yes | Yes | No | No | No |
| Toggle vendor KYC | Yes | Yes | No | No | No |
| Upload vendor documents | Yes | Yes | No | No | No |
| Configure budgets | Yes | Yes | No | No | No |
| Approve balance on partial bill | Yes | No | No | No | No |
| Update due date on bill | Yes | Yes | Yes | Yes | No |

**Note on bill approval**: The client-side check is `["admin", "manager"].includes(currentUserRole)` to show buttons, but the API's `canApproveOrReject = dbUser.role === 'admin'` means only admin can actually approve. Managers will see the approve button but hit a 403. This is a known design — managers are in the UI to allow previewing but not approve.

**Note on non-price roles**: Users without `admin` or `manager` roles do not see currency amounts on the procurement dashboard. KPI cards show counts only.

---

## Integration Points with Other Modules

### Finance > Acc Payables (`/accounting/vendor-payments/[id]`)
- The payment recording for vendor bills happens here, not in procurement
- Bills are shared between modules — same `vendor_bills` table
- Accounts users navigate from the Acc Payables screen to record payments
- `VendorEmailBanner` appears both on the bill page and in Acc Payables when `contact_email` is missing

### TDS Module (`/accounting/tds`)
- When recording a bill payment, the user can optionally attach a TDS deduction (`vendor_bill_tds` table)
- TDS entries link to both `bill_id` and `payment_id`
- TDS is reported via Form 26Q functionality

### Finance Intelligence / Duplicate Detector
- `POST /api/procurement/bills/check-duplicate` runs on the new-bill form (debounced)
- Scores by invoice number similarity (60%), amount match (25%), date proximity (15%)
- Threshold: 0.55 — below that is noise; exact invoice number matches always surface
- Feature flag: `duplicate_detector` in finance intelligence config (via `app_settings`)
- Requires `fi_vendor_email_digest_enabled` config for the cron digest

### Cron Jobs (procurement-related)
| Schedule (UTC) | IST | Endpoint | Purpose |
|----------------|-----|----------|---------|
| Mon 04:00 UTC | Mon 09:30 IST | `GET /api/cron/vendor-email-digest` | Weekly digest of vendors missing email, ranked by pending bills + spend |
| Mon 04:30 UTC | Mon 10:00 IST | `GET /api/cron/invoice-gap-audit` | Audit for invoice gaps |

`vendor-email-digest` uses `CRON_SECRET` header auth and `createAdminClient()`.

### Audit Trail (`audit_trail` table)
- All mutations call `logAudit()` from `src/lib/audit.ts`
- `entity_type` values: `procurement_vendor`, `procurement_item`, `purchase_request`, `purchase_order`, `vendor_bill`
- The bill detail page fetches audit events for the MR, PO, and bill together via `/api/procurement/bills/[id]/chain` and renders a combined timeline

### Push Notifications
- `sendPushToProcurementRoles()` (from `src/lib/push.ts`) fires on: bill approved, bill partially approved, bill balance approved, bill rejected, service invoice rejected, bill amount corrected/resubmitted, payment on hold
- Targets all users in procurement roles

### Inventory / Transfers
- Goods received via delivery challans update `quantity_received` on PO items
- Stock transfers between locations use `stock_transfers` table (with their own `approval_code`)

### Facility Management (cost-of-ownership)
- `purchase_requests.issue_id` FK (migration 00293) links an MR to the facility issue that triggered it
- `GET /api/facility/assets/[id]/cost-summary` follows the chain `facility_issues → purchase_requests (issue_id) → purchase_orders (pr_id) → vendor_bills (po_id)` to aggregate approved vendor bill amounts into a monthly cost-of-ownership view per asset
- Only bills with `approval_status = 'approved'` are included; amounts are grouped by `vendor_bills.invoice_date` month
- MRs created before migration 00293 have `issue_id = NULL` and are excluded from cost summaries

---

## GST Handling — Critical Details

This is the most error-prone area of the module.

**Schema design**:
- `vendor_bills.total_amount` = the **pre-GST base amount** entered by whoever creates the bill
- `vendor_bills.gst_amount` = the GST rupee amount, entered separately, added on top
- `vendor_bills.base_amount` = redundant copy of `total_amount` (kept for readability)
- Total payable to vendor = `total_amount + gst_amount`

**Lifecycle**:
1. Bill created: `gst_amount = 0`, `gst_set_at = NULL` (not yet set)
2. Approval: approver optionally enters GST. If blank — `gst_set_at` stays NULL, accounts must set it later
3. Before payment: Accounts must set GST via `update_gst` action (sets `gst_set_at`). The API gate at `record_payment` checks `gst_set_at IS NOT NULL`
4. Zero-GST: must be explicitly confirmed with `gst_zero_confirmed = true`. Entering 0 without the checkbox → 422

**Max GST**: `Math.round(total_amount × 0.28 × 100) / 100` — enforced both client and server.

---

## Payment Batch Scheduling

When approving a bill, the approver must select a payment batch:

| Type | Label | Computed Date |
|------|-------|---------------|
| `immediate` | Immediate | Today's date |
| `15th` | 15th of Month | 15th of current month (or next month if past 15th) |
| `25th` | 25th of Month | 25th of current month (or next month if past 25th) |

Logic in `src/lib/payment-batch.ts` via `computeBatchDate(type)`.

The batch date is stored in `payment_batch_date` and can be overridden (`override_batch` action) by admin/manager/accounts with an optional reason. Every override is logged to `vendor_bill_batch_changes`.

---

## Duplicate Invoice Detection

`POST /api/procurement/bills/check-duplicate` — called debounced from the new-bill form.

Inputs: `vendor_id`, `invoice_number`, `total_amount`, `invoice_date`, optionally `exclude_bill_id`.

Algorithm:
- Pull up to 50 recent bills for the same vendor within the configured lookback window
- Score each by: invoice number similarity (60% weight), amount match within ±₹1 (25%), date proximity within ±7 days (15%)
- Threshold at 0.55 — but exact invoice number matches always surface regardless
- Returns top 5 candidates as `DuplicateCandidate[]` with `similarity_score` and `match_reason`

The form shows a non-blocking warning banner (not a hard block) when candidates are returned.

All calls are logged to `finance_suggestion_log` for precision measurement.

---

## Key User Flows

### Flow 1: Standard Goods Procurement
1. Staff creates MR draft at `/procurement/requests/new`, adds line items with estimated prices
2. Staff uploads ≥1 vendor quotation on the MR
3. Staff submits MR (status: `draft → submitted`)
4. Manager/admin reviews MR at `/procurement/requests/[id]`, checks quotations, approves (status: `submitted → approved`). If > ₹25k, must be admin.
5. Admin creates PO at `/procurement/orders/new`, links to approved MR, selects vendor, enters line item prices (status: PO `pending`)
6. Admin marks PO as ordered after placing with vendor (status: PO `pending → ordered`)
7. Staff records delivery challan when goods arrive at `/procurement/orders/[id]`; PO status advances to `received`
8. Staff uploads vendor invoice at `/procurement/bills/new`, links to PO (bill status: PO → `invoice_received`, bill `approval_status = pending`)
9. Admin reviews bill at `/procurement/bills/[id]`, selects payment batch, optionally enters GST, approves (bill `approval_status = pending → approved`, PO → `invoice_approved`)
10. Accounts navigates to Finance > Acc Payables, sets GST if not already done, records payment

### Flow 2: Service PO (Monthly Billing)
1. Create service PO at `/procurement/orders/new-service` with `billing_cycle`, `unit_cost_per_cycle`
2. Each cycle: record service report at `/procurement/orders/[id]` confirming the service was performed
3. Upload service invoice linked to that cycle's service report
4. Admin approves invoice
5. Accounts records payment; on rejection the bill is hard-deleted (can re-upload)

### Flow 3: Bill Rejection and Replacement
1. Admin rejects bill with `rejection_outcome = 'replacement'`
2. Staff creates new bill at `/procurement/bills/new?po_id=...&replaces=<old_bill_id>` (the button appears on the rejected bill page)
3. New bill's `replaces_bill_id` is set to the original; lineage is preserved

### Flow 4: Partial Approval → Balance Approval
1. Admin approves bill for partial amount with structured reason + note
2. Accounts records payment up to `approved_amount + gst_amount`
3. Dispute resolved; admin clicks "Approve Balance" button
4. `approved_amount` elevated to `total_amount`; Accounts can now record remaining balance

### Flow 5: Vendor Email Missing
1. Any time a bill is opened for a vendor without `contact_email`, the `VendorEmailBanner` appears
2. User can enter email directly in the banner; saved via `PATCH /api/procurement/vendors/[id]`
3. The vendor email history is also surfaced: when `contact_email` is null, the vendor detail API looks up `audit_logs` for the last `email_sent` event to find the last-used TO address

---

## Known Pitfalls and Gotchas

### 1. `total_amount` Is NOT the Total Payable
`vendor_bills.total_amount` is the pre-GST base amount. The actual amount to pay the vendor is `total_amount + gst_amount`. Many display and calculation bugs have occurred by treating `total_amount` as the full payable. Always add `gst_amount`.

### 2. Manager Cannot Actually Approve Bills (Despite UI Showing the Button)
The approve/reject buttons are rendered when `["admin", "manager"].includes(currentUserRole)` but the API checks `dbUser.role === 'admin'`. Managers will see the button, click it, and get a 403. This is intentional per business rules but visually misleading.

### 3. Service Bill Rejection Hard-Deletes the Bill
When rejecting a service PO bill, the API **deletes the row** and returns `{ data: null }`. The client must check `json.data === null` and navigate away. Any code that assumes a rejected bill is still in the DB will break for service POs.

### 4. GST Must Be Set Before Payment (Even If Approver Skipped It)
Approvers can skip GST at approval time. But the `record_payment` action gates on `gst_set_at IS NOT NULL`. If this is null, payment will always 422. Accounts must use the "Set GST amount" button on the bill detail page before recording payment.

### 5. Approved Amount Ceiling Includes GST
Payment ceiling = `approved_amount + gst_amount`. If you only check against `approved_amount` when validating payment amounts, you'll wrongly block valid payments that include GST.

### 6. Quotations Required Before MR Approval
The API returns `{ error: "...", quotations_required: true }` when approving without quotations. The UI may show this differently. If you're building any approval shortcut, check for this gate.

### 7. Budget Gate Is Manager-Only (Admin Always Bypasses)
Budget enforcement (`department_budgets` check, AMC annual check) only applies when `dbUser.role === 'manager'`. Admins always get through. Never add a budget gate for admins.

### 8. `recalculatePrStatus()` Must Be Called After PO Changes
Any code that creates, cancels, or partially cancels a PO that is linked to a PR must call `recalculatePrStatus(supabase, prId)` afterwards. Forgetting this leaves the PR stuck in `approved` even when fully ordered.

### 9. Vendor Email Is Comma-Separated
`contact_email` can hold multiple emails as a comma-separated string (e.g. `"a@b.com, c@d.com"`). Don't treat it as a single email — split on `,` before sending. The VendorEmailBanner and payment-email route both handle this.

### 10. Cheque Payments Require `sign_cheque` Before `payment-email`
Sending a payment confirmation for a cheque payment before it is signed returns 422. The `sign_cheque` action auto-propagates to sibling bills sharing the same `vendor_id + payment_reference + payment_mode = 'cheque'`.

### 11. PR Resubmit: Price Edits Are Item-ID-Validated Server-Side
When passing `line_items` to the `resubmit` action, each `id` must belong to the current PR. The API validates this. Phantom IDs return 422.

### 12. Approval Code Is Signed and Verifiable
Both MR and bill approval codes are generated by `generateSignedApprovalCode()`. The format encodes entity type, sequence number, and a HMAC-derived suffix from the entity UUID. The `/procurement/verify` route can verify these codes.

---

## Environment / Config Dependencies

| Key | Location | Purpose |
|-----|----------|---------|
| `procurement_approval_threshold` | `app_settings` table | Overrides `PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE` (default 25000 INR). Read at runtime by `getApprovalThreshold()` |
| `duplicate_detector` | `app_settings` via finance intelligence config | Feature flag; if disabled, check-duplicate returns empty |
| `fi_vendor_email_digest_enabled` | `app_settings` via finance intelligence config | Toggle for Monday vendor email digest |
| `CRON_SECRET` | env var | Used in `Authorization: Bearer <secret>` header for cron endpoints |
| `RESEND_API_KEY` | env var | Payment confirmation emails sent via Resend |
| Storage bucket `vendor-invoices` | Supabase Storage | Public bucket; 10 MB limit; accepts PDF, JPEG, PNG, WebP |
| Storage bucket `vendor-kyc-docs` (or similar) | Supabase Storage | KYC document uploads — accessed via signed URL, not public |

Fixed CC emails hardcoded in the payment confirmation route: `["admin@stonecolour.com", "admin@theworkvilla.com"]`. If these need to change, edit `src/app/api/procurement/bills/[id]/payment-email/route.ts`.

---

## Cron Jobs (Procurement-Related)

| Schedule (UTC) | IST Equivalent | Path | What It Does |
|----------------|----------------|------|-------------|
| `0 4 * * 1` (Mon) | Mon 09:30 IST | `/api/cron/vendor-email-digest` | Weekly digest of vendors missing `contact_email` sent to configured recipients; ranks by pending bills then spend |
| `30 4 * * 1` (Mon) | Mon 10:00 IST | `/api/cron/invoice-gap-audit` | Weekly audit for invoice sequencing gaps |

Both are protected by `Authorization: Bearer ${CRON_SECRET}` header. Both use `createAdminClient()`.
