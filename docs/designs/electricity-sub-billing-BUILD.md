# BUILD KICKOFF: Electricity (EB) Sub-Billing Module

> Hand this file to a fresh Claude Code session to start implementation.
> Suggested opening prompt: *"Read docs/designs/electricity-sub-billing-BUILD.md
> and docs/designs/electricity-sub-billing.md, then start with PR 0a."*

## Status

- Plan is **CEO + ENG CLEARED** (2026-06-11): full CEO review, 2 adversarial
  spec rounds, 2 outside-voice challenges, full eng review with code-verified
  seams. **Zero unresolved decisions.** Do NOT re-litigate decisions — they are
  all recorded in [electricity-sub-billing.md](./electricity-sub-billing.md).
- Source of truth: `docs/designs/electricity-sub-billing.md` (read it fully —
  especially "Decisions Locked", all amendment sections, and the reconciled
  "Implementation Order").
- Test plan artifact (for /qa): `~/.gstack/projects/vinit2776-TWVCRM/vinitchordia-main-eng-review-test-plan-20260611-160000.md`

## What this module does (one paragraph)

At single-tenant locations, the landlord bills TWV for electricity (units split
utility/generator at a location ratio, e.g. 90:10; utility rate varies monthly,
DG rate fixed). TWV re-bills the SAME units to the occupying customer at a
different ratio (e.g. 80:20) with a per-location markup, 18% GST, rupee-rounded
total, as a standalone `electricity` billing statement: PI + Razorpay link →
payment → auto GST invoice → Receivables/AR. The landlord bill also auto-creates
a linked vendor bill in procurement. Maker-checker review gates every dispatch.

## Build order — DO IN THIS SEQUENCE

Each step = one focused PR off main (`git checkout main && git pull && git
checkout -b <branch>`). PRs 0a and 0b are independent — can run in parallel
worktrees. Everything else depends on them.

| PR | Branch suggestion | Scope |
|----|-------------------|-------|
| 0a | `fix/gst-math-rounding` | `src/lib/gst-math.ts`: integer-paise `computeGstAndRounding()` + round-off line. Migrate ALL THREE inconsistent sites: `src/lib/billing.ts:478` (rupee rounding), `src/app/api/billing-statements/[id]/generate-gst-invoice/route.ts:144` (paise rounding), and `src/lib/send-proforma.ts` (independent CGST/SGST calc). Add vitest + `npm test` script + wire into CI workflow (first test tooling in repo — keep scoped). REGRESSION: existing rent statement PI vs GST invoice totals must match to the paisa. |
| 0b | `refactor/vendor-bill-lib` | Extract vendor-bill creation from `src/app/api/procurement/bills/route.ts` POST into `src/lib/vendor-bills.ts`; route becomes thin wrapper, ZERO behavior change. |
| 1 | `feat/eb-schema` | Migration 00252+ (see "Migration checklist" below) + types in `src/types/index.ts` + constants in `src/lib/constants.ts`. |
| 2 | `feat/eb-location-config` | "EB / Electricity Settings" tab on `/locations/[id]` (Tab type currently `"overview" \| "spaces" \| "analytics"` at page.tsx:27) + contract `electricity_settings` section (read-time fallback to location defaults — NO backfill). |
| 3 | `feat/eb-compute` | `src/lib/electricity.ts` pure functions + vitest against the worked example (see plan). |
| 4 | `feat/eb-capture` | EB Bills tab on `/billing`: capture form (multi-meter + `other` charge lines, B2 attachment, reimbursable badge, date-coverage contract resolution) + auto vendor bill via lib (compensate-and-retry, idempotent via unique `vendor_bills.electricity_bill_id`). |
| 5 | `feat/eb-review` | Review dialog (maker-checker, different-user rule server-side, anomaly flag >25%, margin preview, gst_direct warning badge, tax_percentage-differs warning). Copy pattern from `src/components/billing/usage-review-dialog.tsx`. |
| 6 | `feat/eb-dispatch` | Statement generation (line_items section `electricity`, fixed_amount=0) + PI-FIRST DISPATCH GUARD in send-proforma.ts (electricity NEVER takes dispatchGstDirect — guard at the fork, ~line 517) + E3 annexure on BOTH PI and GST PDF generators + electricity SAC section in `resolveHsnCode()` + Tally ledger head. Statements filter on /billing becomes All \| Rent \| Usage \| EB. |
| 7 | `feat/eb-revision` | Extended void for electricity: RECOMPUTE draft from revised landlord bill (existing void copies amounts — wrong for EB), repair `electricity_bills.billing_statement_id` back-link, vendor-bill adjust-or-flag. |
| 8 | `feat/eb-alerts-report` | E1 cron nag (day-of-M+1 semantics) + digest line + dashboard alert; "final EB bill pending" alert in contract cancellation/expiry flow; E4 margin report (single aggregate query, margin = customer pre-GST vs landlord pre-GST). |
| 9 | — | End-to-end manual browser QA per test plan artifact. Receivables/reminders need NO changes (verified: no statement_type filter). |

