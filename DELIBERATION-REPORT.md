# TWV CRM -- Solution Deliberation Report

> Generated: 9 May 2026 | Input: AUDIT-REPORT.md findings
> Purpose: Options analysis for each problem. No code changes made.
> Next step: Owner reviews, picks options, then we build an implementation plan.

---

## How to read this document

Each problem has 2-3 solution options with effort/pros/cons/risk. A **Recommendation** is given for each. Problems are grouped into three tracks that can be worked in parallel:

- **Track 1: Business Process Gaps** (6 problems) -- structural flow issues
- **Track 2: Data Integrity & Permissions** (7 problems) -- security, consistency, cleanup
- **Track 3: Technical Performance** (9 problems) -- speed, stability, scalability

---

# Track 1: Business Process Gaps

## 1.1 Contract status has no transition validation

**Current state:** The PATCH handler accepts any `body.status` and writes it. A terminated contract can be moved back to `active`, which triggers billing generation and sends invoices to former customers. The codebase already has a precedent: `CASE_STATUS_TRANSITIONS` in `constants.ts` is a `Record<string, string[]>` used by the case management flow.

**Option A: Hardcoded transition whitelist (mirror CASE_STATUS_TRANSITIONS)**
- Add `CONTRACT_STATUS_TRANSITIONS` map to `constants.ts`. PATCH checks `transitions[oldStatus]?.includes(newStatus)` before allowing update.
- Effort: **Low** (~25 lines)
- Pros: Follows established pattern, no dependencies, no migration, sharable with frontend for UI validation
- Cons: Must be kept in sync manually with new statuses
- Risk: Existing admin workflows that skip statuses (e.g., draft straight to active) would break. Renewal endpoint also sets source to "renewed" -- must be checked.

**Option B: Database-level CHECK constraint (trigger function)**
- PL/pgSQL trigger `BEFORE UPDATE ON contracts` validates transitions.
- Effort: **Medium**
- Pros: Impossible to bypass from any caller
- Cons: Harder to maintain (PL/pgSQL vs TS), error messages harder to surface, duplicates logic if frontend also needs the map
- Risk: Cron jobs and renew endpoint could hit the trigger unexpectedly

**Option C: State machine library (xstate)**
- Effort: **High**
- Pros: Most rigorous, visualization tools
- Cons: Overkill for 9 statuses and ~8 transitions, ~30KB dependency, team doesn't know xstate

**Recommendation: Option A.** Mirrors the proven `CASE_STATUS_TRANSITIONS` pattern already in the codebase. Under an hour to implement. The constant can also be imported by the frontend to disable invalid status options in dropdowns.

---

## 1.2 Two cancel paths (PATCH vs POST /cancel) with different role gates and side effects

**Current state:** PATCH cancel allows 7 roles, revokes vouchers, waives charges, offers waitlist. POST /cancel restricts to admin/manager, adds refund requests, GST flags, lead cautions -- but skips waitlist auto-offer. The UI is split: quick-cancel buttons use PATCH, the CancelBookingDialog uses POST /cancel.

**Option A: Deprecate PATCH cancel branch -- return 400 pointing to /cancel**
- Effort: **Medium** (API trivial, but 2 UI pages need refactoring to show dialog)
- Pros: Single source of truth, forces reason tracking
- Cons: Breaks quick-cancel convenience, more friction for simple cancels

**Option B: Shared `executeBookingCancellation()` function used by both paths**
- Extract ~120 lines into `src/lib/booking-cancel.ts`. Both PATCH and POST call it. PATCH passes default reason `"customer_requested"`.
- Effort: **Medium**
- Pros: Both paths get identical side effects, PATCH retains quick-action convenience, eliminates root cause (duplicated logic)
- Cons: Two entry points still exist (but share logic)
- Risk: Low -- clean refactor preserving both UI flows

