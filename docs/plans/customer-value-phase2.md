# Customer Value tab — Phase 2 plan (snapshots, pillar scores, tier, story)

Status: **plan agreed 2026-10-16, decisions D1 to D4 settled, nothing built.** Written 2026-10-16, after phase 1 went live (Journey, Money,
renewal note: PRs #911, #914, #918, #924). Parent spec: [customer-value-tab-spec.md](../customer-value-tab-spec.md).
Format follows [center-analytics-data-source.md](center-analytics-data-source.md).

## 1. Goal

Turn the Value tab from "facts about the customer" into "how is this customer doing, and which way is
it heading": four pillar scores, an A–D tier, a trend arrow, a rules-written story with a suggested
action, and score history, all computed nightly into snapshot tables and read cheaply.

**Delivers:** snapshot tables, nightly job and backfill, scoring library, Summary sub-tab (header tier,
pillars, story, 12-month score line, top evidence), Performance sub-tab (trends), a Recompute button.

**Does not deliver (later phases):** comparison with the center (3), electricity (4), Wi-Fi (4b), cost
simulator and real margin (5), portfolio list and renewal outlook (6).

## 2. The honest starting point: what each pillar can use today

Checked against the schema, staging and the phase 0 findings. Production row counts are still
unverified (phase 0 coverage query not yet run), so every row below carries a confidence rule instead
of assuming data exists.

| Pillar | Inputs available now | Gaps | Phase 2 verdict |
|---|---|---|---|
| **Payment** | days late per paid invoice, on-time share, overdue now, reminders, partial payments, overpayments (all built in `money.ts`) | invoices before the due-date work have no due date; `reminder_count` is a running total, not dated | **Solid.** Ship. |
| **Friction** | tickets, `sla_breached`, `reopen_count`, `resolution_time_minutes`, `satisfaction_rating`, billing queries, booking waiver/refund requests | tickets carry no customer link (see 2.1); `billing_queries` table is missing on staging, check prod | **Good if linking works.** Ship with a confidence flag. |
| **Engagement** | seats paid over time (`contract_space_allocations`), bookings per seat, renewal behaviour (Journey), tenure | seats **used** needs door access, which exists only at centers with devices; Wi-Fi comes in 4b | **Partial.** Ship with a confidence flag; "seats used" only where door data exists. |
| **Profitability** | concessions as % of revenue (counted ones), escalation outcomes, rent per seat | **real margin needs costs**, which arrive in phases 4 and 5. Rent waivers are not a reliable giveaway signal (phase 1 finding). | **Revenue side only.** See decision D1. |

### 2.1 Linking tickets to a customer (the hard part)

`facility_issues` has `space_unit_id`, `reporter_name/email/phone`, `linked_feedback_id`, but no
contract or lead column. Linking, in order of trust:

1. **Space allocation by date:** ticket's `space_unit_id` falls inside a `contract_space_allocations`
   window for the ticket's `reported_at`. Strong where the ticket names a unit.
2. **Reporter match:** `reporter_email` / `reporter_phone` equals a `contract_members` row on an active
   contract. Medium; covers tickets raised by a person without a unit.
3. **Linked feedback:** `linked_feedback_id` leads to a booking or lead. Rare, weak.

Anything unlinked is excluded and reported as a coverage figure ("62% of this center's tickets could be
attributed"), never silently counted against anyone. `scope` is the technical area (e.g. `hvac`), **not**
a customer/internal flag, so it cannot be used to filter.

## 3. Scoring method

Defaults are proposals for Vinit to confirm (D2). All are stored as settings, not hard-coded.

**Window and weighting.** Trailing 6 months, recency-weighted with a 3-month half-life, so a bad last
month moves the score more than a bad month five months ago. Customers with under 3 months of history
show **"Not enough data"**, not a grade.

**Per-metric score (0–100).** Percentile rank within a cohort (same center, active, 3+ months of
history). When the cohort has fewer than 8 customers, fall back to fixed reference scales (below) so a
small center still gets a score. Every score records which method produced it.

**Pillar score.** Weighted mean of its available metric scores. **Confidence** = weight of inputs
present ÷ weight expected. A pillar below 0.5 confidence is shown as "low confidence" and excluded
from the tier.

| Pillar | Metrics (weight inside pillar) | Fixed reference scale (small cohorts) |
|---|---|---|
| Payment | average days late (40), on-time share (30), overdue now (20), reminders per invoice (10) | 0 days late = 100, 15+ days late = 0; on-time 100% = 100, 40% = 0; any invoice 30+ days overdue caps at 30 |
| Friction | tickets per seat per quarter (30), SLA-breached share (20), repeat issues / reopens (20), average satisfaction (20), billing queries per quarter (10) | 0 tickets per seat = 100, 0.6 per seat = 0; satisfaction 5 = 100, 2 = 0 |
| Engagement | seats used ÷ paid (40, only with door data), bookings per seat (20), seat trend (20), renewal behaviour (20) | usage 80%+ = 100, 30% = 0; renewed = 100, declined = 0 |
| Profitability (revenue side) | counted concessions % of revenue (50), rent per seat vs center average (30), escalation outcomes (20) | concessions 0% = 100, 15%+ = 0 |

**Overall and tier.** Weighted mean of the pillars that meet confidence. Proposed weights
Profitability 35 / Payment 25 / Engagement 20 / Friction 20, renormalised over the pillars present.
Tier: A at 75 or more, B 60 to 74, C 40 to 59, D below 40. A tier needs **at least two** confident
pillars, otherwise "Not enough data".

**Trend.** Overall now minus overall 90 days ago: up arrow at +5 or more, down arrow at −5 or less,
flat between. Shown as "from A-" style context (previous tier).

**Replay rule (correctness).** Backfilled history must use only what was known at each month end: an
invoice paid in October was *unpaid* in September's snapshot. Scores are computed by the same pure
functions with an `asOf` date, and tests pin this.

## 4. The story and the suggested action

Rules, not AI text (spec 5.2). Up to five sentences, in priority order, each tied to a metric and a
record so every claim is clickable:

1. Standing: "Pays about N days late, M reminders in 90 days" (Payment).
2. Open problems: "N tickets overdue" / "N unpaid invoices, up to D days overdue".
3. Direction: "Margin/score down from X to Y since <month>" (only if the trend is real).
4. Usage: "Uses P% of the seats they pay for" (only where door data exists).
5. Context: "Renewal in N days" (from Journey).

Suggested action: one of a short fixed list chosen by rule (clear overdue tickets before renewal; chase
overdue invoices; review seat count at renewal; protect, strong and stable; not enough data yet).
Each rule has a unit test with a named example.

## 5. Data model

Two new tables, both **RLS on, SELECT for admin only**, writes by the service role from the job. Number
to be picked against every branch with `check-migration-numbers.mjs` (highest taken was 00610).

`customer_value_monthly` (one row per lead per month, unique on `(lead_id, month)`):
`lead_id`, `month` (first of month), `revenue_ex_gst`, `invoiced_count`, `paid_count`, `avg_days_late`,
`on_time_count`, `measured_count`, `overdue_amount`, `reminders`, `concessions_counted`, `seats_paid`,
`seats_used_avg` (nullable), `tickets_linked`, `tickets_unlinked`, `tickets_sla_breached`,
`tickets_reopened`, `satisfaction_avg` (nullable), `bookings`, `data_flags` (jsonb), `computed_at`.

`customer_value_scores` (one row per lead per as-of date, unique on `(lead_id, as_of)`):
`lead_id`, `as_of`, `payment`, `friction`, `engagement`, `profitability` (each nullable),
`confidence` (jsonb per pillar), `overall` (nullable), `tier` (nullable), `trend_vs_90d` (nullable),
`method` (jsonb: percentile or fixed scale per metric, cohort size), `story` (jsonb: sentences with
evidence references), `settings_version`, `computed_at`.

Settings (existing `app_settings` table, no new table): `value_weights`, `value_tier_cutoffs`,
`value_window_months`, `value_half_life_months`, `value_cohort_min`. Defaults live in code; a row only
exists once an admin changes one.

Sizes are small (about 150 customers): monthly rows are ~2,000 per year, score rows ~55,000 per year
if daily. Daily is kept because the 90-days-ago comparison then needs no interpolation.

## 6. The nightly job

- `GET /api/cron/customer-value`, `CRON_SECRET` bearer check, wrapped in `withCronHealth`
  (`cron/customer-value`), `maxDuration = 60`, same shape as `energy-ledger-capture`. Scheduled once a
  day in `vercel.json` at a quiet slot (the 04:30 to 04:45 UTC slots are busy; pick late evening UTC).
- **Set-based loading:** fetch statements, payments, tickets, bookings, allocations and members for all
  customers in a few chunked queries, then compute in memory per customer. Not per-customer query loops.
- **Per-customer isolation:** one failure is recorded in the `cron_health` details and does not stop the
  run; the response is non-2xx if any customer failed so the health page shows it.
- **Idempotent:** upserts on the unique keys, safe to re-run.
- **Backfill:** a one-off script using the same functions with `asOf` per month end, run against
  staging first. History before data existed stays empty and flagged, never invented.
- `POST /api/leads/[id]/value/recompute` (admin): recompute one lead on demand.
- **Read-only against everything else, and sends nothing to anyone.** It cannot call a dispatching
  endpoint; it only reads tables and writes the two snapshot tables.

## 7. The UI

- **Header (above the sub-tabs):** tier badge, trend arrow with "was A-", customer name, last computed
  time, Recompute. Shows "Not enough data" instead of a tier when appropriate.
- **Summary sub-tab (new, default):** four pillar cards each with a confidence chip, the story and the
  suggested action, a 12-month overall-score line (plain SVG, no chart library), and the top four
  evidence rows linking to the invoice or ticket. Reads one `customer_value_scores` row plus 12 monthly
  rows: 2 queries, as the spec's budget requires.
- **Performance sub-tab (new):** pillar scores over time, days-to-pay per invoice (dots), tickets per
  month, seats paid vs used. Plain SVG to avoid loading `recharts` for four small charts; revisit if a
  chart needs interaction.
- Existing Journey and Money stay as they are; Summary becomes the default sub-tab.

## 8. Build order (five PRs, each independently reviewable)

| PR | Content | Needs prod migration |
|---|---|---|
| 0 | Rent waiver type: one column on `contract_rent_waivers` (giveaway or billed elsewhere), a choice in the waive dialog, existing rows default to "unknown", and Money counts a waiver as a concession only when it is a giveaway. | **yes** |
| A | Scoring library: windows, percentile/fixed scales, pillar and tier maths, trend, `asOf` replay, story rules, with unit tests. No database, no UI. | no |
| B | Migration for the two tables, monthly-metrics builder, ticket linking, backfill script (run on staging) | **yes** |
| C | Score computation, nightly cron enabled, Recompute endpoint | no (needs B live) |
| D | Header, Summary sub-tab | no |
| E | Performance sub-tab | no |

PR 0 and A can start now: A depends only on D2 (settled) and PR 0 on D3 (settled). B waits for the phase 0 coverage results (D4). B should wait for the phase 0
coverage results so the confidence rules match reality. Each migration is applied to staging first and to
production by me after merge, as before.

## 9. How we will know it is right

- **Unit tests** for every formula and for the replay rule (an invoice paid after month end is unpaid in
  that month's snapshot), small-cohort fallback, ties in percentiles, the "two confident pillars" rule,
  and every story rule.
- **Staging fixtures:** extend the seed with a strong customer, a deteriorating one, a brand-new one, one
  with a break, one with a negotiated escalation, so every state renders.
- **Acceptance check against Vinit's judgement:** Vinit names the customers he considers best and
  worst; the scores must put most of the best in A/B and most of the worst in C/D. Disagreements are
  read one by one before the tier is trusted. The tier is labelled **beta** for the first two weeks.
- Click-through on staging with the amber banner, then on production after merge, as in phase 1.

## 10. Decisions and risks

**Decisions (Vinit, 2026-10-16)**
- **D1. Profitability:** show a revenue-side score now, labelled partial, and leave it out of the tier
  unless it meets the confidence rule. Real margin joins in phase 5.
- **D2. Weights and cut-offs:** the proposed defaults. Profitability 35 / Payment 25 / Engagement 20 /
  Friction 20; A 75+, B 60 to 74, C 40 to 59, D below 40. Editable later through settings.
- **D3. Rent waiver type:** yes, add a type (giveaway vs billed elsewhere) so real concessions can count.
  This is a small prerequisite change, scheduled as **PR 0** below.
- **D4. Coverage query first:** Vinit runs `docs/customer-value-phase0-coverage.sql` on production and
  sends the output. Work that needs no data (the scoring library) proceeds meanwhile; the database
  work (PR B) waits for the results.
- **D5. Beta label (not asked, default assumed):** the tier carries a "beta" label and a review of the
  best and worst customers for the first two weeks. Say so if you would rather show it as final.

**Risks**
- Ticket attribution may leave many tickets unlinked at some centers; the coverage figure and the
  confidence flag are the mitigation, and Friction may be low-confidence for those centers.
- Door-access history is thin or absent at some centers, so Engagement leans on bookings and seat trend
  there.
- Percentiles in tiny centers are noisy; the fixed-scale fallback and the shown cohort size mitigate it.
- A customer can change after the nightly run; Recompute covers urgent cases.
- The job must stay inside 60 seconds as customers grow; if it does not, switch to a cursor over
  customers across several invocations.
- Scores can be misread as verdicts: every score links to its evidence, and the tier carries the beta
  label at first.

## 11. Out of scope for this phase

Cost simulator and electricity (4, 5), Wi-Fi (4b), center comparison (3), portfolio list and renewal
outlook (6), message sentiment, any customer-facing output, any automated action on a customer.
