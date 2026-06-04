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

## Tally billing redesign (from /plan-eng-review)
- [BLOCKING B2B QR] Capture one real B2B invoice's IRN data from Tally; confirm the
  signed IRP QR content is fully returned + valid before rendering it on the PDF (D4).
  Until then B2B PDF shows IRN/AckNo as text.
- [TECH DEBT] Unify dispatchTallyInvoice ↔ dispatchGstDirect once CRM issuance is
  retired (D6 — isolated now to protect live billing).
- [PHASE 3] Credit-note (CRN) automation for voiding a Tally-issued invoice; until then
  a documented manual procedure is the correction path (D5/OV6).
- [PHASE 2] New Billing page (UI) — own design + review (D1).