**Option C: Keep both but copy missing side effects into PATCH**
- Effort: **Low** (~30 lines)
- Pros: Fastest fix
- Cons: Code duplication (the root cause), divergence will reappear over time
- Risk: Band-aid that perpetuates the problem

**Recommendation: Option B.** Extracting a shared function eliminates the root cause without removing the quick-action convenience staff use. Unify role gate to the broader set (7 roles) since the richer side effects are protective, not restrictive. This also naturally solves Problem 1.4 (waitlist) below.

---

## 1.3 No-show retains payment without GST invoice flag or refund path

**Current state:** The no-show branch sets `status = "no_show"` and does nothing else. No voucher revocation, no usage charge waiver, no GST flag. Pre-paid walk-in no-shows have silently retained payments.

**Option A: Mirror cancel side effects in the no-show branch**
- Add voucher revocation, usage charge waiver, GST invoice flag, waitlist offer.
- Effort: **Low** (~25 lines, or call shared function from 1.2)
- Pros: GST compliance, voucher cleanup, minimal workflow change
- Cons: No refund path for no-shows (staff must manually create refund request)

**Option B: Dedicated POST /api/bookings/[id]/no-show endpoint**
- Rich flow with reason picklist, optional refund via refund_requests table.
- Effort: **High** (~150 lines + dialog component)
- Cons: Over-building for a low-frequency action, introduces same dual-path problem

**Option C: Treat no-show as a cancel with reason = "no_show"**
- Effort: **Low-Medium**
- Cons: Loses `no_show` as a first-class status used in ~20+ places (timeline, banner, filters, tabs). Semantically different from cancel.
- Risk: **High** -- sweeping UI changes needed

**Recommendation: Option A**, ideally calling the shared function from Problem 1.2 with `skipRefundRequest: true`. Simple, additive, GST-compliant. No-show remains a distinct status for analytics.

---

## 1.4 Waitlist auto-offer missing from rich cancel path

**Current state:** PATCH cancel has working waitlist logic (query waitlist, offer slot with 2-hour expiry). POST /cancel has a comment saying "implemented elsewhere" and does nothing.

**Option A: Copy-paste waitlist logic** -- Effort: Very low. Cons: Code duplication.
**Option B: Extract shared `offerSlotToWaitlist()` function** -- Effort: Low.
**Option C: Async event/webhook on cancellation** -- Effort: High. Over-engineering.

**Recommendation: Option B**, folded into the shared cancel function from Problem 1.2. If 1.2 is solved with `executeBookingCancellation()`, waitlist becomes part of that function automatically.

---

## 1.5 Post-checkout addon block with no clear alternative

**Current state:** Addons blocked after checkout. Error message references "Log Charge" which doesn't exist. The existing `usage-charges` endpoint is the closest alternative but doesn't integrate with booking totals.

**Option A: Relax addon block for checked_out (admin/manager/accounts only)**
- Effort: **Low**
- Cons: Walk-in bookings marked "paid" would need re-collection; the payment guard on the addon route would still block addons when payment_status === "paid"

**Option B: Dedicated POST /bookings/[id]/post-checkout-charge endpoint**
- Effort: **Medium**
- Cons: Walk-in payment collection gap (who pays after they left?)

**Option C: Improve usage-charges to link to bookings + show on booking detail**
- Fix error message, add "Related charges" section to booking detail page, make AddUsageChargeDialog accessible from booking detail for checked-out bookings.
- Effort: **Low-Medium**
- Pros: No new API endpoint, reuses existing infrastructure, works for contract holders (charges flow to billing statement)
- Cons: Walk-in post-checkout charges remain manual (acceptable -- rare scenario)

**Recommendation: Option C.** Post-checkout charges are primarily a contract-holder concern (overtime, damages). Usage charges flow naturally into billing statements. For walk-ins, manual process is acceptable given rarity.

---

## 1.6 Statement revert-to-draft missing

