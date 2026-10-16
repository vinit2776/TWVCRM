# Customer Value tab — product spec

Status: **planning draft, nothing built.** Written 2026-10-16 after a design discussion with Vinit.
Mocks from that discussion were illustrative; every number in them was invented.

## 0. Final scope (agreed 2026-10-16)

**In scope.** An admin-only **Value** tab on the lead page, covering all of a customer's contracts (past, present, upcoming renewal), with:

1. Header: tier A–D, trend arrow, contract and range selectors, recompute.
2. Journey: customer age, first contract, breaks, extensions, renewals, contract timeline, rent per seat, escalation history (asked vs agreed).
3. Four pillar scores (profitability, payment, engagement, friction) and a rules-generated story with a suggested action.
4. Trends: pillar scores, days to pay per invoice, seats paid vs used, tickets by type.
5. Money: lifetime summary, payment history, concessions ledger.
6. Comparison with the rest of the center (cohort averages, ranks, trend vs average).
7. Electricity contribution (seats, presence or hybrid split) with cost recovery.
8. Wi-Fi usage from UniFi: devices, volume, peak, heatmap, quality, usage tags, and a per-user table with names, filters and an **Assign name** action.
9. Cost-to-serve simulator with live and manual cost lines, break-even rate and seats/rent what-if.
10. Evidence list linking every score to its records.
11. Renewal outlook.

**Out of scope.** Message sentiment; any customer-facing output or automated action; browsing content or app-level Wi-Fi data (unless separately approved); roles other than admin; Tally.

**Build order.** Phase 0 coverage check, then 1 Journey and money, 2 snapshots and scores, 3 comparison, 4 electricity, 4b Wi-Fi (start capture early), 5 simulator, 6 renewal outlook and portfolio list. See section 8.

## 1. Purpose

A **Value** tab on the lead detail page (`/leads/[id]`) that continuously evaluates how valuable a
customer is, and tells the story behind the number. It answers:

- How long have they been with us, did they break, how often did they renew, what happened on escalation?
- Do they pay promptly, and how does that compare with other customers at the center?
- Are they using what they pay for, and are they a source of friction?
- What do they actually cost us (rent, electricity, staff time, overheads) against what they pay?
- Where is this heading, and what should we do before the renewal conversation?

The lead is the customer. The tab covers the **whole relationship**: past, present and upcoming
contracts together.

## 2. Access

- **Admin only**, for now. Enforce on the server in every API route (role from the session), not just by hiding the tab.
- The tab trigger is shown only when `/api/me` returns `role = admin`.
- The tab shows cost and margin data, so it must never be exposed to other roles without a new decision.

## 3. Scope and rules for which contracts count

One lead can have many contracts. Contracts link through `parent_contract_id` / `renewal_sequence`;
a renewal continues the same tenure and charts must show one unbroken line with markers where a contract changes.

| Contract state | Treatment |
|---|---|
| `expired`, `renewed`, `terminated` **that actually activated** | Past. Counts toward history and scores. |
| `active`, `renewal_in_progress` | Present. Counts, plus live open items. |
| `draft`/`sent`/`viewed`/`accepted` renewal or new contract not yet active | Future. Not scored. Shown on the forward-looking card. |
| Never-activated contracts stored as `terminated` (withdrawn) | **Excluded** from scoring and history. Distinguish by "did it ever activate" (activation timestamp or the activation gate fields). Verify the exact field before building. |
| `rejected`, plain drafts | Excluded from scoring; may appear on the timeline. |

Overlapping contracts (two active at once) are **summed** for revenue and seats, not averaged.
A contract selector narrows the whole tab to one contract; default is the whole lead.

## 4. Page layout

The Value tab is split into **six sub-tabs**. Each loads its own data only when opened, so opening a lead
never pays for the whole analysis. A persistent slim header (customer name, tier, trend arrow, contract and
range selectors, last computed time, Recompute) sits above the sub-tabs.

