# Tally Bridge — Operational Reference

**Last updated:** 2026-06-11  
**Current sync state:** PAUSED (`tally_sync_enabled = false`)  
**Latest bridge version:** v1.3.10  
**Bridge agent token:** `TALLY_AGENT_TOKEN = twv-tally-bridge-2026`

For the full design rationale see `tally-integration-design.md`.  
For the step-by-step go-live runbook see `tally-go-live-runbook.md`.  
This document covers: bridge capabilities, correct flows, known issues, and manual correction procedures.

---

## Bridge capability matrix

| Capability | Status | Min bridge version | Notes |
|---|---|---|---|
| Sales voucher (B2C, no IRN) | ✅ Live | v1.1.x | Sends immediately on ack |
| Sales voucher (B2B, with IRN) | ✅ Built | v1.1.x | Waits in `awaiting_irn` until accounts generates IRN in Tally |
| IRN read-back | ✅ Built | v1.1.x | Bridge polls Tally for IRN; second ack triggers delivery |
| Receipt voucher (payment → Tally) | ✅ Verified | v1.3.1 | Verified vs real 80-receipt Tally export |
| Credit note (cancel/void reversal) | ✅ Verified | v1.3.1 | Verified vs real `CN/A/26-27/1` |
| Party master (auto-create ledger) | ⚠️ Partial | — | `auto_create_ledger` flag exists; bridge creates missing Sundry Debtor ledger when ON |

**Receipt voucher flag:** `RECEIPT_VOUCHER_ENABLED` in `src/lib/tally/enqueue.ts` is currently `false` (conservative hold from a stale comment). **Flip to `true` as part of go-live** — bridge v1.3.1+ fully supports it.

---

## Architecture summary

```
CRM (source of truth)
  │
  ├── finalize billing statement
  ├── routeGstGenerationToTally()  ← D2 decide-once stamp
  │     stamps issuance_channel='tally', enqueues sales_voucher job
  │
  ▼
tally_sync_jobs  (outbox queue)
  │
  ▼
Bridge polls  GET /api/tally/pending  (every ~30s)
  ├── claims batch of 5, 2-min lease
  ├── enriches payload with ledger names, party, narration
  └── posts voucher XML to Tally

Tally
  └── creates voucher, returns number + IRN (B2B) or number only (B2C)

Bridge acks  POST /api/tally/ack
  └── CRM mirrors: invoice number, IRN, total_amount
  └── triggers dispatchTallyInvoice → PDF + email + WhatsApp + Razorpay link
```

**CRM never generates GST invoice numbers.** Tally owns the number sequence. The CRM mirrors the number back and uses it on the PDF and Razorpay reference.

---

## Job types and what triggers them

| Job type | Triggered by | Bridge action | Ack effect |
|---|---|---|---|
| `sales_voucher` | `routeGstGenerationToTally()` at GST generation | Posts sales voucher to Tally | Invoice number + IRN mirrored; `dispatchTallyInvoice` fired |
| `receipt_voucher` | Payment recorded on a Tally-issued invoice | Posts receipt voucher to Tally | `billing_payments.tally_receipt_number` mirrored |
| `credit_note` | `enqueueTallyCreditNote()` when voiding a Tally-issued invoice | Posts credit note reversing the original | Statement voided; usage charges freed |
| `party_master` | Reserved (not yet triggered by CRM code) | Creates/updates Sundry Debtor ledger | Not implemented |

---

## Statement lifecycle

### Tally-issued invoice (normal flow)

```
billing_statement.tally_sync_status:
  not_applicable → pending → in_progress → issued → failed

billing_statement.lifecycle_stage:
  (null) → queued → issuing → awaiting_irn (B2B) → issued → sent → cancelled
```

| lifecycle_stage | Meaning |
|---|---|
| `queued` | `sales_voucher` job enqueued, bridge hasn't claimed it yet |
| `issuing` | Job claimed by bridge, being posted to Tally |
| `awaiting_irn` | Voucher created in Tally (B2B), waiting for accounts to generate IRN |
| `issued` | Invoice created + IRN received (B2B) or number returned (B2C) |
| `sent` | Invoice PDF delivered to customer (email + WhatsApp) |
| `cancelled` | Reversed via credit note after Tally confirmed |

### CRM-issued invoice (when `tally_sync_enabled = false`)

```
lifecycle_stage stays null (pre-Tally behaviour)
tally_sync_status = not_applicable
issuance_channel = crm
```

---

## Key design rules (don't break these)