**Current state:** Only `draft -> finalized -> exported` allowed. No way back. Finalization triggers GST invoice number, PDF, Razorpay link, email -- all irreversible artifacts.

**Option A: Add finalized -> draft transition (admin only, blocked if payment exists)**
- Effort: **Medium**
- Risk: **High for GST compliance.** Reverting a GST-numbered invoice is non-standard under Indian GST rules. Invoice number gaps create audit concerns.

**Option B: Credit note system -- negative statement offsetting the original**
- Effort: **High** (new endpoint, new fields, PDF generation, email flow)
- Pros: GST-compliant (credit notes are the standard correction mechanism)
- Cons: Most complex, staff training needed

**Option C: Void + re-generate -- mark as "voided", auto-create fresh draft**
- New `voided` status. Admin only, blocked if payments exist. Cancels Razorpay link, emails customer, creates cloned draft.
- Effort: **Medium-High**
- Pros: Clear semantics ("old is void, new replaces it"), GST-acceptable before return filing, original retained for audit
- Cons: Razorpay link cancellation adds external dependency

**Recommendation: Option C for the immediate need** (covers "finalized with wrong charge before month-end" -- the common case). Option B (credit notes) as a future enhancement for post-GST-return corrections. Option A is the most intuitive but riskiest for GST compliance.

---

# Track 2: Data Integrity & Permissions

## 2.1 Booking payment_status directly overwritable via PATCH

**Current state:** Any authenticated user can send `{ payment_status: "paid" }` to the PATCH endpoint, bypassing all payment verification. The legitimate path (booking-payments POST) computes `paidSoFar + amount >= grandTotal` from verified payment rows before setting "paid".

**Option A: Remove payment_status from PATCH allowedFields entirely**
- Effort: **Low** (delete 3 lines)
- Pros: Closes the revenue leakage vector completely, forces all changes through verified payment logic
- Cons: If any admin workflow legitimately needs manual override, that path breaks
- Risk: Audit frontend for components sending payment_status via PATCH

**Option B: Keep writable but restrict to admin/accounts + require reason + audit**
- Effort: **Low-Medium**
- Pros: Preserves admin override for edge cases, audit trail
- Cons: Still a bypass path, two competing sources of truth

**Option C: Make payment_status a computed field (derive from booking_payments sum)**
- Effort: **High** (every query referencing payment_status needs rework)
- Pros: Single source of truth, eliminates all inconsistency
- Cons: Performance impact on list pages, "posted_to_bill" and "waived" have no payment rows

**Recommendation: Option A**, with a follow-up dedicated `POST /api/bookings/[id]/override-payment-status` endpoint (admin/accounts only, requires reason) if frontend audit shows legitimate override use. Similar to the mark-complimentary pattern.

---

## 2.2 GST double-counting in statement add-charge

**Current state:** Per-charge GST stored (could be 5%) but statement rollup applies flat `tax_percentage` (typically 18%) across the entire subtotal. A 5% charge gets 18% applied at statement level.

**Option A: "Statement-level GST wins" -- remove per-charge GST from add-charge flow**
- Effort: **Low**
- Pros: Consistent with billing.ts auto-generation, no double-counting
- Cons: Loses ability to apply different GST rates per charge

**Option B: "Charge-level GST wins" -- rollup sums charge-level total_with_gst**
- Effort: **Medium-High**
- Pros: Most GST-compliant (line-item-level rates)
- Cons: Invoice PDF needs mixed-rate support, billing.ts refactor non-trivial

**Option C: "Hybrid" -- force charge GST rate to match statement's tax_percentage**
- On add-charge, set charge's `gst_rate = statement.tax_percentage`. Both levels consistent.
- Effort: **Low** (one line change)
- Pros: Eliminates double-counting, keeps charge-level GST for display, minimal code change
- Cons: Can't handle genuinely different rates per charge (may not be needed today)

