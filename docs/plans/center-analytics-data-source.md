# Center Analytics — Data Source Scoping

Status: **Data-source decisions agreed with Vinit 2026-08-21. Not built.** Follows the
[Center Analytics mockup](../..) (interactive HTML artifact, admin-only, center-wise
sales/collections/occupancy). This doc pins down what production tables and queries back each
number on that page before writing migrations or API routes — all five open questions below are
resolved; see the **Decisions** section.

## Goal

For each metric in the mockup, decide: which table(s), which columns, which existing pattern (if
any) to reuse, and what's net-new.

## Diagnosis (from codebase exploration)

### Reuse the existing dashboard route pattern

Every `/api/dashboard/*` widget route follows the same shape: `createAdminClient()` (service
role, bypasses RLS) + an explicit role check + a `location_id` query param, with all aggregation
done in the route (no Postgres RPC/view involved) — e.g.
[`src/app/api/dashboard/occupancy/route.ts`](../../src/app/api/dashboard/occupancy/route.ts).
Center Analytics should follow the same shape: one route per section, admin-only, `location_id`
+ date-range params.

### Sales (new business booked) — no existing period-scoped query to reuse

`contracts` has no `monthly_rent` column — the deal-value field is `contracts.total_amount`
(full-tenure value, computed from `items` JSONB at creation). There's no ready-made "sales in a
period" query anywhere today, but two precedents exist for the underlying columns:

- [`source-roi/route.ts:44-58`](../../src/app/api/dashboard/source-roi/route.ts) sums
  `contracts.total_amount` for `status IN ('active','renewed')` as its revenue metric.
- [`week-in-review/route.ts:74`](../../src/app/api/dashboard/week-in-review/route.ts) and
  [`digest/route.ts:981`](../../src/app/api/digest/route.ts) use `contracts.activated_at` as the
  "deal went live" date for period filtering.

**Recommendation:** `SUM(contracts.total_amount) WHERE activated_at BETWEEN <range> AND
location_id = X`. Alternative (no precedent anywhere): `proposals.total_amount WHERE
status='accepted' AND accepted_at BETWEEN <range>`. Need a decision — see Open Questions.

### Collections and Billed — two parallel, non-reconciled payment paths

This is the important one.

- **Path A (canonical going forward):** `billing_statements` (`status IN
  ('finalized','exported')`) for "Billed", `billing_payments` for "Collected", reconciled through
  [`src/lib/settlement.ts`](../../src/lib/settlement.ts) — the module's own header states this is
  meant to be the *only* place that computes paid-to-date, because two other places already
  diverged on the definition. Used by the cash-aging widget and the receivables page.
- **Path B (legacy, still live):** `contract_payments`, summed directly by
  `revenue-pulse-widget`'s route (mixed with `booking_payments` + `prepaid_purchases`, *not*
  going through `settlement.ts`).
  [`monthly-summary/route.ts:267`](../../src/app/api/accounting/monthly-summary/route.ts) defines
  `BILLING_GO_LIVE = 2026-05-01` — before that date, statement-based billing mostly doesn't exist
  for a contract's history, and the route falls back to reconstructing balances from
  `contract_payments`.

**Implication:** any period that reaches back before May 2026 (e.g. the mockup's "Last 6 months",
which spans to March) will under-report Collections/Billed if we only read Path A. Path B has a
fallback reconstruction already written in `monthly-summary/route.ts:310-330` that could be
reused, but it's not free — it's doing balance reconstruction from `contract.total_amount` ×
elapsed months, not a direct read.

**Recommendation:** Path A (`billing_statements`/`billing_payments` via `settlement.ts`) as the
canonical source going forward. Do **not** reuse revenue-pulse-widget's logic — it's a different,
already-diverged definition of "collected" than what the receivables page shows, and copying it
would give Center Analytics a third definition. Historical accuracy pre-May-2026 needs an
explicit decision — see Open Questions.

### Occupancy — mostly reusable as-is

[`occupancy/route.ts:59-87`](../../src/app/api/dashboard/occupancy/route.ts) already computes,
per location: capacity = `SUM(space_units.capacity) WHERE is_active=true AND type !=
'business_centre'`, occupied = `COUNT(space_seat_occupants) WHERE status='active'`, clamped so
occupied never exceeds capacity. This is seat-level (`space_seat_occupants`), not space-unit-level
(`contract_space_allocations` also exists as a coarser cabin/office-level allocation table — a
second grain, not currently used by the widget).

