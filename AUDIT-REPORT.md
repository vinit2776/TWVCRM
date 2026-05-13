# TWV CRM -- Comprehensive Audit Report

> Generated: 9 May 2026 | Scope: Business flows, friction points, technical risks
> Purpose: Review only -- no code changes made

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Part A: Business Process Flows](#2-part-a-business-process-flows)
3. [Part B: Business Friction & Ambiguity](#3-part-b-business-friction--ambiguity)
4. [Part C: Technical Performance & Crash Risks](#4-part-c-technical-performance--crash-risks)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Priority Matrix](#6-priority-matrix)

---

## 1. Executive Summary

The TWV CRM is a mature, feature-rich coworking space management system covering leads, bookings, contracts, billing, and refunds across six interconnected business flows. The codebase enforces financial integrity through payment gates, quota-aware billing, and a four-step refund approval pipeline.

However, three categories of risk were identified:

**Business Process:** The system has well-defined state machines for bookings, contracts, and billing. But the contract lifecycle has **no transition validation** (any status can jump to any other), the booking `payment_status` can be **directly overwritten via PATCH** without payment verification, and the cancellation flow has **two divergent code paths** with different role restrictions and side effects.

**Business Friction:** Five critical friction points were found: unguarded contract status transitions, direct payment_status overwrite, GST double-counting between charge-level and statement-level tax rates, credit double-redemption race condition, and cancel endpoint role inconsistency. Additionally, usage charge creation and contract renewal have no role restrictions at all.

**Technical Risk:** The booking creation endpoint executes up to **20-25 sequential database queries** per request against Vercel's default 10-second timeout. The monthly summary endpoint runs **12 unbounded sequential queries**. Race conditions exist in billing statement charge additions and credit redemption. Multiple API routes lack the `maxDuration` export needed for Vercel.

---

## 2. Part A: Business Process Flows

### Flow 1: Booking Lifecycle

**State Machine:**
```
confirmed --> checked_in --> checked_out
    |                            ^
    |--> cancelled               |
    |--> no_show                 |
    |                            |
    +--- (defer) ----------------+
```
Terminal states: `checked_out`, `cancelled`, `no_show`

**Step-by-step:**

| Step | Trigger | Guards | Side Effects |
|------|---------|--------|--------------|
| **Create** | POST /api/bookings | Zod validation, space active, operating hours, overlap check, capacity check | Usage charge (contract), lead auto-create (walk-in), WiFi vouchers (walk-in/guest), credit/prepaid deduction, WhatsApp + SMS, activity log, audit |
| **Check-in** | PATCH status=checked_in | Only from `confirmed`; walk-in payment gate (verified payments >= total_with_gst) | WhatsApp notification, activity log |
| **Check-out** | PATCH status=checked_out | Only from `checked_in`; overtime detection (>15 min late) | Overtime add-on suggestion, WhatsApp notification, feedback email, activity log |
| **Cancel (simple)** | PATCH status=cancelled | Only from `confirmed`; admin/manager=any, others=own only | Voucher revocation, usage charge waiver, waitlist auto-offer |
| **Cancel (rich)** | POST /cancel | Only from `confirmed`; requires reason picklist | All simple-cancel effects + refund request creation, GST invoice flag, lead caution auto-creation |
| **Defer** | POST /defer | Only from `checked_in`; floor_manager/manager/admin | Checkout at "now", booking credit issuance (phone-anchored, location-scoped, 30-day expiry), credit email |
| **Reschedule** | PATCH action=reschedule | Only `confirmed`; slot availability | Duration/total/GST recalculation, reschedule_count increment |
| **Extend** | PATCH action=extend | Only `checked_in`; no next-booking conflict | Pricing recalculation, extension price difference returned |
| **Mark Complimentary** | POST /mark-complimentary | Not cancelled; no verified payments; floor_manager/manager/admin | Amounts zeroed, payment_status=waived, reason required |
| **Import Old Dues** | POST /import-old-dues | Not terminal; no payment collected; same-customer charges | Charges become addons, total recomputed |

**Customer-type branching on creation:**
- **contract_holder / guest:** Usage charge under contract, quota-aware billing (free hours checked against contract_facilities), payment_status = "posted_to_bill"
- **walk_in:** Lead auto-created by phone match, payment_status = "pending"

**Payment modes and auto-verification:**

| Mode | Initial Status | Notes |
|------|---------------|-------|
| Cash | `verified` | Physically collected; cash_handover_status = pending_handover |
| Card | `verified` | Cleared at terminal |
| UPI | `pending` | Unless verify_on_create=true AND role is admin/manager/floor_manager/fms/office_admin |
| Razorpay | `pending` | Webhook flips to verified asynchronously |

---

### Flow 2: Billing & Invoicing

**Statement generation (monthly cron on last day of month):**

| Section | Content |
|---------|---------|
| A: Prepaid Rent | Rent for month M+1 (prorated if contract ends mid-month) |
| B1: Booking Usage | Contract bookings in period (free quota at zero, paid at actuals) |
| B2: Ad-hoc Charges | Manual usage_charges (status=pending) |
| B3: Facility Overages | Meeting room quota overages from facility_usage_records |
| B4: Service Overages | Printer/service overages from service_usage_records |

**Statement state machine:**
```
draft --> finalized --> exported
```

**Key endpoints:**

| Endpoint | Purpose | Role Gate |
|----------|---------|-----------|
| POST /billing/auto-generate | Manual trigger | admin/manager/accounts |
| PATCH /billing-statements/[id] | Status transitions | Any authenticated |
| POST /billing-statements/[id]/add-charge | Ad-hoc charge on draft | admin/manager/accounts |
| POST /billing-statements/[id]/confirm | GST invoice + PDF + Razorpay link + email | admin/manager/accounts |
| POST /billing-statements/[id]/payment | Record payment against statement | admin/manager/accounts |

**GST handling:** Intra-state (Tamil Nadu) = CGST + SGST split; inter-state = IGST.

---

### Flow 3: Contract Lifecycle

**State machine:**
```
draft --> sent --> viewed --> accepted --> active --> renewed
  |                 |                       |
  |                 +-> rejected            +--> expired
  |                                         +--> terminated
  v
(deletable)
```

**Key transitions:**

| Transition | Guards | Side Effects |
|------------|--------|--------------|
| accepted --> active | Payment gate: proposal paid + deposit paid (skip for renewals or admin override) | Lead status --> won, current month billing generated, renewal voucher auto-issuance |
| active --> terminated | Requires termination_reason | WiFi vouchers revoked, IT email sent |
| Renewal (POST /renew) | Source must be active/expired | 10% escalation on line items, deposit shortfall calc, KYC/facilities/allocations copied, source --> renewed |

---

### Flow 4: Lead --> Customer Journey

**Conversion points:**
1. Walk-in booking auto-creates lead by phone match
2. Contract activation advances lead to `won`
3. Proposal acceptance enables contract creation

**Cautions system:** info/warning/danger severity. Danger cautions gate new bookings (UI-enforced acknowledgement). Auto-created on suspected_fake_booking cancellation.

**Credits system:** Phone-anchored, location-scoped, whole-hour, 30-day expiry. Issued via defer or manually by floor_manager+. Redeemed at booking creation.

---

### Flow 5: Cancellation & Refund Pipeline

```
Booking cancelled
    |
    +--> No payment collected: done
    |
    +--> Payment collected, no refund: gst_invoice_required = true
    |
    +--> Payment collected, refund requested:
         |
         v
    pending_approval --> approved --> processed
                     --> rejected (sets gst_invoice_required)
```

Approval: manager/admin. Processing: admin/manager/accounts. Rejection requires reason.

---

### Cross-Flow Dependencies

| Source | Target | Mechanism |
|--------|--------|-----------|
| Booking --> Billing | Contract bookings create usage_charges; rolled into monthly statements |
| Booking --> Lead | Walk-ins auto-create leads; all transitions log to lead timeline |
| Booking --> Credits | Defer flow creates credits; credits redeemed on future bookings |
| Booking --> Vouchers | Walk-in/guest bookings issue WiFi vouchers; cancellation revokes |
| Contract --> Billing | Activation triggers immediate billing; cron generates monthly |
| Contract --> Vouchers | Termination revokes; renewal re-issues |
| Contract --> Lead | Activation advances lead status to won |
| Cancel --> Refund --> Billing | Retained payments flagged for GST invoice |
| Proposal --> Contract | Inherits financials, seeds contract_facilities |
| Prepaid --> Booking | Deducts credits at booking creation |

---

## 3. Part B: Business Friction & Ambiguity

### Critical (could cause financial errors or data corruption)

| # | Issue | Files | Business Impact | Suggestion |
|---|-------|-------|-----------------|------------|
| **C1** | **Contract status has no transition validation** -- any status can jump to any other (e.g., terminated --> active) | `api/contracts/[id]/route.ts` L40-143 | Reactivated terminated contract triggers billing generation and invoices to former customers | Add transition whitelist like the case status machine |
| **C2** | **Booking payment_status directly overwritable** via generic PATCH without payment verification | `api/bookings/[id]/route.ts` L524-530 | Staff can mark booking "paid" without actual payment, bypassing check-in payment gate | Remove open payment_status write or restrict to admin/accounts with audit |
| **C3** | **GST double-counting in statement add-charge** -- per-charge GST stored but statement totals use flat statement-level tax_percentage | `api/billing-statements/[id]/add-charge/route.ts` L87-137 | Charge at 5% GST gets 18% applied at statement level; incorrect invoice amounts | Use charge-level GST in rollup OR remove per-charge GST fields |
| **C4** | **Credit double-redemption race condition** -- read-then-write with no DB locking | `api/bookings/route.ts` L737-766 | Two concurrent bookings can both redeem the same credit hours | Atomic UPDATE with WHERE guard via Supabase RPC |
| **C5** | **Cancel endpoint role inconsistency** -- PATCH allows 7 roles, POST /cancel restricts to admin/manager | PATCH L456-505 vs /cancel L99-104 | Floor manager cancelling via PATCH skips refund request creation, caution flagging, GST invoice flags | Deprecate cancel branch in generic PATCH |

### Moderate (confusion or inefficiency)

| # | Issue | Files | Impact | Suggestion |
|---|-------|-------|--------|------------|
| **M1** | No revert-to-draft for billing statements | `api/billing-statements/[id]/route.ts` L187-203 | Finalized statement with wrong charges requires developer intervention | Add guarded admin-only revert if no payment recorded |
| **M2** | Refund reject reuses `approved_by` column | `api/refund-requests/[id]/reject/route.ts` L54-67 | Audit trail mixes approvers and rejectors | Add `rejected_by` / `rejected_at` columns |
| **M3** | No-show retains payment without GST invoice flag or refund path | `api/bookings/[id]/route.ts` L508-517 | Pre-paid no-shows have silently retained payments | Mirror cancel side effects |
| **M4** | Usage charges POST has no role restriction | `api/usage-charges/route.ts` L48-136 | Any authenticated user can create charges against any contract | Restrict to admin/manager/accounts/floor_manager |
| **M5** | Post-checkout addon block with no clear alternative | `api/bookings/[id]/addons/route.ts` L63-68 | "Use Log Charge" referenced but endpoint doesn't exist by that name | Create dedicated post-checkout charge path or relax addon block |
| **M6** | Contract renewal has no role restriction | `api/contracts/[id]/renew/route.ts` L26-31 | Any staff can create renewal contracts with financial commitments | Restrict to admin/manager/accounts |

### Minor

| # | Issue | Impact |
|---|-------|--------|
| m1 | "Posted to Bill" label still jargon despite being flagged | Staff confusion |
| m2 | Booking timeline doesn't visualize payment step | No at-a-glance payment status |
| m3 | IST timezone computed 3 different ways across files | Maintenance risk |
| m4 | Payment epsilon (0.01) inconsistent between banner and check-in gate | Edge-case payment mismatch |

---

### Role Permission Matrix

| Action | admin | manager | floor_mgr | sales_rep | accounts | fms | office_admin |
|--------|:-----:|:-------:|:---------:|:---------:|:--------:|:---:|:-----------:|
| Cancel booking (PATCH) | Y | Y | Y | Own | Y | Y | Y |
| Cancel booking (/cancel) | Y | Y | N | Own | N | N | N |
| Mark complimentary | Y | Y | Y | N | N | N | N |
| No-show | Y | Y | Y | N | N | N | N |
| Check in/out | Y | Y | Y | Y | Y | Y | Y |
| Create payment | Y | Y | Y | Y | Y | Y | Y |
| Add charge to statement | Y | Y | N | N | Y | N | N |
| Approve refund | Y | Y | N | N | N | N | N |
| Process refund | Y | Y | N | N | Y | N | N |
| Create usage charge | **any** | **any** | **any** | **any** | **any** | **any** | **any** |
| Renew contract | **any** | **any** | **any** | **any** | **any** | **any** | **any** |
| Issue booking credit | Y | Y | Y | N | N | N | N |
| Defer booking | Y | Y | Y | N | N | N | N |

**Key gaps:** Usage charge creation and contract renewal/decline have zero role restriction.

---

### GST Consistency Audit

| Touchpoint | GST Rate Source | Rounding Method |
|------------|----------------|-----------------|
| Booking creation | Hardcoded 18% | `parseFloat(x.toFixed(2))` |
| Booking addon | body.gst_rate or catalog default | `parseFloat(x.toFixed(2))` |
| Booking recompute | DB column `booking.gst_rate` | `parseFloat(x.toFixed(2))` |
| Usage charge | body.gst_rate defaulting to 18 | `parseFloat(x.toFixed(2))` |
| Statement add-charge | body.gst_rate (charge) vs statement.tax_percentage (rollup) | `parseFloat(x.toFixed(2))` |
| Statement generation (billing.ts) | contract.tax_percentage defaulting to 18 | `Math.round(x * 100) / 100` |

**Inconsistencies:** (1) Rounding methods differ (`parseFloat(toFixed)` vs `Math.round`). (2) Per-charge GST rates stored but never used in statement totals. (3) Booking GST hardcoded to 18% despite DB column existing.

---

### Orphaned / Incomplete Features

| Feature | Status | Files |
|---------|--------|-------|
| Waitlist auto-offer on rich cancel | Comment says "implemented elsewhere" but doesn't execute | `/cancel/route.ts` L203-207 |
| Contract renewal-reminders cron | Fully implemented but untracked in git | `api/cron/renewal-reminders/route.ts` |
| Contract-expiry cron | Same -- untracked | `api/cron/contract-expiry/route.ts` |
| Billing lifecycle status component | Untracked in git | `components/billing/billing-lifecycle-status.tsx` |
| Contract renewal dialog | Untracked | `components/contracts/contract-renewal-dialog.tsx` |
| Migration 00135 (billing phase 1) | Untracked -- may not be applied in prod | `supabase/migrations/00135_*.sql` |
| Migration 00136 (contract renewal) | Same | `supabase/migrations/00136_*.sql` |
| Legacy refund fields on booking PATCH | Coexists with refund_requests table; no UI uses them | `api/bookings/[id]/route.ts` L536-548 |

---

## 4. Part C: Technical Performance & Crash Risks

### Critical (could crash or freeze)

| # | Issue | File | Queries | Risk |
|---|-------|------|---------|------|
| **T1** | **Booking creation: 20-25 sequential DB queries** | `api/bookings/route.ts` POST | 20-25 | Exceeds Vercel 10s timeout on complex paths (contract + credit + prepaid + vouchers) |
| **T2** | **Monthly summary: 12 unbounded sequential queries** | `api/accounting/monthly-summary/route.ts` | 12 | No LIMIT clauses; payload can exceed several MB at scale |
| **T3** | **Booking PATCH (cancel): 12-15 sequential queries** with per-voucher loop | `api/bookings/[id]/route.ts` PATCH | 12-15 | Sequential voucher revocation multiplies with voucher count |
| **T4** | **Race condition: add-charge to draft statement** -- read-then-write totals | `api/billing-statements/[id]/add-charge/route.ts` L117-148 | N/A | Two concurrent charges; second overwrites first's total |
| **T5** | **Race condition: credit double-spend** -- acknowledged but unfixed | `api/bookings/route.ts` L737-766 | N/A | Non-atomic read-then-increment allows double-redemption |

### High (significant slowdown)

| # | Issue | File | Impact |
|---|-------|------|--------|
| **H1** | Statement GET: 5 sequential queries (3 could parallel) | `api/billing-statements/[id]/route.ts` | ~2-3s response time |
| **H2** | Lead billing summary: 4 sequential queries with large IN clauses | `api/leads/[id]/billing-summary/route.ts` | Slow for leads with many bookings |
| **H3** | Booking search: ILIKE on 5 unindexed columns | `api/bookings/route.ts` GET | Sequential scan on every search |
| **H4** | bookings/new page: 60 useState hooks in 1882-line component | `bookings/new/page.tsx` | Every state change re-renders entire tree |
| **H5** | bookings/[id] page: 38 useState hooks in 2178-line component | `bookings/[id]/page.tsx` | Same re-render issue |
| **H6** | No `maxDuration` export on 6 heavy API routes | Multiple | Default 10s Vercel timeout insufficient |

### Medium (noticeable lag)

| # | Issue | File | Impact |
|---|-------|------|--------|
| **M1** | Recharts imported statically in lead-billing-snippet (not dynamically loaded) | `leads/lead-billing-snippet.tsx` | ~200KB gzip added to every lead detail page |
| **M2** | Raw `<img>` tags instead of next/image in 7 files | Multiple | No lazy loading, no WebP, no responsive sizing |
| **M3** | No AbortController on client-side fetches (except 1 component) | Multiple | Abandoned promises call setState on unmounted components |
| **M4** | Billing page loads all contracts (limit=100) for dropdown on mount | `billing/page.tsx` | Unnecessary payload on page load |
| **M5** | `select("*")` in 20+ API routes fetching all columns | Multiple | Excess data transfer and memory |

### Low (minor inefficiency)

| # | Issue | Impact |
|---|-------|--------|
| L1 | Voucher issuance: sequential per-voucher update+insert loop | Slow for 10+ attendee bookings |
| L2 | setTimeout without proper cleanup in command-palette search | Memory leak on rapid query changes |
| L3 | Duplicate state variables in billing page (3 separate useState for one fetch) | Partial staleness on fetch failure |
| L4 | logAudit fire-and-forget with no error handling | Silent audit gaps |

---

### Query Count Audit

| API Route | Method | Queries (worst case) | maxDuration? | Risk Level |
|-----------|--------|:--------------------:|:------------:|:----------:|
| /api/bookings | POST | 20-25 | No (10s) | CRITICAL |
| /api/bookings/[id] | PATCH cancel | 12-15 | No (10s) | CRITICAL |
| /api/bookings/[id] | PATCH checkout | 8-10 | No (10s) | HIGH |
| /api/accounting/monthly-summary | GET | 12 unbounded | No (10s) | CRITICAL |
| /api/billing-statements/[id] | GET | 5 | No (10s) | MEDIUM |
| /api/billing-statements/[id]/add-charge | POST | 6 | No (10s) | MEDIUM |
| /api/leads/[id]/billing-summary | GET | 4 | No (10s) | MEDIUM |
| /api/booking-payments | POST | 5 | No (10s) | LOW |
| /api/billing/auto-generate | GET | 6-8 + N inserts | Yes (60s) | MEDIUM |

---

### Race Condition Inventory

| Risk | Scenario | Severity | Guard? |
|------|----------|:--------:|:------:|
| Double-charge on draft statement | Two users add charges simultaneously; second write overwrites first's total | HIGH | None |
| Credit double-spend | Two bookings redeem same credit concurrently; read-then-write not atomic | HIGH | Comment only |
| Prepaid double-spend | Same pattern for prepaid purchases | HIGH | None |
| Double payment submission | Two payments check paidSoFar simultaneously; both pass balance check | MEDIUM | Partial (epsilon) |
| Concurrent booking overlap | Two users book same slot; both pass overlap check before insert | LOW | App-level only |
| Add-charge during finalization | Charge created but statement total stale if finalized concurrently | MEDIUM | Status check only |

---

### Missing Indexes

| Table.Column | Used In | Indexed? |
|--------------|---------|:--------:|
| bookings.booking_number | Search | No (needs GIN/trgm) |
| bookings.guest_name | Search | No |
| bookings.guest_phone | Search | No |
| bookings.guest_company | Search | No |
| bookings.payment_status | Monthly summary filter | No |
| bookings.contract_id + booking_date + status | Quota calculation | Partial (no composite) |
| booking_payments.booking_id + status | Payment verification | Partial |

---

### Bundle Size Concerns

| Component | Recharts? | Dynamic Import? |
|-----------|:---------:|:---------------:|
| utilization-dashboard.tsx | Yes (~200KB) | Yes (good) |
| revenue-report.tsx | Yes (~200KB) | Yes (good) |
| lead-billing-snippet.tsx | Yes (~200KB) | **No -- static** |
| bookings/new/page.tsx | No | **No -- all static, 1882 lines** |

---

## 5. Cross-Cutting Concerns

### Items that span multiple categories:

1. **GST calculation inconsistency** (Business + Technical): Three different rounding methods, per-charge GST never used in statement rollup, and hardcoded 18% at booking creation despite DB column. This is both a financial correctness issue and a maintenance risk.

2. **Two cancel paths** (Business + Technical): The PATCH cancel and POST /cancel have different role gates, different side effects, and different code paths. This creates both business ambiguity (which path does the UI use?) and technical debt (two places to maintain).

3. **No-show orphan** (Business): Retains payment without GST flag, doesn't waive usage charge, no refund path. Crosses billing, booking, and refund flows.

4. **Race conditions in financial operations** (Technical + Business): Credit double-spend, statement charge double-count, and concurrent payment submissions all have financial impact.

5. **Vercel timeout risk** (Technical): The most user-facing operation (booking creation) is the most query-heavy, creating the highest crash probability on the most critical flow.

---

## 6. Priority Matrix

### Immediate (fix before next deploy)

| # | Category | Issue | Why Urgent |
|---|----------|-------|------------|
| C2 | Business | payment_status overwritable without verification | Direct revenue leakage vector |
| T6 | Technical | Add `maxDuration` to 6 heavy routes | Prevents timeout crashes on production |
| C1 | Business | Contract status has no transition validation | Can reactivate terminated contracts and trigger billing |

### Short-term (this sprint)

| # | Category | Issue |
|---|----------|-------|
| C3 | Business | GST double-counting in statement add-charge |
| C4 | Business | Credit double-redemption race condition |
| C5 | Business | Cancel endpoint role inconsistency |
| T1 | Technical | Booking creation 20-25 queries (batch with Promise.all) |
| T4 | Technical | Race condition in add-charge totals |
| M4 | Business | Usage charges POST -- add role restriction |
| M6 | Business | Contract renewal -- add role restriction |

### Medium-term (next 2-4 weeks)

| # | Category | Issue |
|---|----------|-------|
| T2 | Technical | Monthly summary unbounded queries |
| H3 | Technical | Booking search ILIKE on unindexed columns |
| H4/H5 | Technical | Giant page components (60/38 useState hooks) |
| M1 | Business | Statement revert-to-draft |
| M3 | Business | No-show payment handling |
| M5 | Business | Post-checkout charge path |

### Low priority (backlog)

| # | Category | Issue |
|---|----------|-------|
| M2 | Business | Refund reject column overloading |
| M-tech-1 | Technical | Recharts static import in lead snippet |
| M-tech-2 | Technical | Raw img tags (7 files) |
| M-tech-3 | Technical | AbortController missing on client fetches |
| L1-L4 | Technical | Voucher loop, setTimeout cleanup, etc. |
| Orphaned | Business | Commit untracked cron/migration files or remove them |

---

*This report describes what IS implemented. No code changes were made. Use as input for sprint planning and improvement roadmap.*