**Recommendation: Option C for now.** Closes the bug with minimal risk. If TWV later needs multi-rate GST (food at 5%, services at 18%), Option B can be built properly as a billing platform feature.

---

## 2.3 Usage charges POST has no role restriction

**Current state:** Any authenticated user can create charges against any contract or booking.

**Option A: ALLOWED_ROLES check -- admin/manager/accounts/floor_manager**
- Effort: **Low** (5-10 lines, mirrors add-charge pattern)

**Option B: Role check + manager approval for high-value charges (>5000)**
- Effort: **Medium-High** (new approval queue)

**Option C: Different role gates per charge source (contract vs booking)**
- Effort: **Low-Medium**

**Recommendation: Option A.** Simple, defensible, consistent with the rest of the billing system.

---

## 2.4 Contract renewal has no role restriction

**Current state:** Any authenticated user can create renewal contracts (financial commitments with 10% escalation) and decline renewals.

**Option A: Restrict to admin/manager/accounts**
- Effort: **Low** (5 lines per endpoint)

**Option B: Allow sales_rep to initiate (draft) but only manager can activate**
- Effort: **Low**
- Risk: The source contract is immediately set to "renewed" on renewal creation, not on activation. A junk renewal draft marks the original as "renewed" prematurely.

**Option C: Add "pending_renewal_approval" status for non-manager renewals**
- Effort: **Medium-High** (new status, approval UI)
- Cons: Over-engineering

**Recommendation: Option A**, with a note that the source contract status flip should be deferred to activation, not creation (a separate fix).

---

## 2.5 Refund reject reuses approved_by column

**Current state:** Rejector stored in `approved_by`, mixing approvers and rejectors in queries.

**Option A: Add `rejected_by` + `rejected_at` columns**
- Effort: **Medium** (migration + endpoint update + type update)
- Pros: Clean separation, unambiguous audit trail
- Backfill: `UPDATE refund_requests SET rejected_by = approved_by, rejected_at = approved_at WHERE status = 'rejected'; UPDATE SET approved_by = NULL WHERE status = 'rejected';`

**Option B: Rename `approved_by` to `decided_by`**
- Effort: **Medium-High** (wide blast radius -- FK rename, all references)
- Cons: Loses ability to separately query approvers vs rejectors

**Option C: Rely on audit_trail table for rejection details**
- Effort: **Low**
- Cons: Refund queue UI still shows rejector as "approver" -- confusing

**Recommendation: Option A.** Additive migration, clean separation, includes backfill for historical data.

---

## 2.6 Orphaned/untracked features in git

**Current state:** ~16 modified files uncommitted + untracked feature groups (contract renewal, billing phase 1, cron jobs) + 12 image/doc artifacts.

**Option A: Commit everything on staging branch, test, promote**
- Effort: **Medium**
- Pros: Gets everything into VCS immediately, tests features together
- Risk: If one feature has bugs, entire bundle blocked. Must verify migrations applied.

**Option B: Audit each file individually**
- Effort: **Medium-High**
- Pros: Most thorough
- Cons: Time-intensive

**Option C: Feature branch per group, merge individually**
- Effort: **High** (files are entangled across features)
- Cons: Types and billing files span multiple features, merge conflicts inevitable

**Recommendation: Option A** with pre-commit cleanup (add image/doc files to .gitignore). Verify migrations 00135/00136 are applied to staging DB before deploy. File-by-file audit happens during PR review.

---

## 2.7 Legacy refund fields coexist with refund_requests table

**Current state:** PATCH allows writing `refund_status`, `refund_amount`, etc. directly on bookings -- orphaned from the newer `refund_requests` system. No role restriction, no UI uses them.

**Option A: Remove from PATCH, then drop columns if no data exists**
- Effort: **Low** (Phase 1: delete lines. Phase 2: check prod, drop if empty.)

**Option B: Sync columns from refund_requests via trigger**
- Effort: **Medium**
- Cons: Adds complexity instead of removing it

