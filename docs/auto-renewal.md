# Auto-renewal

Status: **parts 1 to 3 and 4a of 4 (foundation, dry-run job, contract-page card and board, customer
notices)**. Part 4b, the live roll, is still to come, so no contract rolls automatically. `contracts.auto_renew`
is `false` everywhere until a person switches a contract on. The only thing a customer can receive is a
notice a person approved or sent by hand (part 4a); the daily job drafts and sends notices only when
`auto_renew_notice_mode` is `live`, which is not the default.

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

## The daily job (part 2): `/api/cron/auto-renew`, 06:00 IST, dry run only

For every contract with `auto_renew` on and status `active` or `renewal_in_progress`,
`planAutoRenewals()` (pure, `src/lib/auto-renewal-plan.ts`) decides where it is in its
schedule, and the job emails admin and accounts a digest of:

- **Needs a person:** held, with every reason (overdue invoices, moratorium, rent waiver, tiered rate schedule, unapproved special clause, pending escalation approval, live exit, declined renewal).
- **Due now:** what it would do today (prepare the draft, send notice #1, send the rate confirmation, roll).
- **Coming up:** the next dated step for each contract in the next 30 days, with the rent the next term would carry at the agreement's escalation.

It prepares nothing, sends nothing to customers and writes nothing. It sends no email
at all when no contract is opted in. `app_settings.auto_renew_cron_mode` may be `off` or
`dry_run`; `live` is not built, so it reads as `dry_run` and the response says so. A term
that ends mid-month rolls on the 1st of the next month, not the day after.

Overdue uses Accounts' receivables definition: finalized or exported, unpaid or
part-paid, not voided, past its due date (the early-GST override date when set), counting
the balance after payments and TDS.

## The contract page card and board (part 3)

**Card** (`contract-auto-renewal-card.tsx`, on active and renewal-in-progress contracts): shows
where the contract is on its schedule and the next term's rent, with **Turn on / Resume**,
**Revise rate**, **Pause** and **Customer served notice**. It says plainly that the system is
report-only for now. `GET/POST /api/contracts/[id]/auto-renewal`; roles admin, manager, sales rep
(`AUTO_RENEW_MANAGE_ROLES`).

- **Revise rate** stores a negotiated escalation for the next term only in
  `contracts.auto_renew_escalation_override` (migration 00669), with who, when and why. The agreement's
  figure is untouched. A rate below the agreement's needs an admin (`checkRevision`). A rate equal to the
  agreement's clears the revision. The preview and the daily report use it.
- **Pause** stops the roll only: `auto_renew` goes false with the reason "Paused while renegotiating: ...".
  No exit starts. **Resume** switches it back on.
- **Customer served notice** opens the existing Start exit dialog. It is the same exit process; the exit
  route already switches auto-renewal off.

**Board** (`/contracts/auto-renewals`, linked from Contracts, `GET /api/auto-renewals`): every opted-in
contract with its status, next step and next rent, using the same planner as the daily report.

## Customer notices (part 4a)

The system prepares each notice as a **draft**, a person reviews, edits and **approves** it, and it is
**emailed** on its day. Email is the valid delivery method; nothing else is sent. A written rate notice is
enough under clauses 18 and 19.

- **Rate notice** (`kind = notice`): drafted from the draft day, sent on notice #1's day. Locks the price once sent.
- **Rate confirmation** (`kind = confirmation`): drafted once the rate notice has gone out (it restates the locked rate), sent 15 days before the end date. Skipped when the schedule has none.
- **One per term**: `auto_renewal_notices`, unique per contract, kind and term end date while live or sent (migration 00672). A cancelled notice is not recreated by the job.
- **Who gets it**: the customer's email plus their billing emails, as invoices are addressed. Editable per notice.
- **Approval**: admin, manager and sales rep (`AUTO_RENEW_MANAGE_ROLES`). Editing an approved notice sends it back to draft.
- **Late**: a notice not sent by its day shows a red message on the contract. Staff open it, see the draft, change anything and send it now.
- **Held contracts** (overdue invoices, moratorium and so on): the job drafts nothing and sends nothing for them, and the contract page and the internal email say why. An unpaid **deposit top-up never holds** a renewal; the review dialog just highlights the amount for staff.
- **Price lock**: once the rate notice is sent, Revise rate and Clear revised rate are refused (409) and the card says so.

**Switch**: `app_settings.auto_renew_notice_mode` (`off` / `dry_run` default / `live`), separate from the
roll. Only `live` makes the daily job prepare drafts and send approved notices; anything unrecognised reads as
`dry_run`. The job emails admin and accounts what needs a person (late, failed, held back, awaiting approval, sent).
A person can always prepare and send by hand from the contract page, whatever the mode.

**Safety**: off the production database a send may only reach `@example.com`; anything else is refused, not
redirected. A notice is claimed (`sending`) before it goes, so two callers cannot both send it.

Routes: `GET/POST /api/contracts/[id]/auto-renewal/notices`, `PATCH .../notices/[noticeId]` (edit, approve,
unapprove, cancel, send). Logic: `src/lib/auto-renewal-notice.ts` (pure), `auto-renewal-notice-server.ts`.

## Parts still to come

4b. The live roll: create the next term on the day after the end date, carry over vouchers, access and
allocations, the two-line invoice for a mid-month end, and the deposit top-up request.

## Deploy note for part 1

Migration `00662` adds columns the manual renewal route writes when present. The
route checks the column exists before writing it, so merging before the migration
reaches a database is safe, but apply the migration to staging and production
together, as for any migration.
