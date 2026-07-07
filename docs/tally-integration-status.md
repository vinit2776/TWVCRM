# Tally Integration — Status & Resume Notes

**Last updated:** 2026-07-07
**State:** ⚠️ SHELVED. This automated bridge-sync feature (the whole plan documented below) is
intentionally shelved — GST invoicing for both `billing_mode`s now goes through the separate
**Tally Inbox** manual-handoff workflow instead (`tally_handoff_v2_enabled=true`, unrelated
system, fully active, no restriction). `tally_handoff_v2_enabled` already bypasses this entire
pipeline — see `handleStatementFinalized()` in `billing.ts` and the payment webhook's
`v2Enabled` branch, both of which skip `dispatchGstDirect`/`generate-gst-invoice` (and therefore
`routeGstGenerationToTally`) before this doc's flow is ever reached.

`app_settings.tally_sync_enabled` was found flipped to `true` in production on 2026-07-06
(no migration or commit ever set it — it was toggled manually via the control page, most
likely mid–go-live rehearsal, then left on with a stale bridge heartbeat and no new sync jobs
for ~12 days). It was flipped back to `false` on 2026-07-07 and the go-live rehearsal below
is now considered abandoned in favor of Tally Inbox.

**Do not resume this feature, flip `tally_sync_enabled` back to `true`, or build further on
`src/lib/tally/enqueue.ts` / `dispatchGstDirect` without an explicit request.** The rest of this
document is kept for historical/reference value only.

---

## Build status — complete & verified (7 PRs, none merged, sync paused)

| PR | Scope | Base | Verified? |
|----|-------|------|-----------|
| #32 | Perf indexes (00239/00240) | main | applied to prod |
| #33 | Phase 1 — GST issuance swap | main | sync-off = unchanged |
| #34 | Receipt reverse-sync + control-page settings | #33 | **verified vs real 80-receipt export** |
| #35 | Repo hygiene | main | n/a |
| #36 | Phase 1b — cancel via credit note | #34 | **verified vs real CN/A/26-27/1** |
| #37 | Phase 2 — Tally state / IRN / retry on billing page | #36 | build clean (browser-verify on deploy) |

Merge order: #32, #35 (independent) anytime; then #33 → #34 → #36 → #37 (stacked, bottom-up).

**Bridge v1.3.1** — all three voucher formats matched to real Tally exports:
- `postSalesVoucher` — proven live (created `SD/A/26-27/182`)
- `postReceiptVoucher` — verified vs the real 80-receipt export
- `postCreditNote` — verified vs real `CN/A/26-27/1`

Mock e2e (run in `bridge/`): `npx ts-node src/test-receipt-voucher.ts` (22) +
`src/test-credit-note.ts` (15) — both green. Real samples archived at `~/twv-tally-samples/`.

### Remaining for go-live — the live dress rehearsal only (needs you + real Tally)
Per `docs/tally-go-live-runbook.md`. No code remains; these are config + observation:
1. **Set the receipt account ledger** — Admin → Tally Sync → Receipt sync →
   `tally_ledger_receipt_account` (likely `ICICI BANK A/C NO.000905000140`, confirm). Everything
   else defaults correctly (bill-by-bill on, account-is-bank on, e-Fund Transfer / NEFT).