**Option C: Migrate existing data to refund_requests, then drop columns**
- Effort: **Medium**
- Pros: Complete data migration, clean final state

**Recommendation: Option A (Phase 1 immediately)** -- remove the PATCH write path to close the unguarded vulnerability. Then query prod: if legacy data exists, run Option C migration. If not, drop columns.

---

# Track 3: Technical Performance

## 3.1 Booking creation: 20-25 sequential DB queries

**Current state:** Worst-case path (contract + credit + prepaid + vouchers) executes 20-25 sequential `await supabase.from(...)` calls. No `maxDuration` export. Critical dependency chain: auth -> space -> pricing -> booking insert -> all post-insert writes.

**Option A: Promise.all batching (quick win)**
- Effort: **Low** -- rearrange existing awaits into parallel groups
- Result: Cuts to ~12-15 serial steps. Doesn't fix voucher N+1 loop.

**Option B: Single Supabase RPC (plpgsql function)**
- Effort: **High** (~300 lines of SQL). One round-trip, fully atomic.
- Cons: Business logic split between TS and SQL, harder to maintain/debug

**Option C: Two-phase (sync + async)**
- Effort: **Medium-High**. Fast sync insert, background job for side effects.
- Cons: Eventual consistency, needs monitoring + retry

**Option D: Selective parallelization + voucher batch + maxDuration**
- Batch pre-validation: `[space, credit, prepaid]` in parallel. Post-insert batch: `[facilities, usage_charge_patch, activity, audit]` in parallel. Batch voucher: single `.in('id', voucherIds)` update + single batch insert (eliminates N+1 loop). Add `maxDuration = 30`.
- Effort: **Medium-Low**
- Result: Cuts from ~25 to ~7 serial steps. Voucher batch is the biggest single win.
- Pros: Preserves all logic, independently testable changes
- Risk: Low

**Recommendation: Option D.** Best bang-for-buck. The voucher loop optimization alone turns 2N queries into 2. Combined with `maxDuration = 30`, eliminates the timeout risk.

---

## 3.2 Monthly summary: 12 unbounded sequential queries

**Current state:** 12 sequential queries, none with LIMIT. Walk-in payments query has no contract filter. Prior queries scan all historical data.

**Option A: Promise.all batching + LIMIT clauses**
- Group queries 3-8 (all need just contractIds) into one Promise.all. Group 9-12 into another. Drops from 12 to 4 serial steps.
- Effort: **Low**

**Option B: Pre-computed summary table (cron writes, API reads)**
- Effort: **High**. Cons: Stale data after payment recording.

**Option C: Single Supabase RPC with CTEs**
- Effort: **Medium-High**. One round-trip, DB-side aggregation.

**Recommendation: Option A** as the immediate fix (3x improvement, one hour of work). Option C as follow-up if performance is still insufficient at scale.

---

## 3.3 Race conditions in financial mutations

Three distinct races: (a) credit double-redemption, (b) statement add-charge totals, (c) payment balance check.

**Option A: SELECT FOR UPDATE (pessimistic locking via RPC)**
- Effort: Medium. Pros: Bulletproof. Cons: Holds locks during function execution.

**Option B: Optimistic concurrency (version column)**
- Effort: Medium. Cons: Requires retry logic, Supabase client doesn't expose "rows affected" easily.

**Option C: Application-level advisory locks**
- Same effort as A, same constraint (needs RPC).

**Option D: Atomic SQL -- single UPDATE...WHERE...RETURNING**
- Credit: `UPDATE booking_credits SET hours_used = hours_used + $req WHERE id = $1 AND (hours_total - hours_used) >= $req RETURNING *`
- Statement: `UPDATE billing_statements SET usage_amount = (SELECT SUM(total) FROM usage_charges WHERE billing_statement_id = $1)...` in one statement
- Payment: Conditional INSERT with subquery balance check
- Effort: **Low-Medium** (10-15 line RPC function per race)
- Pros: Simplest correct solution, no explicit locking, no retries, atomic by definition, fastest
- Cons: Error diagnostics are "0 rows returned" -- need follow-up query on failure path for user-facing messages