| Sub-tab | Contents (section refs) | Reads from | Load |
|---|---|---|---|
| **Summary** (default) | pillar scores, story and suggested action, 12-month score line, renewal outlook, top evidence rows (5.2, part of 5.3) | latest `customer_value_scores` row + last 12 monthly rows | 2 queries, ~15 KB, no chart library |
| **Journey** | age, breaks, extensions, renewals, contract timeline, rent per seat and escalation history (5.1) | contracts, rate phases, parent contract | 3 small queries, ~25 KB, computed on read |
| **Performance** | pillar trends, days to pay per invoice, seats paid vs used, tickets by type, full evidence list (5.3) | monthly snapshot rows for the range, invoice list | 3 queries, ~40 KB, chart library loaded here only |
| **Compare** | comparison with the rest of the center (5.4) | precomputed `center_value_benchmarks` + his monthly rows | 2 queries, ~10 KB |
| **Costs** | lifetime summary, payment history, concessions ledger, cost simulator (5.6), electricity contribution (5.5, loads when expanded) | monthly cost data, `value_cost_parameters`, electricity aggregates on expand | 3 queries + 1 lazy, ~30 KB |
| **Wi-Fi** | usage KPIs, heatmap, daily volume, per-user table with Assign name (5.7) | our usage ledger rollups, never the UniFi console | 3 queries, ~45 KB |

The renewal outlook card on Summary appears once phase 6 is built.

## 5. Sections in detail

### 5.1 Journey

| Item | Source |
|---|---|
| Lead created, source | `leads.created_at`, `leads.source` |
| Time from enquiry to first contract | lead created vs first activated contract `start_date` |
| Customer age / tenure | first activation to now |
| Breaks | gaps between a contract's `end_date` and the next `start_date`; zero gap shown as "no break" |
| Extensions | `contracts.days_extended` (lifetime cap 60) |
| Renewal count | `renewal_sequence`, `is_renewal`, `parent_contract_id`; `renewal_declined*` if any |
| Contract timeline (Gantt) | contracts, with gaps, extensions, a today marker, and pending renewal |
| Rent per seat graph | `contract_rate_phases` plus contract rate over time |
| Escalation history | contract escalation fields (type none/percentage/flat/step_up, value, frequency, next date), `escalation_approval_status`, `escalation_waived*` with reason, approval requests. The **ask** is the parent contract's `escalation_percentage` (the standing clause; the renew route defaults to 10 when empty); the **agreed** figure is the renewal contract's own `escalation_percentage`. (`cases.renewal_escalation_percentage` belongs to Leave & License cases, not customer contracts, and is not used here.) |

**Negotiation is inferred, not stored.** "Asked X%, agreed Y%" comes from comparing the parent contract's
`escalation_percentage` with the renewal contract's. The renew route (`POST /api/contracts/[id]/renew`)
accepts an `escalation_percentage` override "because negotiation may result in a different rate", and it
creates an approval request when a non-admin reduces or waives the escalation, so a lower figure, an
`escalation_waived` flag or an approval record all signal a negotiation. The applied change can be
cross-checked against the rate phases. Where parent or renewal carries no escalation value, or the
renewal was created outside the renew route, show **"ask not recorded"** rather than guessing. There is no
free-text record of the conversation, so add an optional **"agreed with note"** field on renewals (see
phase 1) to capture it going forward.

### 5.2 Pillar scores

Four pillars, each 0–100, higher is healthier. Friction is scored so fewer problems = higher.

| Pillar | Inputs (all trailing, recency-weighted) |
|---|---|
| Profitability | variable-cost margin, fully-loaded margin, concessions as % of revenue |
| Payment | average days late, share paid on time, reminders needed, billing disputes |
| Engagement | seats used vs paid, bookings per seat, expansion/contraction, renewal behaviour, active Wi-Fi days (second presence signal alongside door access) |
| Friction | tickets per seat, overdue tickets, resolution time, repeat issues, feedback rating, billing queries, Wi-Fi connection quality and Wi-Fi tickets |

Scoring approach:

- **Percentile within a cohort** (same center, similar size) instead of fixed thresholds, so "9 days late" is judged against what is normal here.
- **Rolling window** of 6–12 months, recent months weighted more, so one-off events do not swing the score.
- **Minimum data**: under ~3 months of history shows "not enough data" instead of a grade.
- **Confidence flag per pillar**: poor data (e.g. no door device at that center) shows "low confidence", never a low score.
- **Tier** A–D from the weighted overall score; **trend arrow** compares the last 90 days with the 90 before.
- **Proposed defaults (to confirm):** weights Profitability 35 / Payment 25 / Engagement 20 / Friction 20; tiers A ≥ 75, B 60–74, C 40–59, D < 40. Make weights and thresholds admin-editable settings.