2. **Deploy bridge v1.3.1** on the Tally server (re-pull, `npm run build`), lock the company.
3. **Flip sync ON for one test statement** and watch: voucher issued → IRN (B2B) → delivered →
   payment → receipt → (optional) cancel → credit note. The billing page now shows each state
   live (PR #37). If the receipt import errors on bank detail, adjust
   `tally_receipt_transaction_type`/`_transfer_mode` settings and Retry (no code change).
4. **Resume** (`tally_sync_enabled = true`) on the control page once the rehearsal passes.

Kill switch at any time: Admin → Tally Sync → Pause = the pre-Tally CRM behaviour for every
new statement (migrations are additive/nullable, so OFF == before).

---

## ✅ Phase 1 built (branch `feat/tally-billing-phase1`)

Surgical change: only GST-invoice GENERATION moves to Tally. PI flow + per-contract
`billing_mode` (proforma_first/gst_direct) untouched. Master switch `tally_sync_enabled`
controls WHERE the GST invoice is issued (CRM vs Tally), not whether a PI exists.

With sync OFF the system is byte-for-byte identical to before — every guard checks the
switch first and only stamps `issuance_channel='tally'` when ON.

1. **Migration 00238** — `issuance_channel` ('crm'|'tally', default 'crm'), `tally_delivered_at`,
   `lifecycle_stage`, + undelivered partial index. APPLIED to prod.
2. **GST generation routes to Tally** at the 3 entry points via `routeGstGenerationToTally()`
   (`src/lib/tally/enqueue.ts`): `dispatchGstDirect`, `generate-gst-invoice` route,
   `convert-to-gst-early` route. Each stamps `issuance_channel='tally'` (decide-once),
   enqueues a `sales_voucher` job, and returns early so the CRM mints/sends nothing.
   Finalize no longer enqueues.
3. **`dispatchTallyInvoice`** (`src/lib/tally/dispatch-tally-invoice.ts`) — delivers the
   Tally-issued invoice: builds the PDF with Tally's number, emails + WhatsApps it, and
   for UNPAID (gst_direct) creates the Razorpay link + due date so dunning takes over;
   PAID (proforma_first) sends a receipt with no link. Delivered-once gated on
   `tally_delivered_at`. Wired into `/api/tally/ack`; replaces the old `post-ack.ts`.
   Ack now mirrors `total_amount` immediately (OV3).
4. **Guards** — payment-reminder skips Tally invoices until `tally_delivered_at` is set
   (OV1); CRM void is blocked for `issuance_channel='tally'` (D5 — cancel must go through
   the Phase 1b credit-note flow so Tally reverses first).
5. **Reverse-sync + self-heal** — `enqueueTallyReceiptVoucher()` queues a `receipt_voucher`
   job when a payment is recorded (manual route + Razorpay webhook) against a Tally invoice;
   `/api/cron/tally-reconcile` (every 15 min) re-drives delivery for issued-but-undelivered
   invoices. (Receipt sync + cancel are now fully built — see PR #34 / #36 above.)

---

## 🏆 Milestone reached: core integration proven against real production Tally

A real invoice (`SD/A/26-27/182`) was created in the live Sree Design company via the
full pipe (CRM → bridge → Tally → CRM), and the real invoice number was read back.
`CREATED=1, ERRORS=0`.

### Proven working
- Bridge ↔ Tally ↔ CRM connectivity (bridge auto-targets Sree Design among 3 open companies)
- Voucher creation in the exact **SDIPL-REG** item-invoice format Tally accepts
- Invoice-number read-back (match `MASTERID == LASTVCHID` in the Day Book)
- B2C completes immediately; B2B holds for IRN
- Company guard (locked company) + customer-ledger guard (fail loud if missing)
- IRN read-back loop (mechanism proven on mock; not yet against a real B2B IRN)

### Decisions locked
| # | Decision |
|---|---|
| System of record | Tally owns invoice number + IRN; CRM mirrors |
| Voucher type | `SDIPL-REG`, auto-numbered |
| Income ledger | `Rent The Workvilla 18%` (rent + usage) |
| Tax ledgers | `CGST Output 9%`, `SGST Output 9%` |
| Stock item | `Rent-The WorkVilla` |
| Place of supply | Tamil Nadu (always CGST+SGST for coworking) |
| Import header | `<TALLYREQUEST>Import Data</TALLYREQUEST>` |
| B2C (no GSTIN) | No IRN — send immediately |
| B2B (has GSTIN) | Wait for IRN (accounts generates it manually/batch), then send |
| Customer ledgers | Require existing in Tally; fail loud if missing |
| Delivery | Auto-send invoice + payment link the moment the invoice is ready |

---

## ⏳ Remaining work (the last mile)

### 1. Delivery — build `dispatchTallyInvoice` (NEXT)
Auto-send the invoice + Razorpay link to the customer once the invoice is ready
(B2C immediately; B2B after IRN). Reuse existing infra, do NOT modify the live
`dispatchGstDirect`:
- `generateGstInvoicePDF` (`src/lib/gst-invoice-generator.ts`) — feed it Tally's
  invoice number, IRN, signed QR (B2B), line items, Razorpay QR
- Razorpay link creation (pattern in `src/lib/send-proforma.ts` dispatchGstDirect)
- Email via `resend` (`src/lib/mailer.ts`) with PDF attached
- WhatsApp via `messaging.invoiceDocument` / `paymentReminder` (`src/lib/whatsapp.ts`)
- Set `payment_status='unpaid'` + `due_date` so the existing `payment-reminder` cron
  auto-enrolls it (6-stage dunning ladder — `src/lib/payment-reminder.ts`)
- Render the legal **IRP QR** on B2B PDFs (two-QR rule: don't obscure it; label the
  Razorpay "Scan to Pay" QR separately)
- Replace the partial `src/lib/tally/post-ack.ts` with a call to `dispatchTallyInvoice`
- Trigger point: `/api/tally/ack` when an invoice completes (irn_pending=false)

### 2. B2B IRN real test
Create a real B2B invoice via the bridge → have accounts generate the IRN in Tally →
confirm the bridge's IRN read-back picks it up and triggers send.

### 3. Full real-statement test
Once delivery is built: finalize one small real statement → watch voucher + read-back
+ Razorpay link + delivery, end to end. Use a test customer with NO contact (so no
real notification) or a test email/phone.

---

## Operational state (for resume)

- **Sync is PAUSED** (`app_settings.tally_sync_enabled = false`). Nothing posts. Safe.
- **Bridge on the Tally server:** running v1.1.1 via `npx ts-node src/index.ts` in a
  window (NOT installed as the auto-start service yet — do that as the final go-live step).
- **Latest bridge code is v1.1.2** (adds the ledger guard). Re-pull
  `twv-tally-bridge-TESTED.zip` when resuming.
- **Test voucher `SD/A/26-27/182`** ("TEST E2E - PLEASE DELETE", ₹236 to Novo Nordisk)
  and `SD/A/26-27/181` ("TEST INVOICE - PLEASE DELETE", ₹118) — delete these in Tally
  if not already done (they're the last vouchers, so numbers roll back).
- **Vercel env:** `TALLY_AGENT_TOKEN = twv-tally-bridge-2026` (all environments).
- **Control page:** Admin → Tally Sync (status, company lock, pause/resume, ledger
  mapping, audit log). Ledger mapping is pre-filled with the real values.

## To go live (final steps, once delivery is built + tested)
1. Lock the company on the control page (Admin → Tally Sync → Lock to "Sree Design…")
2. Install the bridge as a Windows service: `npm run build` then
   `node dist\install-service.js` (run as admin)
3. Flip `tally_sync_enabled = true` (resume) on the control page
4. Set Tally + the company to auto-load on the server so reboots recover unattended
