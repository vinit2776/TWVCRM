# Customer Value tab — Phase 6 plan (portfolio list, renewal outlook, cross-pillar insights)

Status: **built 2026-10-22: PR A (rules), PR B (portfolio page) and PR C (Summary cards) done. Decisions D1 to D4 were settled on the recommendations.**
Spec: `docs/customer-value-tab-spec.md` (scope item 11, build order phase 6). Builds on everything before it:
scores (phase 2), comparison, electricity, Wi-Fi, cost simulator and the stored margin.

## 1. Goal

The per-customer pieces exist. This phase answers the questions across customers and ahead of time:
**who needs attention now**, **what is coming at the next renewal**, and **what do the pillars say
together** that no single score does. Admin only; no customer-facing output and no automated action.

## 2. The three pieces

### 2.1 Portfolio list
One admin page listing every customer with a score: name, center, tier, overall score, trend, the **change over the
last 90 days**, the four pillar scores, margin after variable costs, days to renewal, and any insight tags.
- **Sort** by biggest drop (default), renewal soonest, lowest tier, lowest margin.
- **Filter** by center, tier, and "renewing within N days".
- A row opens that customer's Value tab. One small payload (a few hundred rows) from the stored scores, margin and
  contracts: no aggregation over live invoices or tickets.

### 2.2 Renewal outlook card (Summary tab)
For a customer with a live contract: end date and days left; where a renewal stands (none started, draft, sent, signed);
the standing escalation clause (the ask) and what they agreed or pushed back on at past renewals; the rent per seat now
against the **break-even rent** from the Costs tab; and the stability of their score. Only facts from our own records,
and "not recorded" where we do not know. A line such as "customers like this renewed X%" appears only once enough past
renewals exist (never on a handful).

### 2.3 Cross-pillar insights
Rule-written sentences from the latest score, the 90-day change, stored margin and the renewal date, each tied to
the metrics behind it (same audit rule as the story). First set of rules:
1. Pays late but little friction: a collections problem, not a service one.
2. High revenue with high friction: valuable customer with service problems; fix before renewal.
3. Costs more to serve than it pays (margin after variable costs below zero).
4. Seats shrinking and renewing within the window: at risk.
5. Has pushed back on escalation before and renews soon: expect the ask.
6. Rent per seat well below the center's and pays on time: room to raise at renewal.
7. Tier dropped in the last 90 days: names the pillar that moved most.
8. Healthy all round and renewing soon: renew early.
Shown on the Summary tab and as tags in the portfolio list.

## 3. Data

Everything already exists: `customer_value_scores` (latest and 90 days earlier), `customer_value_margin`,
`customer_value_monthly`, contracts and renewal links, `escalation` fields. No migration is expected. The portfolio
reads the latest score per customer and the row closest to 90 days earlier.

## 4. PRs

1. **A: pure rules and tests.** Insight rules, renewal outlook shaping, portfolio row building, 90-day change. No I/O.
2. **B: portfolio page and API.** `GET /api/admin/customer-value/portfolio`, page, sidebar entry (admin).
3. **C: Summary cards.** The renewal outlook card and insights on a customer's Summary tab.

## 5. Decisions needed

- **D1: where the portfolio lives.** Recommended: Admin menu as "Customer Value" (admin only, like the tab itself).
  Alternative: under Sales or Finance, which would suggest other roles can see it.
- **D2: what counts as "renewing soon".** Recommended: within 90 days, adjustable on the page.
- **D3: the starting insight rules.** The eight above are a proposal; say which to drop, change or add. Each is a
  threshold-based rule, so it is easy to tune once you see real examples.
- **D4: portfolio scope.** Recommended: customers with at least one live contract (active or renewal in progress) by
  default, with a switch to include past customers.

## 6. Out of scope here

Any message or alert to the customer or the team, automatic actions, forecasting renewal probability beyond the plain
history above, and changing any score.