The **story** is generated by rules from the data (no AI text): e.g. "Pays about 9 days late, 4 reminders in
90 days, 2 overdue tickets, margin down from 44% to 31%, uses 40% of paid seats, renewal in 70 days."
Every sentence maps to a metric and an evidence row so it can be audited.

### 5.3 Trends and history

Charts over the selected range, all driven by monthly snapshots (section 7):

- Four pillar scores over time with event markers (seat change, waiver, renewal).
- Revenue vs cost (rent share, electricity, facility time) and margin %.
- Payment promptness per invoice (days early/late, coloured by severity).
- Seats paid vs seats used.
- Tickets per month by type (facility, billing query, support), with resolution time, overdue count, repeat issues, last feedback rating.
- Communication: reminders sent, last staff contact, open billing queries. (Inbound customer messages are patchy; see risks.)
- Concessions ledger: approved billing moratoriums (a month skipped), approved booking waivers, processed booking refunds, and credit notes. **Rent waivers are not concessions:** a `contract_rent_waivers` row means a missed month "won't be billed through the CRM", and many were billed elsewhere before June 2026, with nothing in the data to tell them apart. They are listed as "months not billed in the CRM" with an estimated value and are kept out of the concessions total. If a genuine giveaway needs to be told apart from a bookkeeping waiver, add a type to the waiver (open decision).
- Lifecycle timeline of key events.

### 5.4 Comparison with the rest of the center

Default cohort: other customers at the same center (excluding this one), active in the last 12 months,
customers under ~3 months excluded. Switch to similar size or all centers.