**Recommendation: Option D (Atomic SQL)** for all three race conditions. One small RPC per race. No schema changes, no retry logic, naturally composes with PostgreSQL MVCC.

---

## 3.4 Giant page components (60 / 38 useState hooks)

**Option A: Extract sub-components (RoomSelector, TimeSlotPicker, CustomerForm, PricingSummary, PaymentSection)**
- Effort: **Medium-High** (2-3 days focused refactoring)
- Pros: Isolated re-renders, easier to test/maintain, natural code-splitting
- Cons: Cross-cutting state needs lifting or context

**Option B: useReducer consolidation**
- Effort: **Medium**
- Cons: Does NOT fix re-render problem -- still one function component

**Option C: react-hook-form + zod**
- Effort: **Medium-High**
- Cons: Not all state is form state (availability, loading, dialogs). Booking form's heavy dynamic behavior (fetch-on-change) doesn't map cleanly.

**Option D: Zustand store with selectors**
- Effort: **Medium**
- Cons: Overkill for page-scoped state, new pattern for the team

**Recommendation: Option A**, combined with selective useReducer within the CustomerForm sub-component (~20 related state variables). Solves both the re-render problem AND the maintainability problem.

---

## 3.5 Missing maxDuration on 6 heavy API routes

**Option A: Add `export const maxDuration = 30` to all 6 routes** -- Effort: **Very low** (6 one-line additions)
**Option B: Global vercel.json config** -- Mixes config approaches, not the App Router convention
**Option C: Only the 3 most critical routes** -- Leaves latent risk on the other 3

**Recommendation: Option A.** Trivial effort, follows established codebase pattern (10 other routes already use it). Can be done in 5 minutes.

---

## 3.6 Booking search: ILIKE on 5 unindexed columns

**Option A: pg_trgm GIN indexes on searchable columns**
- Effort: **Low** (one migration, ~10 CREATE INDEX CONCURRENTLY statements)
- Pros: Existing ILIKE queries work unchanged, dramatic improvement. Standard PostgreSQL extension supported by Supabase.

**Option B: PostgreSQL full-text search (tsvector)**
- Cons: Poor at partial matches, phone numbers, booking number patterns

**Option C: External search service (Meilisearch)**
- Cons: Overkill for current scale (<50K bookings), operational overhead

**Option D: Prefix match on booking_number only**
- Cons: Doesn't improve name/phone search

**Recommendation: Option A.** Solves the problem completely with no code changes. Use `CREATE INDEX CONCURRENTLY` to avoid table locks.

---

## 3.7 Recharts static import in lead-billing-snippet

**Option A: Dynamic import at consumer site**
- One line change: `const LeadBillingSnippet = dynamic(() => import(...), { ssr: false })`
- Effort: **Very low**. ~200KB saved. Follows established pattern (12 other components already dynamically imported).

**Option B: Lighter charting library or tree-shaken imports** -- Medium effort, visual inconsistency
**Option C: CSS-only sparkline** -- No tooltip interactivity

**Recommendation: Option A.** One line, ~200KB saved, zero visual regression.

---

## 3.8 No AbortController on client-side fetches

**Option A: Add AbortController manually to each useEffect** -- Effort: Medium (15-20 blocks)
**Option B: Custom `useFetch` hook** -- Effort: Medium, DRY, consistent pattern
**Option C: Adopt SWR or TanStack Query** -- Effort: Medium-High (30+ components to retrofit), but adds caching, deduplication, retry

**Recommendation: Option B as immediate fix** (custom hook, one afternoon, fixes abort everywhere). **Strong follow-up recommendation for SWR** when bandwidth allows -- it eliminates the triple-state boilerplate and adds caching.

