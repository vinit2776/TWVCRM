# Tally Bridge — Operational Reference

**Last updated:** 2026-06-14
**Current sync state:** LIVE (`tally_sync_enabled = true`) + Handoff v2 LIVE (`tally_handoff_v2_enabled = true`)
**Latest bridge version:** v1.4.0 (additive read-only sync-pull poster — see v1.4.0 changelog below)
**Bridge agent token:** `TALLY_AGENT_TOKEN = twv-tally-bridge-2026`

> **Bridge update policy:** the bridge has remote self-update capability via
> Admin → Tally Sync → Update Bridge. Publish a new zip; the bridge picks it up on
> the next heartbeat (~60s) and self-updates between poll cycles. The old "batch
> every fix into one on-site release" policy now applies only to changes risky
> enough to break the heartbeat (and thus lock out the remote-update mechanism).
> Additive read-only changes like v1.4.0 ship safely via remote update.

> **Companion docs:** the Handoff v2 redesign that replaces the writer-first GST
> issuance flow with a human-mediated `/accounting/inbox` workflow lives in
> [`tally-handoff-redesign.md`](./tally-handoff-redesign.md). The bridge v1.4.0
> read-only sync-pull is the bridge-side half of that redesign. The writer-side
> bridge code (sales_voucher / receipt_voucher / credit_note / party_master) is
> still live and byte-identical to v1.3.12; v1.4.0 only ADDS the snapshot poller.

This document covers: bridge capabilities, correct flows, known issues, and manual correction procedures.

---

## Document map

| File | Last updated | Purpose |
|---|---|---|
| **`tally.md`** ← you are here | **2026-06-14** | Operational reference — current state, known issues, manual corrections |
| `tally-handoff-redesign.md` | 2026-06-12 | **Handoff v2 design** — human-mediated `/accounting/inbox` flow, read-only bridge sync, v2 state model. The current direction of travel. |
| `tally-integration-status.md` | 2026-06-04 | Build status hand-off — what's built, what's verified, what PRs exist |
| `tally-go-live-runbook.md` | 2026-06-04 | Step-by-step go-live runbook — follow this when flipping the switch |
| `tally-billing-redesign.md` | 2026-06-03 | **SUPERSEDED** by `tally-handoff-redesign.md` (kept for history only) |
| `tally-integration-design.md` | 2026-06-02 | Original integration design and architecture rationale |

**Reading order:** start with `tally-integration-design.md` for original rationale, then `tally-handoff-redesign.md` for the current v2 direction, then this file for day-to-day operations. `tally-billing-redesign.md` is historical only.

---

## Bridge capability matrix

| Capability | Status | Min bridge version | Notes |
|---|---|---|---|
| Sales voucher (B2C, no IRN) | ✅ Live | v1.1.x | Sends immediately on ack |
| Sales voucher (B2B, with IRN) | ✅ Built | v1.1.x | Waits in `awaiting_irn` until accounts generates IRN in Tally |
| IRN read-back | ✅ Built | v1.1.x | Bridge polls Tally for IRN; second ack triggers delivery |
| Receipt voucher (payment → Tally) | ✅ Verified | v1.3.1 | Verified vs real 80-receipt Tally export |
| Credit note (cancel/void reversal) | ✅ Verified | v1.3.1 | Verified vs real `CN/A/26-27/1` |
| Party master (auto-create ledger) | ✅ Live | v1.3.11 | CRM enqueues `party_master` before sales_voucher; bridge handles the job type + inline auto-create on sales AND receipt vouchers when `tally_auto_create_party_ledger=true` |
| Snapshot pull (read-only verification) | ✅ Live | v1.4.0 | Snapshot poller reads voucher list + Sundry Debtor party master and POSTs to `/api/tally/sync-pull` every 30 min during business hours. Drives the Handoff v2 inbox's `Tally: matched / drift / not synced` pills and receipt auto-complete. **Additive — does not mutate Tally.** |

### v1.4.0 changelog (2026-06-14) — additive read-only sync-pull poster

Path B of the Handoff v2 redesign (see `tally-handoff-redesign.md`). Pure additive
change: writer paths are byte-identical to v1.3.12. Adds a new `SnapshotPoller`
running alongside the writer poller.

