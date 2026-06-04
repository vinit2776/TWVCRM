# Tally Integration — Go-Live Runbook

**Purpose:** take the Tally GST-issuance integration from "built + paused" to "live"
in one controlled dress rehearsal, with verification at every step and a one-flip
rollback. Follow top to bottom. Do not skip the pre-flight gates.

**Current state (as of this doc):** all code built across three branches
(`feat/tally-billing-phase1`, `chore/perf-indexes-followup`, `feat/tally-receipt-voucher`),
migrations 00238–00241 applied to prod, `tally_sync_enabled = false` (paused),
company locked to "Sree Design Infrastructure Pvt Ltd". Nothing posts while paused.

**The golden rule:** the master switch `tally_sync_enabled` is the kill switch. OFF =
the CRM behaves byte-for-byte as it did before Tally. Flipping it OFF at any point
during the rehearsal instantly reverts to the old behaviour for every NEW statement.

---

## 0. Pre-flight gates (do NOT flip sync on until all are ✅)

| Gate | How to confirm | Why it blocks |
|------|----------------|---------------|
| Branches merged to `main` + deployed | Vercel shows the deploy live; `/api/tally/pending` responds 401 (auth works) | The live app must contain the Phase 1 + receipt code |
| Bridge **v1.2.0** running on the Tally server | Admin → Tally Sync shows `v1.2.0` in health; or the bridge log prints it | v1.1.x can't process receipt vouchers |
| **Receipt XML sample verified** | A real Tally receipt was exported and diffed against `postReceiptVoucher` (see §5) | The receipt XML is best-estimate until checked against real Tally |
| `tally_ledger_receipt_account` set | `SELECT value FROM app_settings WHERE key='tally_ledger_receipt_account'` returns the bank/cash ledger | The bridge fails receipt jobs loudly without it |
| Customer ledgers exist in Tally | The test customer is a Sundry Debtor in Tally | The bridge fails the sales voucher loudly without it |
| A safe **test customer** exists | A lead/contract whose email + phone are YOUR addresses (or blank) | So the rehearsal doesn't message a real customer |

Settings to add before go-live (not yet set):

```sql
-- The bank/cash ledger in Tally that receives customer payments (Razorpay settlement
-- account, or "Cash"). EXACT ledger name as it appears in Tally.
UPDATE app_settings SET value = '<your bank ledger>' WHERE key = 'tally_ledger_receipt_account';
-- (insert it if the row doesn't exist yet)

-- Optional: the receipt voucher type name if you use a custom one (default "Receipt").
UPDATE app_settings SET value = 'Receipt' WHERE key = 'tally_receipt_voucher_series';

-- Bill-by-bill: leave 'true' (default). Real receipts from this company knock the
-- payment off the invoice via Agst Ref (47/80 sampled). Set 'false' only for plain
-- on-account receipts.
UPDATE app_settings SET value = 'true' WHERE key = 'tally_receipt_bill_by_bill';

-- Bank allocation: the receipt account is treated as a bank by default (all 80
-- sampled receipts carry a bank allocation). For a CASH receipt ledger, set 'false'.
UPDATE app_settings SET value = 'true' WHERE key = 'tally_receipt_account_is_bank';
-- The transaction-type / transfer-mode strings the bank allocation uses. Defaults
-- below; adjust to whatever your bank ledger accepts on import (confirm at rehearsal).
UPDATE app_settings SET value = 'Cheque/DD' WHERE key = 'tally_receipt_transaction_type';
UPDATE app_settings SET value = 'NEFT'            WHERE key = 'tally_receipt_transfer_mode';
```

---

## 1. The control surface

Everything below is driven from **Admin → Tally Sync** and the database. The switch:

- **Pause/Resume** toggles `tally_sync_enabled`. This is the only thing that decides
  whether NEW GST invoices route to Tally. It does NOT retroactively change statements
  already stamped `issuance_channel`.
- **Company lock** (`tally_locked_company`) — the bridge refuses to serve jobs if the
  open Tally company doesn't match. Already set to "Sree Design Infrastructure Pvt Ltd".

`issuance_channel` is stamped **once**, at GST-generation time. A statement created while
sync was OFF stays `'crm'` forever even if you flip sync ON; a statement stamped `'tally'`
stays Tally's even if you later pause. This is deliberate (decide-once) — no statement
ever splits its steps between CRM and Tally.

---