| Rule | Where enforced | What breaks if violated |
|---|---|---|
| **D2 — Decide once** | `routeGstGenerationToTally()` stamps `issuance_channel='tally'` before enqueueing | Mid-run switch flip routes the same statement to both systems → duplicate invoice |
| **D3 — Deliver once** | `tally_delivered_at` written in its own DB call before metadata update | Email sent twice; Razorpay link created twice |
| **D8 — Tally computes tax** | Only `taxable_amount` + `tax_percentage` sent in job payload | Tax discrepancy between CRM and Tally books |
| **OV3 — Mirror Tally's total** | `tally_total_amount` from ack overwrites `total_amount` on statement | Razorpay link amount diverges from Tally invoice |
| **Company guard** | `x-tally-company` header checked vs `tally_locked_company` in pending route | Invoice posted into wrong Tally company's books |
| **CRM void blocked for Tally invoices** | `issuance_channel='tally'` check before void | Tally books show invoice, CRM shows voided — desync |

---

## Key settings (Admin → Tally Sync)

| Setting key | Default | Description |
|---|---|---|
| `tally_sync_enabled` | `false` | Master switch. OFF = byte-for-byte pre-Tally behaviour |
| `crm_gst_enabled` | `true` | CRM generates its own GST invoice. Must be OFF when Tally sync is ON |
| `tally_locked_company` | `Sree Design Infrastructure Pvt Ltd` | Company guard — bridge must have this company open |
| `tally_voucher_series` | `SDIPL-REG` | Sales voucher series for GST-registered (B2B) customers |
| `tally_credit_note_series` | `CREDIT NOTE-REG` | Credit note series |
| `tally_ledger_rent_income` | `Rent The Workvilla 18%` | Income ledger for rent lines |
| `tally_ledger_cgst_output` | `CGST Output 9%` | Tax ledger |
| `tally_ledger_sgst_output` | `SGST Output 9%` | Tax ledger |
| `tally_stock_item` | `Rent-The WorkVilla` | Stock item name in Tally |
| `tally_ledger_receipt_account` | *(must be set before go-live)* | Bank/cash ledger for receipt vouchers |
| `tally_irn_alarm_hours` | `24` | Alert threshold for B2B invoices stuck in `awaiting_irn` |
| `tally_auto_create_party_ledger` | `false` | When ON, bridge creates missing Sundry Debtor ledgers automatically |

---

## B2B vs B2C routing

| Customer type | `leads.gst_number` | Tally series | IRN required | Flow |
|---|---|---|---|---|
| B2B (GST-registered) | Present | `SDIPL-REG` | Yes — accounts generates in Tally | Bridge creates voucher → waits in `awaiting_irn` → IRN triggers delivery |
| B2C (unregistered) | Blank | `SDIPL-UNREG` | No | Bridge creates voucher → delivers immediately |

**Note:** The CRM currently always sends `tally_voucher_series = SDIPL-REG` regardless of GSTIN. The bridge should handle the B2C routing internally using `buyer_gstin` in the payload, or the pending route needs to be updated to check the lead's GSTIN and select the correct series.

---

## Known issues and fixes (as of 2026-06-11)

### 1. Attempt count zombie jobs — FIXED (PR #59)
Jobs that reached 5 poll attempts without a hard-failure ack were silently excluded from the pending queue (`.lt(attempt_count, BATCH_SIZE=5)` filter). Changed to `.lt(attempt_count, 10)` — actual exhaustion is determined ack-side by `max_attempts`.

### 2. Receipt voucher accumulation guard — FIXED (PR #59)
`RECEIPT_VOUCHER_ENABLED = false` in `src/lib/tally/enqueue.ts` prevents receipt jobs from being enqueued. This was added as a conservative hold. **Flip to `true` before going live** — bridge v1.3.1+ fully supports receipt vouchers and the pending route enrichment is complete.

### 3. IRN aging alert — ADDED (PR #59)
The `tally-reconcile` cron now detects statements stuck in `awaiting_irn` beyond `tally_irn_alarm_hours` (default 24h) and surfaces them as `stuck_irn` in the cron response + `console.error` for log monitoring.

---

## Self-healing mechanisms

| Mechanism | Trigger | What it fixes |
|---|---|---|
| Lease expiry | Bridge crash; job stays `claimed` past `lease_expires_at` | Re-surfaces job to `pending` on next poll |
| `tally-reconcile` cron | Every 15 min (Vercel cron) | Re-drives delivery for `tally_invoice_number` set but `tally_delivered_at` null |
| IRN aging alert | Same cron | Flags B2B invoices stuck in `awaiting_irn` > 24h |
| Idempotency keys | On every enqueue | Prevents duplicate jobs for the same statement/payment |
| `admin/tally/redispatch` | Manual admin action | Re-sends PDF + email for an already-issued invoice; clears D3 gate with `force=true` |

---

## Manual correction procedure