**Net-new for the drill-down:** room-type breakdown (group the same query by `space_units.type` —
`hot_desk`/`dedicated_desk`/`private_cabin`/`managed_office`/`business_centre`) doesn't exist
anywhere today.

**Recommendation:** reuse the existing occupancy route's logic wholesale for the summary number;
add a `type` group-by for the drill-down. Seat-level grain, matching the existing widget.

### Receivables aging — two incompatible bucket schemes already exist

- Cash-aging widget: `current / 0-30 / 31-60 / 60+`, aged off `billing_statements.period_end`.
- Receivables page (AR Detail — the page you've been actively iterating on, most recently
  [PR #523](https://github.com/vinit2776/TWVCRM/pull/523)): `notDue / 1-15 / 16-30 / 31-45 / 45+`, aged off
  `billing_statements.due_date` via `daysOverdue()` in
  [`src/lib/receivables.ts`](../../src/lib/receivables.ts).

Neither is location-filtered today — `accounting/receivables/route.ts` returns all locations,
no `location_id` param. Per-location aging is net-new either way.

**Recommendation:** adopt the receivables page's `due_date`-based scheme, since it's the one
under active development and more accurate (aligns to when payment was actually due, not to
statement period). Add a `location_id` filter to that route (join `billing_statements →
contracts.location_id`) rather than building a third bucket scheme.

### Performance

No materialized views anywhere in `supabase/migrations/` (434 files, zero
`CREATE MATERIALIZED VIEW`). Table scale can't be confirmed from static analysis, but
`BILLING_GO_LIVE = 2026-05-01` and the `CONVERSION_CUTOFF` constant in
[`dashboard/route.ts:26`](../../src/app/api/dashboard/route.ts) suggest the CRM only went fully
live ~Apr–May 2026 — likely low-thousands of rows in `contracts`/`proposals`/`billing_statements`
today, not a scale that needs a materialized view yet.

Indexing gaps that matter for this page specifically: `contracts.activated_at` is **not**
indexed (despite being the recommended Sales date column), and `billing_statements.due_date` is
**not** indexed (despite the receivables route already ordering by it). `billing_statements` also
has no `location_id` column — every query needs to join through `contracts`.

## Proposed API shape

Mirror the existing `/api/dashboard/*` convention:

- `GET /api/analytics/centers/summary?start=&end=&location_id=` — sales/collections/billed/
  occupancy per center, backing the KPI tiles + comparison table.
- `GET /api/analytics/centers/trend?metric=sales|collections|occ&months=6` — per-center monthly
  series, backing the trend chart.
- `GET /api/analytics/centers/[locationId]/detail?start=&end=` — drill-down: pipeline counts,
  aging buckets, room-type occupancy, top clients.

Each: `createAdminClient()`, role check (`admin` only, per the mockup), Zod-validated query
params, following the pattern in e.g.
[`src/app/api/procurement/bills/[id]/route.ts`](../../src/app/api/procurement/bills/%5Bid%5D/route.ts).

## Decisions (agreed with Vinit 2026-08-21)

1. **Sales definition:** contract activation — `SUM(contracts.total_amount) WHERE activated_at
   BETWEEN <range> AND location_id = X`. Matches the precedent in `source-roi` and
   `week-in-review`.
2. **Collections/Billed historical accuracy:** accept inaccuracy before the May 1 2026 billing
   go-live. Build on `billing_statements`/`billing_payments` via `settlement.ts` only — do
   **not** wire in the `contract_payments` fallback reconstruction. "Last 6 months" will show
   artificially low/zero collections for March–April; that's a known, accepted limitation, not a
   bug to fix later in this phase.
3. **Aging buckets:** adopt the receivables page's `due_date`-based scheme (`notDue / 1-15 /
   16-30 / 31-45 / 45+`). Add a `location_id` filter to `accounting/receivables/route.ts` rather
   than inventing a third bucket scheme.
4. **Occupancy grain:** seat-level (`space_seat_occupants`), matching the existing occupancy
   widget exactly.
5. **Drill-down scope:** build room-type occupancy, per-location aging, and top-clients-by-billing
   in phase 1, alongside the summary KPIs/table/trend chart — not deferred to a later phase. The
   mockup already sold the drill-down as part of the page; shipping without it would be a visible
   regression from what was demoed, and the underlying queries are straightforward joins rather
   than new infrastructure.

## Non-goals for this phase

- Not refactoring `revenue-pulse-widget`'s existing (already-diverged) collections logic — this
  is a new page, not a dashboard cleanup.
- Not backfilling pre-May-2026 collections into the canonical `billing_statements` path (per
  Decision 2).