## 2. Dress rehearsal — sales voucher (B2C first)

Use a **B2C** test customer (no GSTIN) so there's no IRN wait. Keep the amount small.

1. **Confirm sync is still OFF.** Create the test statement and finalize it as normal.
   With sync OFF this is the unchanged CRM flow — PI issues from the CRM (proforma_first)
   or the GST-direct path runs in the CRM. Confirm the statement looks right.
2. **Flip sync ON** (Admin → Tally Sync → Resume). From now on, the NEXT GST-generation
   for a statement routes to Tally.
3. **Trigger the GST invoice** for a NEW test statement (pay the PI, or use the
   gst_direct path). Watch:
   - The statement's `issuance_channel` flips to `'tally'`, `lifecycle_stage = 'queued'`.
   - A `tally_sync_jobs` row appears (`job_type='sales_voucher'`, `status='pending'`).
4. **Watch the bridge** pick it up (poll interval ≤120s, or restart the bridge to poll now).
   Bridge log: `Voucher created: SD/A/... | vchid: ... | IRN: pending/none`.
5. **Verify the round trip** (see §4 queries): the statement gets `tally_invoice_number`,
   `lifecycle_stage='sent'`, `tally_delivered_at` set; the customer (your test address)
   receives the PDF + (if unpaid) a Razorpay link.
6. **Check Tally**: the invoice exists in the Day Book under the SDIPL-REG series with the
   real number that the CRM mirrored.

✅ Pass = the CRM invoice number matches Tally's, the PDF was delivered once, and no second
invoice was generated by the CRM.

---

## 3. Dress rehearsal — payment → receipt voucher

Using the same test statement now issued by Tally:

1. **Record a payment** — either pay the Razorpay link (online) or record an offline
   payment (Finance → record payment). This is the normal flow; no special steps.
2. A `tally_sync_jobs` row appears (`job_type='receipt_voucher'`, `status='pending'`),
   keyed `receipt_voucher:<payment_id>`.
3. The bridge posts a **Receipt voucher** in Tally (bank debit + party credit, knocked off
   the invoice via Agst Ref). Bridge log: `Receipt created: RCT/... for <amount>`.
4. **Verify** (see §4): `billing_payments.tally_receipt_number` is set; the receipt exists
   in Tally against the right party + invoice.

✅ Pass = Tally's books show the payment against the correct invoice, and the CRM payment
row shows the receipt number.

---

## 4. Verification queries (read-only)

Run against prod (read replica is fine). Replace `:id` with the test statement id.

```sql
-- Statement issuance + lifecycle
SELECT id, statement_number, issuance_channel, lifecycle_stage,
       tally_invoice_number, total_amount, tally_synced_at, tally_delivered_at,
       payment_status, tally_last_error
FROM billing_statements WHERE id = ':id';

-- The Tally jobs for this statement (sales + receipt)
SELECT job_type, status, idempotency_key, tally_invoice_number,
       tally_voucher_guid, last_error, attempt_count, completed_at
FROM tally_sync_jobs WHERE billing_statement_id = ':id' ORDER BY created_at;

-- Payment → receipt mirror
SELECT id, amount, payment_mode, tally_receipt_number,
       tally_receipt_voucher_guid, tally_receipt_synced_at
FROM billing_payments WHERE billing_statement_id = ':id' ORDER BY created_at;

-- Health: any Tally job stuck or failed in the last day
SELECT job_type, status, last_error, attempt_count, created_at
FROM tally_sync_jobs
WHERE status IN ('failed','posted','claimed') AND created_at > now() - interval '1 day'
ORDER BY created_at DESC;

-- Undelivered issued invoices (what the reconcile cron will re-drive)
SELECT id, statement_number, tally_invoice_number, lifecycle_stage, tally_synced_at
FROM billing_statements
WHERE issuance_channel='tally' AND tally_invoice_number IS NOT NULL
  AND tally_delivered_at IS NULL;
```

**Health signals**
- A job stuck at `status='failed'` with a `last_error` → read the error; it's usually a
  missing ledger (create it in Tally, then Retry from Admin → Tally Sync).
- `lifecycle_stage='awaiting_irn'` on a B2B invoice is normal — it waits for accounts to
  generate the IRN in Tally; the bridge re-acks when the IRN appears.
- `/api/cron/tally-reconcile?dry=1` lists any issued-but-undelivered invoices without sending.

