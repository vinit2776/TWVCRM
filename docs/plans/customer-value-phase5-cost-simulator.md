# Customer Value tab — Phase 5 plan (cost simulator and real margin)

Status: **plan only, 2026-10-19. Nothing built. Waiting on decisions D1 to D5.**
Spec: `docs/customer-value-tab-spec.md` section 5.6. Builds on phase 2 (scores), 4 (electricity share) and 4b (Wi-Fi).

## 1. Goal

Show what one customer costs to serve against what they pay, let an admin test a renewal offer
(seats, rent per seat) before making it, and eventually let real margin replace the revenue-only
Profitability pillar. Admin only. The page must say how much of each cost is measured and how much
is a figure someone typed in.

## 2. Cost lines and what we can measure today

| Group | Line | Basis | Source today | Status |
|---|---|---|---|---|
| Variable | Electricity | his kWh share x the center's blended tariff | phase 4 (`electricity-share.ts`) | **Live** where a center has one meter, seat counts and a captured bill |
| Variable | Concessions | moratoriums, booking waivers/refunds, credit notes, giveaway rent waivers, spread over tenure | `money.ts` concessions | **Live** |
| Variable | Facility staff time | logged minutes on tickets tied to him x hourly cost | `facility_issue_time_logs` + the new ticket customer field | **Part live**: minutes are real, the hourly cost is entered; tickets only link to a customer from 19 Oct on |
| Variable | Cost of late payment | days late x invoice value x cost of capital % | stored days-late figures | **Part live**: the % is entered |
| Variable | Pantry and consumables | per person-day present | none | **Needs input** (door data for person-days) |
| Variable | Acquisition cost | one-off commission / tenure months | none | **Needs input** |
| Fixed | Rent share | center lease / seat capacity x his seats | `property_leases` (active lease per center) | **Live** where a lease exists |
| Fixed | Housekeeping, maintenance and AMC, front desk | Rs per seat per month | none | **Needs input** |
| Fixed | Internet | center bill split by seats, or by his share of measured traffic | Wi-Fi ledger (share) | **Needs input** (the bill) |
| Fixed | Head-office overhead | % of revenue | none | **Needs input** |

No figure is invented. A line with no input shows "Needs input" and contributes nothing, and the
**confidence line** says what share of the total cost rests on measured data.

## 3. Outputs

Revenue (ex GST), total cost, **margin after variable costs**, fully-loaded margin (labelled an
estimate), break-even rent per seat, a "where each rupee goes" bar. **What-if sliders** for seats and
rent per seat, computed in the browser from one small base-figures payload: rent share, per-seat costs
and electricity scale with seats; ticket time and acquisition cost do not.

## 4. Parameters

`value_cost_parameters` rows: scope (global default, per center, optional per customer), key, value,
`effective_from`, set by. The value in force for a month is the latest row not after that month, so
changing a rate never rewrites history. Admin only to read or write; every change is audit-logged.
An admin screen under Admin lists each key with its scope, current value and history.

## 5. How it reaches scoring (shadow first)

Profitability today is revenue side only (concessions %, rent vs center, escalation outcomes). Real
margin changes it for every customer, so it ships dark: margin after variable costs is computed and
stored beside each month, shown next to the score, and a setting turns it on. Before turning it on we
look at how many customers would change tier. The fully-loaded margin never feeds the score.

## 6. PRs

1. **A: pure maths + tests.** Cost lines, source status, margins, break-even, what-if scaling, confidence. No I/O.
2. **B: parameters.** Migration for `value_cost_parameters` (RLS, admin only), admin API with Zod and audit, admin screen.
3. **C: Costs sub-tab.** `GET /api/leads/[id]/value/costs` assembles the base figures; the simulator runs in the browser.
4. **D: shadow margin.** Monthly margin stored beside each customer-month, shown on Summary; scoring unchanged.
5. **E (only when you say so):** switch Profitability to the margin metric via the scoring setting.

## 7. Decisions needed

- **D1: parameter scope.** Recommended (and in the spec): global default, per center, optional per-customer override.
- **D2: head-office overhead.** Recommended: stays out of the fully-loaded margin until you enter a percentage (default none), so it cannot colour the number before you trust it.
- **D3: how margin reaches the score.** Recommended: shadow first (PR D), switch on later (PR E) after checking tier changes. Alternative: wire it straight in.
- **D4: starting figures.** I will not guess rupee values. Recommended: parameters start empty, the page shows only the measured lines, and you enter figures as you have them. If you would like to give me a first set (hourly staff cost, per-seat housekeeping and front desk, cost of capital %, pantry per person-day), I will load them as global defaults effective from a date you choose.
- **D5: rent share basis.** Recommended: lease rent / seat capacity x his seats (the same seat split as electricity). Alternative: by floor area, which needs area on every allocated unit.

## 8. Out of scope here

Floor-wise electricity, presence/hybrid electricity (phase 4 follow-up), Wi-Fi traffic share for the internet line (needs a center bill first), the portfolio list and renewal outlook (phase 6).