---

## 3.9 Missing database indexes

**Phased approach with correct index types:**

| Phase | Index | Supports |
|-------|-------|----------|
| 1 (immediate) | `booking_payments(booking_id, status)` composite B-tree | Balance checks, payment verification |
| 1 (immediate) | `bookings(contract_id, booking_date, status)` composite B-tree | Quota calculation, monthly billing |
| 2 (next sprint) | `bookings(booking_number) gin_trgm_ops` GIN | Search (overlaps with 3.6) |
| 2 (next sprint) | `bookings(guest_name) gin_trgm_ops` GIN | Search |
| 2 (next sprint) | `bookings(guest_phone) gin_trgm_ops` GIN | Search |
| Skip | `bookings(payment_status)` standalone | Low cardinality -- PostgreSQL won't use it |

Use `CREATE INDEX CONCURRENTLY` for all to avoid write locks.

**Recommendation: Phased approach.** Phase 1 targets highest-frequency queries (every check-in, every contract booking). Phase 2 handles search (can combine with Problem 3.6 migration).

---

# Implementation Priority Summary

## Wave 1: Quick Wins (can ship in 1-2 days)

| # | Fix | Effort | Impact |
|---|-----|--------|--------|
| 3.5 | Add `maxDuration = 30` to 6 routes | 5 min | Prevents timeout crashes |
| 2.1 | Remove payment_status from PATCH | 10 min | Closes revenue leakage |
| 3.7 | Dynamic import for LeadBillingSnippet | 5 min | 200KB bundle savings |
| 2.3 | Add ALLOWED_ROLES to usage-charges POST | 15 min | Closes permission gap |
| 2.4 | Add ALLOWED_ROLES to contract renew/decline | 15 min | Closes permission gap |
| 2.2 | Force charge GST rate = statement tax_percentage | 10 min | Fixes GST double-counting |

## Wave 2: Core Fixes (3-5 days)

| # | Fix | Effort | Impact |
|---|-----|--------|--------|
| 1.1 | CONTRACT_STATUS_TRANSITIONS whitelist | 1h | Prevents contract reactivation |
| 1.2 | Shared `executeBookingCancellation()` function | 4h | Fixes cancel inconsistency + waitlist (1.4) |
| 1.3 | No-show side effects (via shared function) | 1h | GST compliance |
| 3.3 | Atomic SQL RPCs for 3 race conditions | 4h | Eliminates financial race conditions |
| 3.1 | Booking creation parallelization + voucher batch | 4h | 25 queries -> 7, timeout eliminated |
| 3.9 | Phase 1 database indexes | 1h | Faster payment checks + quota calc |
| 2.7 | Remove legacy refund fields from PATCH | 30 min | Closes unguarded vulnerability |

## Wave 3: Medium-term (1-2 weeks)

| # | Fix | Effort | Impact |
|---|-----|--------|--------|
| 3.2 | Monthly summary parallelization | 2h | 3x faster accounting page |
| 3.6 | pg_trgm indexes for search | 1h | Fast booking search |
| 1.5 | Usage-charges on booking detail (post-checkout) | 4h | Cleaner post-checkout charges |
| 2.5 | Refund rejected_by/rejected_at columns | 2h | Clean audit trail |
| 3.8 | Custom useFetch hook | 4h | Fixes all AbortController issues |
| 2.6 | Commit untracked features on staging | 2h | Version control hygiene |

## Wave 4: Longer-term (2-4 weeks)

| # | Fix | Effort | Impact |
|---|-----|--------|--------|
| 3.4 | Extract sub-components from giant pages | 2-3 days | Re-render performance |
| 1.6 | Statement void + re-generate | 1-2 days | Fix billing errors after finalization |
| 3.8+ | Adopt SWR for client-side fetching | 3-5 days | Caching, dedup, professional data fetching |