Rows: days to pay, on-time %, reminders per quarter, rent per seat, escalation accepted at renewal,
seats used vs paid, tickets per seat per quarter, margin, tenure. Each shows his value, cohort average,
difference and rank. Plus a days-to-pay trend (him vs center average by month) and a histogram of the
cohort with his position. Optional context line ("78% of this center renew; customers with this pattern
renewed 41%") only once enough past renewals exist.

### 5.5 Electricity contribution

**Data:** `location_energy_readings` (OneGrid, 15-minute buckets per meter, ledger independent of OneGrid
retention), meters in `location_electricity_connections` (`onegrid_device_id`), bills in
`electricity_bills` / `electricity_bill_lines`, and seats from the space model.

**Methods (selectable, one default):**

| Method | How |
|---|---|
| Seats | his seats ÷ center seats × center kWh. Simple; charges for unused seats. |
| Presence | his person-hours from door access (`access_logs`) ÷ total person-hours. Needs a door device. |
| **Hybrid (default)** | always-on load (overnight minimum) split by seats; the remainder split by presence. Falls back to seats where no door data. |

- Vacant seats are shown as their own line (the center's cost, not any customer's).
- Cost = attributed kWh × blended tariff derived from the center's actual electricity bills.
- **Cost recovery**: attributed cost vs electricity billed to him via contract electricity config; shows the monthly shortfall.
- The ledger is recent, so history only goes back to when capture began. Show gaps honestly.
- If meters map to floors, allocate floor-wise (more accurate). Verify the meter-to-floor mapping.

### 5.6 Cost simulator

Built up over time. Every cost line has a **source status**: *Live* (from data today), *Part live*
(inputs measured, rate entered by admin), or *Needs input* (admin supplies a figure).

| Group | Line | Basis | Today |
|---|---|---|---|
| Variable | Electricity | hybrid split of OneGrid usage | Live |
| Variable | Facility staff time | logged ticket hours × hourly cost | Part live (hours from `facility_issue_time_logs`, recent only) |
| Variable | Pantry and consumables | per person-day present | Needs input |
| Variable | Concessions | moratoriums, booking waivers and refunds, credit notes, spread over tenure (not rent waivers, see 5.3) | Live |
| Variable | Cost of late payment | days late × cost of capital % | Part live |
| Variable | Acquisition cost | one-off commission ÷ tenure months | Needs input |
| Fixed | Rent share | center lease ÷ seats × his seats | Live (`property_leases`, per center) |
| Fixed | Housekeeping, maintenance/AMC, front desk/admin | ₹ per seat | Needs input |
| Fixed | Internet | center bandwidth bill split by seats, **or by his share of measured traffic** once the Wi-Fi ledger (5.7) exists | Needs input (bill); traffic share live after phase 4b |
| Fixed | Head-office overhead | % of revenue | Needs input |

Outputs: revenue, total cost, net margin, **margin after variable costs**, break-even rate per seat, a
"where each rupee goes" bar, and a **confidence line** (% of cost resting on live data).
**What-if sliders** for seats and rent per seat; rent, per-seat costs and electricity scale with seats,
ticket hours and acquisition cost stay fixed. Use case: testing a renewal offer.

**Parameters** are stored with a scope: global default, per center, optional per-customer override, with
an effective-from date so history is not rewritten when a rate changes. Changes are audit-logged.

**Which margin feeds the Profitability pillar:** the variable-cost margin (stable, hard to argue with).
The fully-loaded margin is shown separately, labelled as an estimate, because the fixed share depends on
allocation rules.

### 5.7 Wi-Fi usage

Shows what kind of user the customer is, how heavy their load is, and what their connection is like.
Admin-only, like the rest of the tab.

**How devices map to a customer (already built):** UniFi guest sessions are resolved back to a contract
by `src/app/api/unifi/voucher-devices/route.ts` in three tiers: **confirmed** (contract seat vouchers with
note `{contract_number}_seat{N}`, booking vouchers, ad-hoc vouchers linked in `unifi_adhoc_voucher_links`,
and manual MAC labels in `unifi_device_labels`), **suggested** (fuzzy name or cabin match) and
**unmatched**. Only **confirmed** matches feed scores and cost. Suggested matches may be shown, clearly
marked. The tab shows a **match coverage** figure ("29 of 31 devices matched").

**What UniFi gives us** (via the existing client in `src/lib/unifi.ts`, console proxy):

| Signal | UniFi endpoint | Used for |
|---|---|---|
| Per-session bytes (rx/tx), start, end, duration, hostname, MAC | `/stat/guest`, `/stat/session?mac=` | data volume, active days and hours, session counts |
| Live client: signal/RSSI, AP, SSID, uptime, tx/rx bytes | `/stat/sta` | connection quality, access point used |
| Known devices, first/last seen | `/stat/alluser` | device count, device type from hostname |
| Site totals (WLAN bytes, WAN tx/rx, client count) | `/stat/report/hourly.site`, `daily.site`, `/stat/health` | the center's total, for share-of-traffic |
| AP satisfaction, uptime | `/stat/device` | quality context |

**Metrics shown:**

- **Devices seen vs seats** (flags more devices than seats, which suggests shared vouchers), device mix (laptop, phone, other) inferred from hostname.
- **Data volume** per day and month, trend, spikes; **download vs upload** split (high upload suggests video calls).
- **Peak demand**: 95th percentile throughput, from sessions bucketed per hour (per-minute is not available historically).
- **Share of center traffic** compared with his share of seats.
- **Usage by weekday and hour** (heatmap), share of after-hours use.
- **Usage profile tags**, rule-based: daytime user, night user, video-call heavy, heavy downloader, light user.
- **Connection quality**: signal bands, disconnects per device per day (against the center), most-used access point, weak-signal clustering by AP, linked Wi-Fi tickets.
- **Active Wi-Fi days vs door-access days**: agreement between the two presence sources.
- **Comparison with the center**: GB per seat, Mbps per seat, quality score, as percentile in the same cohort (see 5.4).

**Per-user breakdown.** A table with one row per **seat voucher** (the unit UniFi actually identifies),
so the admin can see each person's usage for this customer.

- Columns: seat and user, devices, data used (and share of the customer), active days of working days, average hours per day, peak Mbps, profile tag. Expanding a row shows that user's devices, a 30-day volume chart, last seen, upload share and signal quality.
- Filters: All, Heavy, Light, Idle seats, Weak signal; text search by name or seat; sort by data, active days, seat number or upload share.
- Row checkboxes build a selection, with a live summary (devices, GB, share of the customer, average active days).
- A footer line shows unmatched devices that cannot be attributed to any seat.
- Profile tags are rule-based with admin-editable thresholds: Heavy (high volume), Light (few active days), Idle seat (almost no activity on a paid seat), Regular. "Idle seat" is also an Engagement signal: a paid seat nobody uses.
- **Names are shown** (decided). The voucher note gives the contract and seat number (`{contract_number}_seat{N}`; `voucher_issuances.seat_number`). The name comes from, in order: `voucher_issuances.contract_member_id` -> `contract_members.name` (this column already exists, nullable, added in migration 00193), then the seat occupant (`space_seat_occupants.occupant_name`, matched on seat label/email), then the device hostname if it clearly carries a name. Where no name resolves, the row shows "Seat N" with an "Unassigned" label and an **Assign name** action.
- **Limits:** a voucher shared by several people looks like one heavy user; one person with several vouchers looks like several. The device count per seat is the tell.

**Assign name action (in the first version).** Available on any row, most useful on "Unassigned" ones, and
to correct a wrong name.

- Opens a small dialog with two options: **pick an existing person** from this contract's members (`contract_members`, active ones; people already holding another seat are marked), or **add a new person** (name and phone required, email optional; phone is `NOT NULL` on `contract_members`).
- On save it sets `voucher_issuances.contract_member_id` for that seat's active voucher. Adding a new person creates the `contract_members` row by reusing the logic behind the existing `/api/contracts/[id]/members` route, not a second copy of it.
- **Must have no side effects.** `contract_members` is the shared list for Wi-Fi vouchers **and** door-access enrolment, so before building, read the members route and the COSEC routes that read it and confirm that creating or linking a member does not enrol anyone on a door device, generate or send an access PIN, email or SMS a voucher, or message the person in any way. If any of that is triggered by creation, split a "name only" path that does not.
- Server rules: admin only; Zod-validated body; the seat must belong to this contract and have an active voucher; a member can be linked to a seat of this contract only; change is wrapped so the member insert and the voucher link succeed or fail together; `logAudit()` records member and voucher **ids only**, never the name, phone or email.
- Reassigning a seat overwrites the single `contract_member_id`, so history would be lost. To keep past usage under the right person, the ledger stores the resolved `contract_member_id` on each row at capture time (alongside seat number), and the per-user view groups by that. Reassignment then affects future hours only. Offer an explicit "also apply to past usage" choice only if wanted; default off.
- Assigning a name is a record correction. It never changes the voucher itself, its validity, or the UniFi console.

**Sensitivity — this is per-individual monitoring of the customer's staff.** Stricter rules than the
customer-level view:

- Admin only, and no export or sharing of the per-user table.
- Volumes, times, signal and device type only; never URLs, domains, apps or message content.
- Names are shown alongside the seat number (decided 2026-10-16). Names are personal data of the customer's staff: show them only in this admin-only view, keep them out of logs, exports and audit payloads, and keep the table out of any shared page or screenshot meant for others.
- Per-user rows must **not** feed any automated score or action. They inform the admin's reading of the customer, and the customer-level metrics (devices vs seats, idle seats, peak) are what the scores use.
- Check that the guest portal notice and customer contract terms allow this use before building it.

**How it feeds the rest of the tab:** Engagement (second presence signal, used where a center has no door device), Friction (quality and Wi-Fi tickets), and the cost simulator's internet line (traffic share instead of a flat per-seat figure).

**Privacy rule:** store **volumes, times, signal and device type only**. Never store or display URLs, domains
or per-site activity. If DPI categories (video calls, streaming, cloud storage) are enabled on a console,
store category-level totals only, and only after Vinit approves that. Confirm the Wi-Fi terms or privacy
notice shown at the guest portal covers this kind of aggregate use before building phase 4b.

**Retention is the main constraint.** Today the CRM reads UniFi **live** (guest sessions with a 7-day look-back,
live client list, short caches) and persists nothing, and UniFi's own history is limited and has been seen
to churn (the same problem the energy ledger solved for OneGrid). So a **ledger is required**: an hourly job
that appends new sessions and per-hour aggregates per customer into our own tables, the same pattern as
`location_energy_readings`. History starts when capture starts; it cannot be backfilled beyond what UniFi
still holds at the moment the first capture runs. Verify the available look-back on a real console first.

## 6. Data readiness

Verified from migrations and types on 2026-10-16. **Production row counts were not checked.**

| Area | Status | Notes |
|---|---|---|
| Revenue, invoices | Ready | `billing_statements` (`contract_id`, `lead_id`), usage charges, bookings (`contract_id`) |
| Payment timing | Ready, history uncertain | `due_date` on statements was added later; older rows may lack it. `billing_payments.payment_date`, `reminder_count`, `receivable_reminder_sends` |
| Seats paid over time | Ready | `contract_space_allocations` (start/end dates), rate phases |
| Concessions | Ready, recent | moratoriums, booking waiver and refund requests (via the lead's bookings), credit notes. `contract_rent_waivers` is listed but not counted: it mixes bookkeeping and giveaways. |
| Billing queries, feedback | Ready | `billing_queries`, `booking_feedbacks`, Feedback tab |
| Lifecycle | Ready | leads, activities, proposals, contracts, `audit_trail` |
| Seats used | Partial | **Use `access_logs`** (timestamped IN/OUT resolved to a contract). `cosec_presence` is current state only. Only where door devices exist, from install date. |
| Tickets per customer | Partial | `facility_issues` has location/space unit but no direct customer or contract column; link through space allocation by date. Unlinked tickets cannot be attributed. |
| Ticket hours | Partial | `facility_issue_time_logs` is recent and only useful if staff log time |
| Electricity | Partial | per-location readings; per-customer is an allocation |
| Rent per seat | Partial | lease rent is per center; needs total seats per center |
| Wi-Fi: device to customer mapping | Ready for confirmed matches | Voucher notes, `voucher_issuances`, `unifi_adhoc_voucher_links`, `unifi_device_labels`; suggested/unmatched are heuristic |
| Wi-Fi: usage history | **Missing** | Read live from UniFi today, nothing persisted; needs a ledger (5.7). Look-back on real consoles unverified. |
| Wi-Fi: per-client quality, load | Partial | bytes, signal, AP, duration exist in API responses; DPI/app categories not used in code and unverified; only for locations configured for UniFi (`isUnifiLocation`) |
| Communication | Partial | outbound logged (`communications_log`, `whatsapp_messages`); inbound is patchy; Gmail intake has never run |
| Escalation ask vs agreed | Ready for renewals made through the renew route | parent clause vs renewal `escalation_percentage`, waiver flags, approvals. No free-text negotiation note, hence the new field. |
| Message sentiment | Missing | out of scope |
| Cross-pillar insights | Missing | computed later from snapshots |

**Phase 0 deliverable:** one read-only coverage query (run by Vinit on production) reporting, per center:
statements with a due date, contracts with door-access history and from when, tickets linkable to a
customer, tickets with time logs, renewals with comparable escalation values. This decides which charts can be full on
day one and which start empty. The query is `docs/customer-value-phase0-coverage.sql` (read-only, counts and dates only); it was
syntax-checked against staging, which proves it runs but says nothing about production coverage.

## 7. Architecture

### Compute and storage

Compute nightly into snapshot tables instead of on every page load. This gives "continuous" evaluation,
trend history, and cheap cohort comparison.

- **`customer_value_monthly`**: one row per lead per month: revenue, each cost line (jsonb), days-late stats, invoices on time/total, reminders, seats paid, seats used (average), kWh attributed (per method), ticket counts by type, resolution stats, concessions, flags for data confidence.
- **`customer_value_scores`**: one row per lead per as-of date: four pillar scores, overall, tier, confidence per pillar, trend vs 90 days, narrative (jsonb of sentence + evidence references), and the weights/thresholds version used.
- **`value_cost_parameters`**: scope (global / location / lead), key, value, effective_from, set_by.
- **`unifi_usage_hourly`** (ledger, append-only): location, contract (resolved at capture time and kept), **seat number and resolved `contract_member_id` (voucher grain, for the per-user view)**, hour, bytes rx/tx, session count, distinct devices, mean/min signal, disconnects, AP mac. Unique on (location, contract, seat, hour). Rows with no resolvable seat keep a null seat so unmatched traffic is still counted. Raw MAC addresses are not stored here; use a one-way hash for distinct-device counts.
- **`unifi_site_usage_hourly`**: location, hour, total WLAN bytes, WAN rx/tx, client count (denominator for share of traffic).
- Monthly Wi-Fi aggregates are written into `customer_value_monthly` (devices, GB, p95 Mbps, quality score, active days).
- **Backfill** from existing records so the tab shows history on day one, within the data limits above.

All new tables: RLS enabled, `SELECT` for admin only; writes by service role from the cron/recompute path.
Migration numbers must be checked against every branch (`node .github/scripts/check-migration-numbers.mjs`).

### Jobs and routes

- Cron `/api/cron/customer-value` nightly, protected by `CRON_SECRET`, added to `vercel.json` and the CLAUDE.md cron table.
- Cron `/api/cron/unifi-usage-capture` hourly (like `energy-ledger-capture`): for each UniFi-enabled location, resumes from the last stored hour, pulls sessions and site stats, resolves confirmed matches, appends rows. Read-only against UniFi: it must never issue, revoke or send a command to a console, voucher or client. Rate-limit and time out calls; skip a location on failure and record it in `cron_health`.
- `GET /api/leads/[id]/value/{summary,journey,performance,compare,costs,wifi}` (plus `costs/electricity` and `wifi/seats/[seat]/devices`): admin only, one per sub-tab, loaded lazily (see Performance and loading). Zod-validated query (range, contract id, cohort).
- `POST /api/leads/[id]/value/recompute`: admin only; recomputes one lead. Read-and-write to snapshot tables only.
- `PUT /api/leads/[id]/value/wifi-seats/[seat]/assignment`: admin only; body `{ member_id }` or `{ new_member: { name, phone, email? } }`; see the Assign name action in 5.7.
- `PUT /api/admin/value-parameters`: admin only; Zod-validated; calls `logAudit()`.
- Use `createAdminClient()` server-side; never the service role key in client code.

### Safety

This feature **only reads CRM data and writes snapshot tables.** It must never send an email, SMS,
WhatsApp, invoice or payment link, and must not call any dispatching endpoint (see the 2026-09-01 incident
in CLAUDE.md). Recompute and the cron are therefore safe to exercise on staging.

### Performance and loading

The tab must stay light for the lead page and for the database. Rules:

- **One lazy entry point.** The Value tab is a single component loaded with `next/dynamic` only when an admin opens it; non-admins never download it. The lead page already unmounts inactive tabs.
- **One endpoint per sub-tab**, not one big endpoint: `GET /api/leads/[id]/value/summary`, `/journey`, `/performance`, `/compare`, `/costs`, `/costs/electricity`, `/wifi`, `/wifi/seats/[seat]/devices`. Each fetches only when first opened.
- **Client memory cache.** Keep each sub-tab's data in state for the visit so revisits do not refetch; keep the selected range and contract in the tab so switching range re-slices the fetched series instead of calling again. Match the existing pattern (plain `fetch` in effects; the codebase has no SWR or React Query).
- **Prefetch on intent.** Start the next sub-tab's request after a short hover or focus on its trigger.
- **Read snapshots, do not aggregate live.** Scores, monthly metrics, cohort benchmarks and Wi-Fi rollups are precomputed. A request is a few indexed reads, never a scan of invoices, tickets or ledger rows.
- **Precompute the expensive shapes.** Heatmap (7x24 per customer per month) and percentile ranks are stored in the monthly/benchmark rows. `center_value_benchmarks` holds cohort averages and distributions per center and month.
- **No live external calls on page load.** Nothing calls UniFi, OneGrid or Razorpay when the tab opens; the Wi-Fi and electricity views read our own ledgers. Only the capture crons talk to those APIs.
- **Charts.** Use plain SVG/HTML for the simple ones (sparkline, timeline, heatmap, bars). Load `recharts` as a separate chunk, only in Performance, via `next/dynamic` with a skeleton.
- **Lazy within a sub-tab.** The electricity panel loads when expanded. Per-user device lists load when a row is expanded. Long lists (evidence) page in chunks of 20.
- **Per-user table runs client-side.** Load all seats for the customer once (tens of rows), then search, sort and filter in the browser.
- **Simulator in the browser.** It receives one small base-figures payload and recalculates locally; only saved parameter changes call the server.
- **Cap ledger growth.** Hourly Wi-Fi rows are about seats x 24 x 30 per customer per month. Keep hourly rows for 90 days, roll up to daily for older data, and index on (contract, hour) and (location, hour). Same retention idea for energy readings if we read from them directly; prefer the center's already-aggregated monthly figure.
- **Response caching.** Data changes nightly (hourly for Wi-Fi), so send `Cache-Control: private, max-age=300, stale-while-revalidate=600`. Recompute invalidates the lead's cache.
- **Skeletons, not spinners,** shaped like the final blocks, so layout does not jump.
- **Budgets to verify in staging:** Summary visible in under 1 s on a warm connection; every other sub-tab under about 1 s; Summary payload under about 20 KB and any other sub-tab under about 100 KB; at most 4 queries per request; no request exceeds 1 s of database time. Add simple server timing logs (no personal data) to confirm.

### UI

- Add a `value` `TabsTrigger` in `src/app/(dashboard)/leads/[id]/page.tsx`, admin only, rendering a dynamically imported `LeadValueTab` that owns the six sub-tabs.
- Section components under `src/components/leads/value/` (kebab-case files, `PascalCase` components), memo'd, state in one controller.
- Server Component fetch where possible; charts as small client components.
- Use `formatCurrency()` / `formatDate()` and add constants for tier labels/colours to `src/lib/constants.ts`.
- Pure scoring/allocation functions in `src/lib/customer-value/` with Vitest unit tests (percentile ranking, recency weighting, break detection, hybrid electricity split, break-even).

## 8. Phasing

Each phase is its own PR(s), kept under ~400 lines of diff where possible.

| Phase | Content |
|---|---|
| 0 | Prod coverage query; confirm decisions in section 10; verify withdrawn-contract and ask-recorded fields |
| 1 | Admin-only tab shell; Journey (age, breaks, renewals, extensions, timeline, escalation history); lifetime summary; payment history; concessions ledger — computed on read, no snapshots. Also add the optional **"agreed with note"** field on renewals (collects data from now on). |
| 2 | Snapshot tables, nightly cron, backfill; pillar scores, tier, trend arrow, story; trend charts |
| 3 | Comparison with the center (cohort stats, trend vs average, distribution) |
| 4 | Electricity contribution (seats first, then presence and hybrid) and cost recovery |
| 4b | Wi-Fi usage: verify console look-back, ledger tables and hourly capture cron, then the Wi-Fi section (devices, volume, peak, heatmap, quality) and its inputs to Engagement and Friction. Start capture early, since history cannot be backfilled; consider shipping the capture alone, ahead of the UI. |
| 5 | Cost simulator: parameters admin screen, results feeding Profitability |
| 6 | Portfolio list (sort by biggest drop, filter renewing soon), forward renewal card, cross-pillar insights |

## 9. Testing and verification

- Unit tests for all pure functions (Vitest).
- Verify against **staging** with the amber STAGING banner visible. Add fixtures to the staging seed (a good customer, a deteriorating one, a new one, one with a break, one with a negotiated escalation) so every state renders.
- Click through the real UI. Do not hand-call API routes to check behaviour.
- Staging migrations first; production migrations applied after merge. Re-verify on production after merge.
- Spot-check scores against Vinit's own view of best and worst customers before trusting tiers.

## 10. Open decisions

1. Final pillar weights and tier thresholds (proposed defaults in 5.2).
2. Unit of evaluation: lead-level headline with per-contract filter (assumed here). Confirm.
3. Hybrid as default electricity method, seats as fallback. Confirm.
4. Cost parameter scope: per-center defaults with optional per-customer override. Confirm.
5. Should head-office overhead count in the fully-loaded margin, or stay out until trusted?
6. Backfill depth: as far back as data allows (assumed).
7. Is the forward renewal card part of the first release or phase 6 (assumed phase 6)?
8. Should sales reps ever see anything (assumed no).
9. Wi-Fi privacy: volumes, times and quality only (assumed). Is DPI category data ever wanted, and does the guest portal notice cover this use?
10. Start the Wi-Fi capture job ahead of the rest of the feature so history accumulates (recommended).
11. Per-user Wi-Fi view: names shown and the Assign name action included in the first version (decided). Remaining: confirm that creating or linking a `contract_members` row has no door-access or messaging side effects, and the default for applying a reassignment to past usage (proposed: off).

## 11. Risks and limits

- **Cost allocation is the weakest area.** Rent, electricity and staff time are allocations; label the money charts as estimates and show the confidence line.
- **Silent data gaps** (missing `due_date`, no door device, unlinked tickets, recent time logs) can distort scores. Mitigate with per-pillar confidence and "not enough data" states.
- **Scores can be gamed or misread.** Every score links to its evidence rows.
- **Cohort size.** Small centers give noisy percentiles; show cohort size and fall back to all centers below a minimum.
- **Inbound communication and sentiment** are not reliable today; counts and recency only.
- **Wi-Fi attribution is partial.** Only voucher-matched guest sessions are attributable; customers on their own ISP or a private SSID, or devices behind a shared router, are invisible or lumped together. Show match coverage, mark low-coverage customers as low confidence, and never treat "no Wi-Fi seen" as "not present".
- **Wi-Fi history starts at first capture.** UniFi retention is limited, so Wi-Fi trends will be short at first.
- **Seat model changes** (reassigned seats, hot desks, day passes) can skew seats-used and electricity shares; verify against real contracts in phase 0.

## 12. Out of scope

Message sentiment analysis; any customer-facing output; any automated action on a customer (messages,
price changes, flags that trigger workflows); exposure to roles other than admin; Tally.
