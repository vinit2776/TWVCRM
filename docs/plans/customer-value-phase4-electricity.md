# Customer Value tab — Phase 4 plan (electricity share and cost recovery)

Status: **plan only, 2026-10-19. Nothing built. Waiting on decisions D1 to D4 and the coverage query.**
Spec: `docs/customer-value-tab-spec.md` section 5.5. Builds on phase 2 (monthly rows) and phase 3 (Compare).

## 1. Goal

For one customer, show how much of the center's electricity they account for, what that costs, and
whether what they pay for electricity covers it. It feeds the cost simulator (phase 5) as its
"Electricity" line. Admin only, like the rest of the tab.

## 2. What exists today

| Need | Source | State |
|---|---|---|
| Center usage, kWh | `location_energy_readings` (OneGrid 15-minute ledger, hourly capture cron) | Only goes back to when capture began; gaps are real |
| Which meter | `location_electricity_connections.onegrid_device_id` | Optional per connection; **one meter at a time** (summing a main and a sub meter double counts, as the energy pages already note) |
| Daily and monthly totals | `energy-monthly.ts` / `energy-baseline.ts` (midnight cumulative readings) | Reusable as is |
| Center seats | `space_units.capacity` (active units); `locations.capacity_config` | Capacity exists; need to confirm it is filled in per center |
| His seats | `customer_value_monthly.seats_paid` (seat-days weighted) | Stored since phase 2 |
| Everyone else's seats | the same table, for the center's customers | Stored; powers the vacant-seat line |
| Cost | `electricity_bills` and `electricity_bill_lines` (landlord bills: units × rate per line) | Only where bills are captured; tariff = bill total ÷ billed units |
| What he pays for electricity | `billing_statements` with `statement_type = 'electricity'` for his contract | Only where reimbursement is on |

## 3. Method (seats first, as the spec says)

For a month at a center: `his kWh = center kWh x (his seats / center seats)`.

- **Center seats** = active space-unit capacity. Seats nobody has contracted are shown as their own
  **Vacant** line: that is the center's cost, not any customer's.
- **Cost** = his kWh x the center's blended tariff for that month (bill total ÷ billed units). A month
  with no captured bill shows kWh only, never an invented rupee figure.
- **Cost recovery** = attributed cost minus electricity billed to him that month; a shortfall shows in red.
- A month where the ledger has gaps, or the meter was not mapped, is shown as a gap, not zero.
- No new table: the center's monthly kWh is a few hundred small reads from the ledger, and seats come from
  the stored monthly rows. A snapshot table is only added if the page proves slow.

**What seats alone cannot tell you.** Under a seats split every customer at a center uses the same kWh per
seat, so it measures what they cost, not how they behave. Telling a heavy user from a light one needs the
**presence** method (door access) and then the **hybrid** default from the spec (always-on load by seats,
the rest by presence). That is a second PR once door data coverage is known.

## 4. PRs

1. **PR A: pure maths + tests.** Monthly share, vacant line, tariff, cost, recovery, gap handling. No I/O.
2. **PR B: route + Electricity sub-tab.** `GET /api/leads/[id]/value/electricity`, admin only, lazy loaded:
   monthly chart (his kWh vs the rest vs vacant), cost and recovery table, honest data-coverage notes.
3. **PR C (later):** presence and hybrid methods, once door coverage is checked.

## 5. Decisions needed

- **D1: which meter is the center's total?** If a center has one connection with a mapped meter, use it.
  If it has several (main + sub-meters), I need to know which one measures the whole center, or whether
  to add an explicit "counts toward the center total" flag per connection (a small migration).
- **D2: seat denominator.** Recommended: active space-unit capacity, with a Vacant line. Alternative:
  only contracted seats (simpler, but hides the cost of empty seats and overstates everyone's share).
- **D3: cost basis.** Recommended: landlord bill tariff where a bill is captured, kWh only otherwise.
  Alternative: a flat ₹/kWh you enter per center (works everywhere, but is a guess you maintain).
- **D4: coverage first.** Run `docs/customer-value-phase4-electricity-coverage.sql` on production. It decides
  which centers can show anything at all (meter mapped, how long the ledger is, seat counts filled in, bills captured).

## 6. Out of scope here

Wi-Fi traffic share (phase 4b), the cost simulator's other lines (phase 5), floor-wise allocation (needs a
verified meter-to-floor mapping), and any change to how customers are billed for electricity.
