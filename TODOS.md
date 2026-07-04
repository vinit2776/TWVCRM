# TODOS

## Tally integration (feat/tally-connection-test)

### [BLOCKING] Capture production Tally samples (gates Phase 1 bridge coding)
- **What:** From the production Tally server, capture real XML for: (1) a sales voucher
  import, (2) the e-invoice/IRN response, (3) an error response, (4) a credit-note voucher,
  (5) a current-company query (`$$CurrentCompany` / company GUID).
- **Why:** The bridge's posting code, response parser, IRN sync-vs-async handling, void path,
  and company-GUID guard all depend on the exact shape of these responses (design doc D5/D10).
- **Pros:** Unblocks Phase 1; lets us build the ack flow and parser right the first time.
- **Cons:** Needs ~1 hr on the Tally server; may need a throwaway test invoice in a test company.
- **Context:** See `docs/tally-integration-design.md` §2.5 (D5), §13 item 1. The connection
  tester in `scripts/tally-connection-test/` can issue the read-only queries; the write
  samples may need a manual test voucher.
- **Depends on:** Tally gateway confirmed (done — port open). Full XML round-trip (company
  name) to be re-confirmed with the company loaded.

### Open items from design doc §13 (needed before/while building Phase 1)
- Ledger names: income heads, tax ledgers (Output CGST/SGST/IGST), round-off, party naming.
- Voucher series Tally uses for GST sales (demote `TWV-BS-####` to internal ref).
- Confirm HSN/SAC `997212` covers all current billing.
- Confirm B2C (walk-in / no-GSTIN) posts as plain sales voucher without IRN.
- Server specs / access to install Node + Windows service.
- TallyVault: is a company password set? Who unlocks after reboot?

## Internal Tasks (from /office-hours + /plan-eng-review)
- [P2] Build `task_categories` (non-asset category taxonomy) + `task_recurrence_rules`
  (cron-spawned recurring tasks) — deliberately deferred out of v1 to keep the first
  delegation/TAT/KPI slice small. Do this once v1 usage shows what categories and
  cadences people actually delegate, rather than guessing upfront. Depends on: v1
  (one-time delegation + task_type, any-active-user authorization) shipping first.
  Context: design doc `~/.gstack/projects/vinit2776-TWVCRM/vinitchordia-main-design-20260702-211234-internal-tasks.md`.
- [P3] Revisit location-scoped delegation once `user_locations` coverage improves.
  v1 dropped location-scoping (any active user can delegate to any active user)
  because only 2 of 15 active users had a `user_locations` row when checked
  (2026-07-04) — the table is populated for inventory/transfer scoping, not as an
  org chart. `canDelegateTo()` in `src/lib/facility.ts` is written as a single
  named function specifically so this is a one-function change later, not a route
  rewrite. Depends on: `user_locations` being backfilled for non-warehouse roles.

## Tally billing redesign (from /plan-eng-review)
- [BLOCKING B2B QR] Capture one real B2B invoice's IRN data from Tally; confirm the
  signed IRP QR content is fully returned + valid before rendering it on the PDF (D4).
  Until then B2B PDF shows IRN/AckNo as text.
- [TECH DEBT] Unify dispatchTallyInvoice ↔ dispatchGstDirect once CRM issuance is
  retired (D6 — isolated now to protect live billing).
- [PHASE 3] Credit-note (CRN) automation for voiding a Tally-issued invoice; until then
  a documented manual procedure is the correction path (D5/OV6).
- [PHASE 2] New Billing page (UI) — own design + review (D1).
