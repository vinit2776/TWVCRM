# Auto-renewal

Status: **part 1 of 4 (foundation)**. Nothing here changes what a customer sees
or is billed. No job reads these columns yet, and `contracts.auto_renew` is
`false` everywhere until a person switches a contract on.

## What it is

Contracts renew automatically when the signed agreement says so (clause 18,
"Auto-renewal"): if notice of termination is not served before the end of the
term, the agreement renews at the escalation written in clause 19. Today a
person does that by hand for every contract. The plan is for the system to
prepare the next term, tell the customer the new rate, and roll it over on the
day after the end date, with a person only handling exceptions.

## Rules fixed in part 1

**One escalation per agreement, one applied per term.**

| Column | Meaning |
|---|---|
| `contracts.agreement_escalation_percentage` | The escalation in the signed base agreement, carried unchanged down a renewal chain. `NULL` on older rows and on chain roots: read it with `programmedEscalation()`. |
| `contracts.escalation_percentage` | What was **applied to this term**. A negotiation may set it differently for that one term only. |

A negotiated rate never changes the base agreement. The next renewal goes back to
`programmedEscalation(contract)` and applies it to the rent actually charged last
term (no catch-up to the original schedule). Negotiating below the agreement's
figure needs admin approval every cycle (existing approval flow).

`programmedEscalation` reads a missing or zero percentage as 10, because that is
what the agreement PDF prints (`escalation_percentage || 10`).

**Notice schedule** (`computeNoticeSchedule`). From each contract's own end date
and `notice_period_months` (0 to 18, may be fractional; `.5` counts as 15 days):

- customer notice #1: **notice deadline minus 7 days**, where the deadline is the end date minus the notice period. The price locks here.
- internal draft prepared: 7 days before notice #1.
- rate confirmation: 15 days before the end date, skipped when notice #1 is later than that.
- a term ending mid-month is billed as one invoice with two rates, generated at the previous month's end, so notice #1 is pulled to the 27th of that month when it would land after it.

The 7 / 7 / 15 day offsets are `app_settings` (`auto_renew_draft_lead_days`,
`auto_renew_notice_lead_days`, `auto_renew_confirmation_days`).

**Holds** (`evaluateAutoRenewEligibility`). A contract that opted in is held for a
person when it has overdue invoices, an active moratorium or rent waiver, a tiered
rate schedule, an unapproved special clause, a pending escalation approval, a live
exit, or a declined renewal.

**Stopping.** Recording an exit (customer notice) or declining a renewal switches
auto-renewal off and records why (`auto_renew_stop_reason`). A contract that never
had it on is untouched.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `auto_renew_cron_mode` | `dry_run` | `off` / `dry_run` / `live`. Anything unrecognised reads as `dry_run`, never `live`. |
| `auto_renew_draft_lead_days` | `7` | see above |
| `auto_renew_notice_lead_days` | `7` | see above |
| `auto_renew_confirmation_days` | `15` | see above |

## Parts still to come

2. Daily job in dry-run: an internal digest of what it would prepare, send and hold.
3. Contract page card, renewals board, Revise and Stop actions.
4. Customer notices and the live roll (carry over vouchers, access and allocations; deposit top-up request).

## Deploy note for part 1

Migration `00662` adds columns the manual renewal route writes when present. The
route checks the column exists before writing it, so merging before the migration
reaches a database is safe, but apply the migration to staging and production
together, as for any migration.