## Migration checklist (PR 1 — get all of these in)

- `location_electricity_config`: enabled/reimbursement_enabled, landlord_vendor_id,
  landlord splits (must sum 100), landlord_generator_rate, bill_due_day_of_month,
  landlord_gst_applicable (+rate), tds_section/tds_rate, customer defaults
  (splits, markup_type 'per_unit'|'percent', markup_value, customer_generator_rate)
- `electricity_bills`: location_id, contract_id **NULLABLE**, month/year,
  landlord bill no./date, attachment, status, vendor_bill_id, billing_statement_id,
  revised_from_id, snapshot of computed customer values + setting at capture
- `electricity_bill_lines`: line_type `'utility'|'generator'|'other'`
  ('other' = label+amount, no units), meter_label, units, rate, amount
- `contracts.electricity_settings` JSONB (stores overrides only)
- `billing_statements.statement_type` CHECK: drop/recreate to add `'electricity'`
  (NOT additive — call out in PR + rollback SQL)
- **Partial unique index** on billing_statements (contract_id, period_start,
  statement_type) WHERE status != 'voided' — pre-check prod data for violations
  first; REGRESSION: monthly cron must still create rent+usage pairs
- Partial unique on electricity_bills (location_id, month, year) excluding
  revised/superseded rows
- `vendor_bills.electricity_bill_id` nullable FK + UNIQUE (idempotency)
- RLS on every new table (SELECT for authenticated; mutations via API role checks)

## Non-negotiable rules (from the locked decisions)

1. **PI-first always** for electricity, regardless of `contract.billing_mode` —
   enforce at the dispatch fork AND show review-dialog badge (T3 + eng issue 2).
2. **Money math only through `src/lib/gst-math.ts`** — lines paise-precise,
   grand total rounded to rupee with explicit round-off line; payment link =
   rounded total. GST pinned 18% (NOT contract tax_percentage).
3. **Contract resolution by DATE COVERAGE** of the bill month (latest if two),
   independent of contract status — expired/cancelled contracts still billable
   for their final month.
4. **Maker ≠ checker**, enforced server-side. Maker: accounts/office_admin/
   floor_manager/admin. Checker: admin/manager/accounts (different user).
5. **Snapshot at confirm** — invoices never recompute from live config.
6. **Multi-meter utility rate** = markup applied to weighted average
   (Σ utility amounts ÷ Σ utility units).
7. **All mutations call `logAudit()`**; overrides logged with before/after.
8. Reimbursement is a **location setting** (set once), shown read-only at capture.

## Project conventions (CLAUDE.md applies in full)

- Feature branch per PR, conventional commits, never push to main directly.
- `npm run lint` + `npm run build` clean before every commit; build → push →
  `gh run watch` → verify in live browser before declaring done.
- Zod validation server-side on every new API route; role checks in every route.
- Constants triple (`_STATUSES`/`_LABELS`/`_COLORS`) for any new enum.
- `formatCurrency()`/`formatDate()` from src/lib/utils.ts; toasts via sonner.

## Gates before first customer dispatch (after PR 6)

- [ ] Written CA confirmation: customer-side 18% GST on full pass-through + SAC code
- [ ] Written CA confirmation: landlord-side GST treatment + TDS section
- [ ] Worked example verified end-to-end in live browser (6486 units, 90:10 → 80:20)
- [ ] Both REGRESSION tests green (paisa match; cron rent+usage pairs)