1. **`listVouchersForSnapshot(fromDate, toDate)`** — new TallyClient method that
   reads Day Book vouchers and parses each VOUCHER block into a snapshot row.
   Classifies kind by VOUCHERTYPENAME (sales / receipt / credit_note). Captures
   narration, voucher class, cost centre as `custom_fields`.
2. **`listSundryDebtors()`** — reads all Sundry Debtor ledgers with GSTIN +
   mailing address. Non-fatal on older Tally versions without TDL support.
3. **`crmClient.postSyncPull(payload, detectedCompany)`** — POSTs the batch to
   `/api/tally/sync-pull` with the `x-tally-company` header for the company guard.
4. **`SnapshotPoller`** — runs every 30 min (configurable) during 09:00–20:00 IST
   business hours. Outside hours: sleeps. Re-entrant: skips a tick if the prior
   one is still in flight. Date window: 2 months (catches backdated receipts +
   FY boundaries).
5. **Isolation** — the snapshot poller is started in a try/catch in `index.ts`;
   if it ever crashes during start, the writer poller, heartbeat, and IRN-back
   polling are explicitly unaffected.
6. **Release artifact:** `twv-tally-bridge-v1.4.0.zip` (1.2 MB, self-contained
   with `node_modules`). SHA-256 captured in the bridge PR.

**Deploy path (Monday remote publish, no on-site visit):**
- Admin → Tally Sync → Update Bridge → upload zip with `version=1.4.0`
- Bridge heartbeat picks up the new version → self-updates between polls
- Watch the bridge log for `[snapshot] starting — interval 30min, business hours 9-20 IST`
- After first cycle (≤30 min): inbox `Tally` pills flip from gray `Tally: not synced`
  to green `Tally: matched` for statements with matching vouchers in Tally

**Rollback path:** Admin → Tally Sync → Update Bridge → Revert → publishes the
prior v1.3.12 zip. Bridge picks it up on next heartbeat. Writer side keeps working
either way; only the new inbox verification badges go silent.

### v1.3.12 changelog (2026-06-12) — comprehensive fix release

Found via full-bridge audit after the `&`-in-ledger-name bug. All in one release to avoid repeat on-site visits:

1. **XML entity decoding** (`unescapeXml`) applied everywhere Tally export values are compared or returned: `ledgerExists`, `extractAllCompanyNames` (company names with `&` would block ALL syncing), `getIrnMap` (IRN matching), `getVoucherByMasterId`, `findExistingVoucher` (idempotency). Root cause of the "Mayur Kumar M & CO" failure.
2. **Retryable-error classification fixed**: "Tally request timed out" did not match the old `"timeout"` substring check — every Tally timeout became a permanent failure. Now a regex covering timed out/ETIMEDOUT/ECONNREFUSED/ECONNRESET/EHOSTUNREACH/fetch failed/socket hang up/could not read back.
3. **Voucher read-back retry**: after creating a voucher, the Day Book read-back now retries 3×2s (Tally commit lag caused the vchid 32758/32759 "could not read back" failures); the error is also now retryable — on retry, check-before-create recovers by REMOTEID without duplicating.
4. **Local-time dates**: invoice/credit/receipt dates used `toISOString()` (UTC) — between 00:00–05:30 IST they'd be dated yesterday (wrong GST month; wrong FY on Apr 1). Now local date.
5. **party_master handler**: new job type — creates Sundry Debtor ledger, acks with `voucher_kind=party_master`; verifies via `ledgerExists` when Tally reports created=0.
6. **Receipt auto-create**: receipt_voucher jobs auto-create missing party ledger (same setting as sales).
7. **GSTIN validation**: non-empty but <15-char GSTIN now fails loud instead of posting B2B-without-IRN.
8. **Robustness**: failure-acks wrapped in try/catch (no contradictory acks), IRN-ack failures don't abort the batch, 30s CRM fetch timeout, unhandledRejection/uncaughtException guards, credit-note dup-check before ledger check, bank_allocation field guards, health page HTML escaping, dup-recovery ack now sends GST-inclusive total.

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
| `party_master` | Enqueued before each `sales_voucher` (and on retry of missing-ledger failures) | Creates/updates Sundry Debtor ledger | v1.3.11+ — acks `voucher_kind=party_master`; on success the ack handler re-queues any failed sales_voucher for the same statement |

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
