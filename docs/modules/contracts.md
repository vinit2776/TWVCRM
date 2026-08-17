# Contracts

## Purpose and Business Context

The Contracts module is the backbone of the occupancy lifecycle at The WorkVilla. Every active client occupying a seat is covered by a contract. The module manages:

- Drafting and sending membership agreements (physical PDF + Leegality digital e-stamp/e-sign)
- A hard activation gate that ensures deposit and pro-rata payment is collected before a member can move in
- Monthly recurring billing statement generation (triggered at activation, then by cron)
- WiFi voucher issuance and automatic revocation on cancellation/expiry
- Door access control via COSEC biometric/NFC integration
- Contract renewal chains with escalation pricing
- KYC document collection and approval tracking
- Space seat allocation tracking

A contract is always born from an **accepted proposal**. Financials (line items, subtotal, tax, discount) are always inherited from the proposal and cannot be independently edited on a contract.

---

## Routes

| Route | File | Description |
|---|---|---|
| `/contracts` | `src/app/(dashboard)/contracts/page.tsx` | Paginated list with status filter, search, expiry filter, "Needs Quotas" filter. Inline quota/facilities sheet via shadcn Sheet. |
| `/contracts/[id]` | `src/app/(dashboard)/contracts/[id]/page.tsx` | Full contract detail: overview, agreement, KYC, vouchers, members, billing, renewal. All state managed in this client component. |
| `/contracts/kyc-pending` | `src/app/(dashboard)/contracts/kyc-pending/page.tsx` | Cross-contract KYC dashboard showing all pending/deferred required documents. Admins can clear deferrals and extend deadlines inline. |

Both `/contracts` and `/contracts/[id]` are `"use client"` components.

---

## Key Source Files

### Pages
- `src/app/(dashboard)/contracts/page.tsx` — list page
- `src/app/(dashboard)/contracts/[id]/page.tsx` — detail page (1734 lines; the main interface)
- `src/app/(dashboard)/contracts/kyc-pending/page.tsx` — KYC dashboard

### Core Components (`src/components/contracts/`)
- `create-contract-dialog.tsx` — modal to create contract from an accepted proposal
- `contract-lifecycle.tsx` — visual journey stepper (Agreement Journey sidebar card)
- `contract-chain-strip.tsx` — horizontal strip showing parent/child renewal chain
- `contract-renewal-dialog.tsx` — renewal creation dialog + `DeclineRenewalDialog` + `EscalationWaiverSection`
- `contract-space-manager.tsx` — seat/unit allocation UI + `validateSpaceAllocation()` helper
- `contract-vouchers-section.tsx` — WiFi voucher issuance, per-seat view, email dialog
- `contract-members-access-section.tsx` — member list with COSEC access status per device
- `contract-documents-tab.tsx` — KYC upload, approval, deferral workflow; reports status up via `onKycStatusChange`
- `contract-quotas-section.tsx` — service quota CRUD (print, meeting room hours, etc.)
- `contract-facilities-section.tsx` — complimentary facility CRUD (legacy)
- `contract-addons-section.tsx` — recurring add-on charges (parking, lockers, etc.)
- `contract-invoices-section.tsx` — billing statement list + billing mode toggle
- `contract-deposit-section.tsx` — security deposit snapshot from linked proposal
- `contract-electricity-tab.tsx` — per-contract electricity billing config
- `contract-access-logs-section.tsx` — door access log viewer
- `contract-bookings-section.tsx` — meeting room bookings associated with this contract
- `contract-service-usage-section.tsx` — print/service usage history
- `contract-contacts-panel.tsx` — per-contract contact persons
- `cosec-access-wizard.tsx` — step wizard to provision a member on COSEC
- `voucher-replace-dialog.tsx` — replace an individual seat's voucher