---

## 5. Receipt XML — verified against real Tally ✅ (one tune-item left)

The receipt envelope in `bridge/src/tally-client.ts` → `postReceiptVoucher` was matched
against a real **80-receipt Day Book export** (May 2026). Confirmed correct:
- Parent `VOUCHERTYPENAME = Receipt`, `OBJVIEW = Accounting Voucher View`.
- `<ALLLEDGERENTRIES.LIST>` (not `LEDGERENTRIES.LIST`).
- Bank DEBIT: `ISDEEMEDPOSITIVE=Yes`, negative `AMOUNT`. Party CREDIT: `No`, `ISPARTYLEDGER=Yes`, positive.
- Bill-by-bill `Agst Ref` with `<NAME>` = the invoice number (47/80 used it → default ON).
- Bank allocation on the bank entry (80/80 → default ON; off for cash).
- Receipts are manually numbered (blank `VOUCHERNUMBER`) → identified by GUID.

**Bank transaction type — now defaulted from your real data.** Mining the 80-receipt
export: `TRANSACTIONTYPE = Cheque/DD` (76/80) + `TRANSFERMODE = NEFT` (71/80) are the
dominant values your ICICI ledger accepts, so those are now the defaults. The remaining
import risk is near-zero. Confirm at the §3 rehearsal:

1. Run one real payment → receipt through the bridge (sync ON, test customer).
2. If the bridge logs a `LINEERROR` on the bank/transaction details, set
   `tally_receipt_transaction_type` / `tally_receipt_transfer_mode` to the values your
   ledger expects (Admin → Tally Sync → Receipt sync) and Retry. If your receipt account is
   **cash**, set `account-is-bank = No` to drop the bank allocation entirely.
3. After any change, re-run `cd bridge && npx ts-node src/test-receipt-voucher.ts` (22 pass).

**Heads-up — TDS-deducted receipts (21% of sampled).** 17/80 real receipts split between the
bank ledger (net) and a `TDS Paid (Deducted by the Party)` ledger because the customer
deducted TDS. The current receipt voucher posts the full amount to the bank only. If the CRM
records the **net** amount the customer actually paid, the invoice keeps a TDS-sized balance —
correct-ish but the Tally receipt won't carry the TDS ledger split. Watch for this in the
rehearsal; full TDS-on-receipt handling is a follow-up if you want the split mirrored.

---

## 6. Rollback

The integration is designed so rollback is a single flip — no data migration, no redeploy.

| Situation | Action | Effect |
|-----------|--------|--------|
| Anything looks wrong mid-rehearsal | **Admin → Tally Sync → Pause** (`tally_sync_enabled=false`) | Every NEW statement reverts to the old CRM flow instantly. In-flight Tally statements finish on their stamped channel. |
| A specific job is wedged | Admin → Tally Sync → Retry (or set the job `status='pending'`) | Bridge re-attempts; idempotency prevents double-posting |
| A statement stamped `tally` must go back to CRM | Manual: it already has a Tally invoice number → do NOT CRM-void it (blocked by design). Cancel via the Tally credit-note flow (Phase 1b) once built. | Keeps books in sync |
| Bad deploy | Vercel → Promote previous deployment | Standard app rollback; DB columns are additive and harmless if unused |

**Why pausing is safe:** the migrations only ADD columns (all nullable, default `'crm'`),
so the old code paths never see anything new. The switch-OFF state is the pre-Tally state.

---

## 7. Post go-live monitoring (first week)

- `/api/cron/tally-reconcile` runs every 15 min and re-drives any issued-but-undelivered
  invoice. Watch its output (cron health) for non-zero `failed`.
- Daily: run the "stuck or failed jobs" query in §4. Zero rows = healthy.
- The dunning cron (`/api/cron/payment-reminder`) will NOT chase a Tally invoice until it's
  delivered (`tally_delivered_at` set) — so a stuck delivery can't spam a customer.

---

## Appendix — what each migration added

| Migration | Adds |
|-----------|------|
| 00238 | `billing_statements.issuance_channel / tally_delivered_at / lifecycle_stage` + undelivered index |
| 00239 | The three perf indexes 00237 couldn't apply (one column-corrected) |
| 00240 | Rebuilt the invalid `idx_usage_charges_contract_status_date` |
| 00241 | `billing_payments.tally_receipt_number / _voucher_guid / _synced_at` |