### When a Tally invoice was raised directly (bypassing the CRM sync flow)

This happens when a user generates the invoice manually in Tally without using the CRM flow. The CRM stays in `unpaid`/`finalized` and dunning continues.

**Steps:**

1. **Record the payment** in `billing_payments`:
   ```sql
   INSERT INTO billing_payments (billing_statement_id, amount, payment_date, payment_mode, notes)
   VALUES ('<statement_id>', <amount>, '<YYYY-MM-DD>', 'bank_transfer',
           'Payment received. GST invoice generated directly in Tally. CRM corrected manually.');
   ```

2. **Update the statement** to reflect Tally-issued state:
   ```sql
   UPDATE billing_statements SET
     payment_status      = 'paid',
     status              = 'exported',
     issuance_channel    = 'tally',
     tally_sync_status   = 'issued',
     lifecycle_stage     = 'sent',
     tally_delivered_at  = now(),
     exported_at         = now(),
     gst_invoice_number  = '<tally_invoice_number>',   -- e.g. SD/A/26-27/175
     tally_invoice_number = '<tally_invoice_number>'
   WHERE id = '<statement_id>';
   ```

3. **What this achieves:**
   - `payment_status = 'paid'` → clears AR, stops dunning emails
   - `issuance_channel = 'tally'` → CRM will refuse to generate a GST invoice (409 guard)
   - `gst_invoice_number` set → second hard block on GST re-generation
   - `tally_delivered_at` set → D3 gate closed, no Tally dispatch fires
   - `lifecycle_stage = 'sent'` → statement shows as fully processed in the UI

4. **IRN and PDF:** If the Tally invoice has an IRN (B2B), the CRM cannot serve the e-invoice PDF unless the IRN + signed QR code are stored and a PDF generated. Options:
   - Download the PDF directly from Tally for this invoice
   - Or share the IRN + signed QR — the `admin/tally/redispatch` endpoint can regenerate the PDF with the correct B2B QR code if those values are stored in a `tally_sync_jobs` record

**Real example:** TWV-BS-0097 (Neha Bokdia & Associates, TWV-C-0044) — June 2026. Invoice `SD/A/26-27/175` raised directly in Tally by a new user. Corrected at DB level on 2026-06-11. IRN not stored in CRM.

---

## Go-live checklist additions (supplement to `tally-go-live-runbook.md`)

Before flipping `tally_sync_enabled = true`:

- [ ] Flip `RECEIPT_VOUCHER_ENABLED = true` in `src/lib/tally/enqueue.ts` and deploy
- [ ] Set `tally_ledger_receipt_account` in Admin → Tally Sync (likely `ICICI BANK A/C NO.000905000140`)
- [ ] Confirm bridge v1.3.1+ is running (receipt + credit note support)
- [ ] Set `tally_irn_alarm_hours` (default 24 is fine; reduce if accounts checks IRN more frequently)
- [ ] Ensure `crm_gst_enabled` is set to `false` — these two switches must never both be `true`
- [ ] Run `GET /api/cron/tally-reconcile?dry=1` — should return `stuck_irn: []` and `candidates: 0`

---

## Tally invoice series used

| Series | For | Example number |
|---|---|---|
| `SDIPL-REG` | B2B sales invoices (GST-registered customers) | SD/A/26-27/175 |
| `SDIPL-UNREG` | B2C sales invoices (no GSTIN) | — |
| `CREDIT NOTE-REG` | Credit notes reversing B2B invoices | CN/A/26-27/1 |
| `Receipt` | Receipt vouchers (payment reverse-sync) | — |

---

## Troubleshooting quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| Statement stuck in `queued` | Bridge offline or `tally_sync_enabled = false` | Check Admin → Tally Sync bridge health; flip sync on |
| Statement stuck in `awaiting_irn` > 24h | Accounts hasn't generated IRN in Tally | Ask accounts to generate IRN in Tally; bridge will pick it up on next poll |
| Job in `failed` state | Hard data error (missing ledger, wrong GSTIN format) | Check `tally_last_error` on the statement; fix the data; use Retry button in Admin → Tally Sync |
| Customer got invoice email twice | D3 gate not closing cleanly | Check `tally_delivered_at` on statement; use `admin/tally/redispatch` to investigate |
| AR still showing after payment confirmed in Tally | Payment not recorded in CRM | Record payment manually via Finance → Billing → Record Payment (or DB correction if Tally-direct) |
| CRM generates duplicate GST invoice | `issuance_channel` not stamped `tally` | Check `routeGstGenerationToTally()` — was `tally_sync_enabled` on at time of GST generation? |
| Wrong company in bridge | `x-tally-company` header mismatch | Admin → Tally Sync → update locked company to match the open Tally company |