### API Routes
All under `src/app/api/contracts/`:
- `route.ts` — `GET` (list/search), `POST` (create)
- `[id]/route.ts` — `GET` (detail), `PATCH` (status/field updates), `DELETE` (draft only)
- `[id]/renew/route.ts` — `POST` (create renewal draft), `PATCH` (admin escalation waiver)
- `[id]/decline-renewal/route.ts` — `POST` (mark renewal declined)
- `[id]/sign/route.ts` — `POST` (initiate Leegality e-signing, check status)
- `[id]/vouchers/route.ts` — `GET` (list), `POST` (issue bulk or per-seat)
- `[id]/vouchers/[issuanceId]/route.ts` — `DELETE` (revoke single issuance)
- `[id]/vouchers/[issuanceId]/replace/route.ts` — `POST` (replace one seat's voucher)
- `[id]/vouchers/email/route.ts` — `POST` (email voucher codes to occupant)
- `[id]/members/route.ts` — `GET`, `POST` (add member + COSEC provision), `DELETE` (deactivate + block)
- `[id]/quotas/route.ts` — `GET`, `POST` (upsert), `DELETE`
- `[id]/facilities/route.ts` — `GET`, `POST`, `DELETE`
- `[id]/addons/route.ts` — `GET`, `POST`, `PATCH`, `DELETE`
- `[id]/documents/route.ts` — `GET`, `POST`
- `[id]/documents/init/route.ts` — `POST` (initialise KYC checklist from entity type)
- `[id]/documents/[docId]/review/route.ts` — `POST` (approve/reject KYC doc)
- `[id]/documents/[docId]/defer/route.ts` — `POST` (defer), `PATCH` (update deadline), `DELETE` (clear)
- `[id]/contacts/route.ts` — `GET`, `POST`, `DELETE`
- `[id]/space-allocations/route.ts` — `GET`, `POST`, `DELETE`
- `[id]/seat-occupants/route.ts` — `GET`, `POST`
- `[id]/seat-occupants/[occupantId]/route.ts` — `PATCH`, `DELETE`
- `[id]/seat-occupants/[occupantId]/transfer/route.ts` — `POST`
- `[id]/electricity-config/route.ts` — `GET`, `PATCH`
- `[id]/email/route.ts` — `POST` (email membership agreement PDF)
- `[id]/addendum/route.ts` — `GET` (generate renewal addendum PDF)
- `[id]/cosec-wizard/route.ts` — `POST` (cosec access provisioning steps)
- `contracts/kyc-pending/route.ts` — `GET`
- `contracts/kyc-summary/route.ts` — `GET`
- `contracts/renewal-reminders/route.ts` — `POST` (send reminder emails)

### Lib Files
- `src/lib/billing.ts` — `generateMonthlyStatements()` called on activation and by cron
- `src/lib/pdf-generator.ts` — `generateMembershipAgreementPDF()` (jsPDF, browser-only)
- `src/lib/leegality.ts` — `uploadForEStampAndSigning()`, `getSigningStatus()`
- `src/lib/unifi.ts` — `createUnifiVoucher()`, `revokeUnifiVoucher()`, `calcVoucherMinutes()`, `isUnifiLocation()`, `siteConfigFromLocation()`
- `src/lib/cosec.ts` — `provisionUser()`, `setUserActive()`, `memberCosecId()`, `generatePin()`
- `src/lib/validations.ts` — `createContractSchema` (Zod)
- `src/lib/constants.ts` — all contract constants (see below)
- `src/lib/auto-status.ts` — `autoUpdateLeadStatus()` called on activation

### Cron
- `src/app/api/cron/contract-expiry/route.ts` — daily at 18:30 IST; moves `active` contracts past `end_date` to `expired`, revokes vouchers, emails admin/accounts

---

## Data Model

### Primary Table: `contracts`

```
id                      UUID PK
contract_number         VARCHAR(50) UNIQUE  — auto-generated as "TWV-C-NNNN"
lead_id                 UUID FK → leads(id)     ON DELETE RESTRICT
proposal_id             UUID FK → proposals(id) ON DELETE RESTRICT (nullable after migration history; treated as mandatory in code)
location_id             UUID FK → locations(id) ON DELETE SET NULL
title                   VARCHAR(500) NOT NULL
status                  contract_status ENUM ('draft','sent','viewed','accepted','rejected','active','renewal_in_progress','renewed','expired','terminated')
items                   JSONB DEFAULT '[]'   — LineItem[]
subtotal                DECIMAL(12,2)
tax_percentage          DECIMAL(5,2)
tax_amount              DECIMAL(12,2)
discount_percentage     DECIMAL(5,2)
discount_amount         DECIMAL(12,2)
total_amount            DECIMAL(12,2)
billing_cycle           billing_cycle ENUM ('monthly','quarterly','half_yearly','yearly')
billing_mode            TEXT DEFAULT 'proforma_first'  CHECK IN ('proforma_first','gst_direct')
tenure_months           INTEGER NOT NULL
start_date              DATE NOT NULL
end_date                DATE NOT NULL
next_billing_date       DATE
seats                   INTEGER NOT NULL DEFAULT 1
department_id           TEXT  — printer-server ID; globally unique (partial unique index where NOT NULL)
terms_and_conditions    TEXT
notes                   TEXT
workspace_description   TEXT
parking_space           TEXT
complimentary_services  TEXT
security_deposit_months DECIMAL(default 3)
escalation_percentage   DECIMAL(default 10)
notice_period_months    DECIMAL(default 2)
lock_in_months          INTEGER  (nullable)
member_signatory_name   TEXT
member_signatory_designation TEXT
member_signatory_pan    TEXT  — actual value is PAN or Aadhaar depending on member_signatory_id_type
member_signatory_id_type TEXT DEFAULT 'pan'  ('pan' | 'aadhaar')
agreement_date          DATE
-- Leegality e-signing
leegality_document_id   VARCHAR(255)
leegality_sign_url      TEXT  — TWV/Naval signing link
leegality_lessee_sign_url TEXT — Customer signing link
leegality_status        VARCHAR(50)  ('COMPLETED','EXPIRED','CANCELLED',etc.)
signed_at               TIMESTAMPTZ
signed_document_id      UUID FK → documents(id)
-- Status timestamps + actors
sent_at / sent_by       TIMESTAMPTZ / UUID FK → users
viewed_at / viewed_by   ...
accepted_at / accepted_by ...
rejected_at / rejected_by ...
activated_at / activated_by ...
terminated_at / terminated_by ...
renewed_at / renewed_by ...
termination_reason      TEXT
-- Renewal chain
parent_contract_id      UUID FK → contracts(id) ON DELETE SET NULL
is_renewal              BOOLEAN DEFAULT FALSE
renewal_sequence        INTEGER DEFAULT 1
deposit_carried_from    UUID FK → contracts(id) ON DELETE SET NULL
deposit_shortfall       DECIMAL(12,2) DEFAULT 0
escalation_waived       BOOLEAN DEFAULT FALSE
escalation_waiver_reason TEXT
escalation_waived_by    UUID FK → users
escalation_approval_status TEXT  (NULL | 'pending' | 'approved' | 'rejected')
escalation_approval_id  UUID
renewal_declined        BOOLEAN DEFAULT FALSE
renewal_declined_reason TEXT
renewal_declined_at     TIMESTAMPTZ
renewal_declined_by     UUID FK → users
renewal_reminder_sent_at TIMESTAMPTZ
renewal_reminder_count  INTEGER DEFAULT 0
-- UniFi
unifi_voucher_id        TEXT  — UniFi _id for Nungambakkam LGF
created_by              UUID FK → users
created_at / updated_at TIMESTAMPTZ
```

**Indexes**: `idx_contracts_lead_id`, `idx_contracts_proposal_id`, `idx_contracts_status`, `idx_contracts_end_date`, `idx_contracts_next_billing_date`, `idx_contracts_parent`, `idx_contracts_leegality_doc`, `uniq_contracts_dept_id` (partial, WHERE department_id IS NOT NULL)

**RLS**: Enabled. All four CRUD policies allow any `authenticated` user. Row-level access control is enforced in API route handlers by role checks, not at the DB policy level.

### Related Tables

| Table | Purpose |
|---|---|
| `contract_documents` | KYC document checklist per contract. Columns: `document_type`, `label`, `is_required`, `status` (`pending`/`uploaded`/`approved`/`rejected`/`deferred`), `reviewed_by`, `rejection_reason`, `notes`. FK → `documents(id)` for the actual file. |
| `contract_members` | People occupying seats. Columns: `name`, `phone`, `email`, `is_active`. FK → `contracts(id)` CASCADE. |
| `voucher_issuances` | WiFi voucher issued per seat. Columns: `voucher_id` (FK → `voucher_repository`, nullable for UniFi), `seat_number`, `valid_from`, `valid_until`, `is_active`, `revoked_at`, `revoke_reason`, `seat_occupant_email`, `unifi_voucher_id`, `contract_member_id`. |
| `voucher_repository` | Pre-uploaded WiFi codes. Columns: `voucher_code`, `status` (`available`/`issued`/`expired`/`revoked`), `validity_days`, `location_id`. |
| `contract_service_quotas` | Print/service monthly free quota per contract+service. Unique on `(contract_id, service_id)`. |
| `contract_facilities` | Legacy complimentary item quotas (name, unit, free_quota, cost_per_unit). |
| `contract_addons` | Recurring add-on charges. Columns: `description`, `amount` CHECK > 0, `effective_from`, `effective_until`, `is_active`. |
| `contract_space_allocations` | Maps physical space units to contracts. Columns: `space_unit_id`, `start_date`, `end_date`, `status` (`active`/`ended`). |
| `contract_electricity_config` | Per-contract electricity billing overrides (utility_ratio, generator_ratio, customer rates). Unique on `contract_id`. |
| `cosec_access_users` | COSEC device-level enrollment per member. `user_type = 'member'`, `entity_id` → `contract_members.id`. |
| `contract_contacts` | Per-contract contact persons (finance, occupant, signatory, etc.). |

---

## State Machine / Status Lifecycle

### Contract Status Enum
`draft` | `sent` | `viewed` | `accepted` | `rejected` | `active` | `renewal_in_progress` | `renewed` | `expired` | `terminated`

### Valid Transitions (`CONTRACT_STATUS_TRANSITIONS` in `src/lib/constants.ts`)

```
draft                → sent, terminated
sent                 → viewed, accepted, rejected
viewed               → accepted, rejected
accepted             → active, rejected
rejected             → (terminal — clone to new draft instead)
active               → renewal_in_progress, expired, terminated
renewal_in_progress  → renewed, active, terminated
renewed              → (terminal — the source contract; new contract is separate)
expired              → renewal_in_progress, terminated
terminated           → (terminal)
```

**Key enforcement points:**
- The PATCH handler in `[id]/route.ts` validates transitions against `CONTRACT_STATUS_TRANSITIONS` and rejects invalid jumps with HTTP 400.
- `draft → active` is intentionally blocked — contracts must pass through `sent → accepted` so the customer has seen the terms.
- The `renew` endpoint sets `renewal_in_progress` directly on the parent (not via PATCH transitions) because it needs to bypass the normal guard.

### Status Timestamp Columns
Each status transition records the timestamp and acting user:

| Transition | Timestamp column | Actor column |
|---|---|---|
| → sent | `sent_at` | `sent_by` |
| → viewed | `viewed_at` | `viewed_by` |
| → accepted | `accepted_at` | `accepted_by` |
| → rejected | `rejected_at` | `rejected_by` |
| → active | `activated_at` | `activated_by` |
| → terminated | `terminated_at` | `terminated_by` |
| → renewed | `renewed_at` | `renewed_by` |

### Auto-expiry
The daily cron (`/api/cron/contract-expiry`) automatically transitions `active` contracts to `expired` when `end_date < today (IST)`, provided no renewal draft exists in `draft/sent/viewed/accepted/active` status for that contract.

---

## Business Rules (Hard — Never Bypass)

### Activation Gate

Before a contract can move to `active`, ALL of the following must pass (server-enforced in `PATCH /api/contracts/[id]`):

1. **Proposal linked** — `proposal_id` must be set. No exceptions.
2. **Pro-rata paid** — `proposal.payment_status === 'paid'`
3. **Deposit paid or waived** — if `proposal.security_deposit_months > 0`, then `proposal.deposit_payment_status === 'paid'`. If deposit months is 0, `proposal.deposit_waiver_verified_at` must be set (admin OTP approval).
4. **No pending escalation approval** — `escalation_approval_status` must not be `'pending'` or `'rejected'` (applies to renewal drafts with reduced escalation).

**Exceptions:**
- Renewal contracts with `deposit_carried_from` set skip the payment gate entirely (deposit rolled over).
- Admins can bypass with a non-empty `payment_override_reason` in the PATCH body (logged to audit trail). Non-admins attempting override receive HTTP 403.

### KYC Gate (Soft)

KYC completeness is checked client-side and prevents the "Activate" button from showing. However, if **all** KYC docs are either `approved` or `deferred`, the contract can still be activated (with a confirmation warning about deferred docs).

KYC completeness: `allSatisfied = total === 0 || (approved + deferred) === total`

### Space Allocation (Soft Warning)

If the allocated seats in `contract_space_allocations` total fewer than `contract.seats`, a warning dialog is shown before activation. The user can proceed; it does not block activation.

### Contract Creation Rules

- Proposal must have `status = 'accepted'` (enforced server-side in POST `/api/contracts`).
- All financial fields are copied from the proposal; they cannot be overridden at contract creation.
- End date: use explicit `end_date` if provided; otherwise `start_date + tenure_months - 1 day`.
- On creation, `proposal_service_quotas` are copied to `contract_service_quotas` (and legacy `complimentary_items` to `contract_facilities`).

### Termination Rules

- Only `admin` or `manager` roles can terminate. HTTP 403 for other roles.
- `termination_reason` is required (server validates; client also enforces via textarea UI).
- Only `draft` contracts can be deleted via DELETE. All others are terminal-state-only.

### Voucher Issuance Rules

- Contract must be `active`.
- `signed_document_id` must be set (uploaded signed contract). This is a hard gate on the voucher POST endpoint.
- Voucher validity matching: target = `tenure_months × 30 days`; tolerance = ±20%. A group must have enough vouchers for all unfilled seats, or an informative error is returned naming the shortfall.
- Per seat: max one active issuance per `seat_number`.
- UniFi locations (Nungambakkam LGF): vouchers are created via API (`createUnifiVoucher`) instead of pulled from the repository. Duration = exact minutes from now to `contract.end_date`.

### Department ID Rules

- Globally unique (across all locations and contracts). `uniq_contracts_dept_id` partial unique index.
- The PATCH handler performs an application-level duplicate check (returning HTTP 409 with the conflicting contract number) before DB insert.
- Contract must have a `location_id` before a `department_id` can be set (returns HTTP 400 otherwise).
- Empty string is normalised to NULL.

### Renewal Rules

- Only `admin`, `manager`, `sales_rep` can initiate or decline renewals.
- Cannot renew if an existing non-terminal renewal already exists (HTTP 409 with the existing renewal's ID).
- Source contract must be in `active`, `expired`, or `renewal_in_progress` status.
- Parent moves to `renewal_in_progress` when draft is created; moves to `renewed` only when the renewal draft is **activated**.
- Deleting a renewal draft (DELETE on a `draft` contract with `is_renewal = true`) restores the parent back to `active`.
- Escalation: `item.unit_price × (1 + escalation% / 100)`, rounded to nearest Rs 10. Seat-proportional items (`quantity === oldSeats`) are scaled to new seat count; flat items are unchanged.
- If a non-admin proposes an escalation below the parent's rate (or 0%), an `approval_requests` row is created and `escalation_approval_status` is set to `'pending'`. The renewal draft cannot be activated until an admin approves.
- Admin can waive escalation entirely post-creation via `PATCH /api/contracts/[id]/renew` (`waive_escalation: true`, `waiver_reason` required).

### Voucher Revocation on Termination/Expiry

On `terminated` or `expired`:
1. All active `voucher_issuances` are marked `is_active = false`, `revoke_reason` set.
2. Corresponding `voucher_repository` rows are set to `status = 'revoked'`.
3. UniFi API vouchers (`unifi_voucher_id`) are revoked via `revokeUnifiVoucher()` (fire-and-forget, non-fatal).
4. Email sent to `it@theworkvilla.com` and `techsupport@theworkvilla.com` listing all revoked codes (so they can disable in WiFi system). **This is critical** — the CRM revokes in its DB but the physical WiFi management system must be updated manually based on this email.

### COSEC Access Revocation on Termination/Expiry

On `terminated` or `expired` (from `active`): all `cosec_access_users` with `user_type = 'member'` linked to this contract's members are set to `enrollment_status = 'blocked'` and `setUserActive(..., false)` is called on each device. Fire-and-forget, non-fatal.

---

## Validation Rules

| Rule | Where enforced |
|---|---|
| `lead_id` required (UUID) | Zod schema (server) |
| `proposal_id` required (UUID) | Zod schema (server) |
| `proposal.status === 'accepted'` before contract creation | Server (POST `/api/contracts`) |
| `billing_cycle` one of `monthly/quarterly/half_yearly/yearly` | Zod enum (server) |
| `tenure_months` positive integer | Zod (server) |
| `seats` positive integer | Zod (server) |
| `workspace_description` min 1 char | Zod (server) |
| `security_deposit_months` ≥ 0, default 3.0 | Zod (server) |
| `escalation_percentage` 0–100, default 10.0 | Zod (server) |
| `notice_period_months` ≥ 0, default 2.0 | Zod (server) |
| `lock_in_months` 1–18 (nullable) | Zod (server) |
| `member_signatory_name` required | Zod (server) |
| `member_signatory_designation` required | Zod (server) |
| `agreement_date` required | Zod (server) |
| `end_date >= start_date` (when explicit) | Zod `.refine()` (server) |
| `billing_mode` IN ('proforma_first','gst_direct') | DB CHECK constraint + PATCH allowedFields whitelist |
| `department_id` globally unique (non-null) | DB partial unique index + app-level check in PATCH |
| `termination_reason` non-empty | Server PATCH (returns HTTP 400) + client textarea validation |
| Status transition validity | `CONTRACT_STATUS_TRANSITIONS` map enforced in server PATCH |
| Only admin can override payment gate | Server PATCH (role check) |
| Only admin/manager can terminate | Server PATCH (role check) |
| Only admin/manager/sales_rep can renew or decline | Renew/decline-renewal routes (role check) |
| Voucher issuance requires active status | Server POST vouchers |
| Voucher issuance requires signed_document_id | Server POST vouchers |
| GST number format | Zod regex on Lead: `/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/` |
| E-signing requires member email | Server sign/initiate (returns 400 with message) |
| E-signing requires member_signatory_name | Server sign/initiate (returns 400) |

---

## Role Permissions

### Contract List and Detail
All authenticated roles can read contracts.

### Status Transitions (via PATCH)
- `draft → sent`: any authenticated user
- `sent → viewed/accepted/rejected`: any authenticated user
- `accepted → active`: any authenticated user if activation gate passes; admin can bypass with override
- `active → terminated`: `admin`, `manager` only
- Any status → `renewal_in_progress`: set by renew endpoint only, roles: `admin`, `manager`, `sales_rep`

### Quota / Facility Editing (`CONTRACT_QUOTA_ROLES`)
Roles that may ever edit quotas/facilities: `admin`, `manager`, `sales_rep`, `accounts`

On **locked** contracts (`CONTRACT_QUOTA_LOCKED_STATUSES` = `active`, `renewal_in_progress`, `renewed`, `terminated`, `expired`): only `admin` or `manager` can edit.
On non-locked contracts (`draft`, `sent`, `viewed`, `accepted`): all four quota roles can edit.

### Renewal / Decline
`admin`, `manager`, `sales_rep` only.

### Escalation Waiver
`admin` only (via `PATCH /api/contracts/[id]/renew`).

### KYC Document Review (approve/reject)
Any authenticated user can upload; review roles enforced client-side but not strictly at API level (check the review route for current enforcement).

---

## Billing Mode

The `billing_mode` column controls how the monthly billing cycle works:

| Mode | Behaviour |
|---|---|
| `proforma_first` (default) | Proforma Invoice generated first; customer pays; GST invoice issued after payment confirmation |
| `gst_direct` | GST invoice issued immediately; due date = issue date + 7 days |

Changed via PATCH with `billing_mode` field. Toggled in the `ContractInvoicesSection` component on the detail page.

---

## Integration Points

### Proposals
- A contract can only be created from an `accepted` proposal.
- Activation gate checks `proposal.payment_status` and `proposal.deposit_payment_status`.
- Financials (items, subtotal, tax, discount) are always sourced from the linked proposal.

### Billing Statements (`src/lib/billing.ts`)
- Activation raises **no** invoice. It calls `unbilledMonths()` and, if any month is already past its billing run with no rent statement, records them on the audit trail as `unbilled_months_at_activation`. The same check drives the amber banner on the contract's Invoices card. Billing itself is left to the month-end rent run or the per-contract "Bill next cycle" action — activation must never send a customer a back-dated invoice as a side effect.
- The monthly cron also calls this for all active contracts.

### Leads
- `autoUpdateLeadStatus(supabase, lead_id, 'contract')` is called on activation, which moves the lead to `won` status.

### WiFi Vouchers
Two modes determined by `locations.wifi_voucher_mode` and `isUnifiLocation()`:
- **Repository mode** (most locations): draws from `voucher_repository` table, matches by `validity_days` within ±20% of `tenure_months × 30`.
- **UniFi API mode** (Nungambakkam LGF, `unifi_site_id` set): creates vouchers on-demand via the UniFi API with exact duration in minutes (`calcVoucherMinutes(end_date)`).

### COSEC Access Control
When adding a member to an active contract, `provisionUser()` is called on all `entry_point` category COSEC devices at the contract's location. Members are provisioned as `userActive: false` initially (they self-enroll via biometric/PIN). PIN is sent to the member's phone via WhatsApp/SMS DLT.

On contract termination/expiry: all provisioned members are blocked via `setUserActive(..., false)` on all devices.

### Leegality (E-signing)
- `POST /api/contracts/[id]/sign` with `action: 'initiate'` — client generates PDF (browser-only jsPDF) and sends as base64. Server calls `uploadForEStampAndSigning()`.
- Two signers: lessor (Naval Chordia, `naval@theworkvilla.com`, +919791097900) and lessee (customer, using Aadhaar eSign).
- Signing URLs are stored: `leegality_sign_url` (lessor/TWV), `leegality_lessee_sign_url` (customer).
- Status polling: `action: 'check_status'` calls `getSigningStatus()`. When `COMPLETED`, `signed_at` is set.
- Webhook: `src/app/api/webhooks/leegality` (separate route) handles async completion callbacks.

### Electricity Billing
Per-contract overrides in `contract_electricity_config` table. The `ContractElectricityTab` component manages utility ratio, generator ratio, and customer-facing rates. Editable by `admin` and `manager` only.

### Space Occupancy
`contract_space_allocations` links to `space_units` for the floor canvas. On termination, all `active` allocations are set to `status = 'ended'` (server-side, fire-and-forget).

### Print/Service Quotas
`contract_service_quotas` links to `service_catalog` items (by `service_id`). Usage data from `service_usage_records` (sourced from printer reports) is shown alongside quota in the GET response. Overage rates are stored per quota row.

---

## Key User Flows

### Creating a Contract
1. User opens a lead detail page with an accepted proposal.
2. Opens `CreateContractDialog` (from lead page, not contracts page).
3. Fills in: billing cycle, tenure, start date, seats, workspace description, signatory details, agreement date.
4. API `POST /api/contracts` validates the Zod schema, checks proposal status === 'accepted', inherits all financials, calculates end date and next_billing_date, inserts contract as `draft`, copies service quotas and legacy complimentary items.
5. Redirected to `/contracts/[id]`.

### Activating a Contract
1. User navigates to a `draft`/`accepted` contract.
2. System checks linked proposal payment status client-side and shows "Cannot activate" warning if not paid.
3. If KYC documents exist and all are `approved` or `deferred`, the "Activate" button is shown.
4. If space allocation is under-committed, a warning dialog is shown (non-blocking).
5. PATCH request sent with `status: 'active'` (and optional `payment_override_reason` for admin bypass).
6. Server validates transition, checks activation gate, sets `activated_at/by`.
7. Side effects (all async, non-fatal): billing statement generation, UniFi voucher issuance (if UniFi location), parent contract marked `renewed` (if renewal), renewal voucher auto-issuance.
8. Lead status auto-updated to `won`.

### Renewing a Contract
1. On an `active` or `expired` contract, admin/manager/sales_rep clicks "Renew".
2. `ContractRenewalDialog` allows overriding tenure, seats, start date, billing cycle, escalation%.
3. `POST /api/contracts/[id]/renew` creates renewal draft contract with:
   - All fields carried from parent
   - Items escalated by `escalation_percentage` (rounded to Rs 10)
   - Seat-based items scaled proportionally
   - `deposit_carried_from` set to parent ID (bypasses payment gate at activation)
   - `deposit_shortfall` calculated for information
4. If non-admin proposes reduced escalation: `approval_requests` row created, renewal draft gets `escalation_approval_status = 'pending'`.
5. Parent contract moves to `renewal_in_progress`.
6. KYC docs (approved only), contract facilities, space allocations, and service quotas copied to new contract.
7. Renewal draft is then processed through the normal agreement flow (send → view → accept → activate).
8. On renewal activation: parent marked `renewed`, parent's vouchers revoked, new vouchers auto-issued.

### Terminating a Contract
1. Admin or manager clicks "Terminate" button on an `active` contract.
2. Must provide `termination_reason` (required textarea).
3. PATCH request: server enforces role (admin/manager), validates reason non-empty.
4. Side effects: COSEC members blocked, space allocations ended, vouchers revoked (both UniFi and repository), email sent to IT/tech support, voucher revocation email sent.

### Voucher Issuance
1. Upload signed contract document first (hard prerequisite).
2. Click "Issue Vouchers" in `ContractVouchersSection`.
3. For repository mode: system matches available vouchers by `validity_days` within ±20% of tenure. Must have enough for all unfilled seats. Issues one per seat (seat 1 through N), marks repository row as `issued`.
4. For UniFi mode: API call creates voucher with exact duration in minutes. Code returned immediately.
5. Can also issue per-seat (for replacing or issuing to a specific seat).

---

## Known Pitfalls and Gotchas

1. **`draft → active` is intentionally blocked.** The transition table does not include this path. If you see UI that appears to allow it, check the PATCH handler — it will return HTTP 400. Contracts must go `draft → sent → (viewed) → accepted → active`.

2. **Deletion is `draft`-only.** If a user wants to discard a non-draft contract, there is no UI delete — they must `reject` or `terminate` it.

3. **Renewal draft deletion restores parent.** DELETE on a renewal draft restores the parent from `renewal_in_progress` back to `active`. If the parent fails to restore (e.g. race condition), the parent stays stuck. Check the cron or manually PATCH the parent.

4. **Parent transitions to `renewed` on renewal activation, not on renewal draft creation.** This is intentional: creating a renewal draft should not lock the parent as "renewed" until the new contract is actually active.

5. **Voucher validity matching tolerance is ±20%.** A 12-month contract (target 360 days) will accept vouchers with 288–432 days validity. If your voucher pool has only 365-day vouchers, they match a 12-month contract but NOT an 11-month one (target 330 days, tolerance 264–396 — 365 falls within, actually it does). Always verify the match warning in the API response.

6. **UniFi voucher revocation is fire-and-forget.** If the UniFi API is down during termination, the CRM DB is updated correctly but the actual WiFi access may not be revoked. The IT email still goes out — staff must follow up manually.

7. **PDF is browser-generated (jsPDF is not SSR-compatible).** `generateMembershipAgreementPDF` can only be called client-side. The sign endpoint receives PDF as base64 from the browser. Never try to call this from an API route or server component.

8. **`billing_mode` column has a DB CHECK constraint.** Only `'proforma_first'` or `'gst_direct'` are accepted. The PATCH handler's allowedFields whitelist provides the first gate; the DB constraint is the safety net.

9. **`department_id` uniqueness is enforced by both application code (PATCH handler checks for clash) and DB partial unique index.** Old migration 00121 removed the per-location uniqueness and made it global. Do not reintroduce location-scoped uniqueness — the printer server network is global.

10. **Service quota upsert uses `onConflict: 'contract_id,service_id'`.** The unique constraint on `(contract_id, service_id)` must exist in the DB. If a migration ever drops that constraint, the upsert will create duplicates.

11. **KYC document status `deferred` does not block activation.** Deferred items are treated the same as `approved` for activation purposes (they both count toward "satisfied"). A confirmation dialog is shown when deferred docs exist, but activation proceeds.

12. **`next_billing_date` is set at creation and updated by billing logic.** Do not manually set this unless you know exactly what you are doing — the cron relies on it to determine when to generate the next statement.

13. **COSEC member seat count guard.** Adding a member via `POST /api/contracts/[id]/members` will be rejected with HTTP 409 if `count(active members) >= contract.seats`. This is enforced server-side.

14. **Signed contract is required before vouchers can be issued** (hard gate in the voucher POST endpoint), but is NOT required for contract activation. This means a contract can be `active` without a signed document — only voucher issuance is blocked until then. The UI shows an amber warning on the signed contract card if the contract is active without a document.

15. **`search_contracts` RPC (PostgreSQL function) handles all searches.** Direct Supabase `.or()` cannot reach joined relation columns. If you add a new searchable field from a joined table, you must update the `search_contracts` function in a migration.

---

## Environment and Config Dependencies

| Dependency | Where used |
|---|---|
| `LEEGALITY_API_KEY`, `LEEGALITY_API_URL`, `LEEGALITY_PROFILE_ID`, `LEEGALITY_PRIVATE_SALT` | `src/lib/leegality.ts` — e-signing |
| `NEXT_PUBLIC_APP_URL` / `VERCEL_URL` | `[id]/route.ts` — renewal auto-issue vouchers internal fetch |
| `CRON_SECRET` | Contract expiry cron (`Authorization: Bearer <secret>`) |
| `RESEND_API_KEY` | Voucher revocation and renewal transition emails |
| UniFi config: `UNIFI_API_URL`, `UNIFI_USERNAME`, `UNIFI_PASSWORD`, `UNIFI_CONSOLE_ID` | `src/lib/unifi.ts` — voucher API for UniFi locations |
| COSEC device config stored in `cosec_devices` table | `src/lib/cosec.ts` |
| `locations.unifi_site_id` (DB column) | Determines if a location uses UniFi voucher mode |
| `locations.wifi_voucher_mode` ('repository' or 'unifi_api') | Also checked via `isUnifiLocation()` |

### `app_settings` Table Keys Used by Contracts
None directly. Razorpay (for payment collection on proposals) uses `app_settings` but that is handled in the proposals module.

---

## Constants Reference (`src/lib/constants.ts`)

```typescript
CONTRACT_STATUSES           // tuple of all valid status strings
CONTRACT_STATUS_LABELS      // display labels e.g. { active: "Active" }
CONTRACT_STATUS_COLORS      // Tailwind CSS classes per status
CONTRACT_STATUS_TRANSITIONS // state machine map (see State Machine section)
CONTRACT_QUOTA_LOCKED_STATUSES  // ["active", "renewal_in_progress", "renewed", "terminated", "expired"]
CONTRACT_QUOTA_ROLES        // ["admin", "manager", "sales_rep", "accounts"]
BILLING_CYCLES              // ["monthly", "quarterly", "half_yearly", "yearly"]
BILLING_CYCLE_LABELS        // display labels
BILLING_CYCLE_MONTHS        // { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 }
CONTRACT_PAYMENT_MODES      // ["cash", "upi", "card", "bank_transfer", "razorpay"]
CONTRACT_PAYMENT_STATUSES   // ["pending", "verified", "rejected"]
KYC_DOCUMENTS               // Record<entity_type, string[]> — required docs by entity type
ENTITY_TYPE_LABELS          // display labels for entity types
```

### KYC Document Sets by Entity Type
Defined in `KYC_DOCUMENTS` (keyed by `lead.entity_type`):
- `individual`: Aadhaar, PAN, Cancelled Cheque, GST Certificate
- `proprietorship`: PAN/Aadhaar of proprietor, GST, Shop & Establishment / Udyam, Business Address Proof, Photo
- `partnership`: Partnership Agreement, Authority Letter, Cancelled Cheque, Partners KYC, GST
- `llp`: LLP Agreement/Registration, LLP PAN, Cancelled Cheque, Partners KYC, GST
- `pvt_ltd` / `public_ltd`: Company PAN, CoI, Board Resolution, MOA & AOA, Directors KYC, Cancelled Cheque, GST
- `trust` / `society` / `huf`: entity-specific sets
