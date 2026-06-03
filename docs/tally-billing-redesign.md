# Tally-Era Billing — Redesign Design Doc

**Status:** Draft for `/plan-eng-review`
**Owner:** Vinit
**Date:** 2026-06-03
**Supersedes (UI only):** the current `/billing` page

---

## 1. Problem & goal

Today the CRM both **computes** bills and **issues** the GST tax invoice itself
(proforma_first / gst_direct dispatch). We are moving **issuance** to Tally (where
e-invoicing/IRN lives). We want a clean, purpose-built **Billing** page for this
Tally-first world, without rebuilding the valuable, tested charge-computation engine
and without breaking live billing during the transition.

**Goal:** One Billing page where staff run the full recurring cycle — rent, usage
(over/without quota), and booking charges — and watch each bill flow: computed →
issued by Tally (±IRN) → sent to the customer → paid → followed-up.

---

## 2. Core principle: reuse the engine, replace issuance + UI

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │  WHAT TO BILL  (REUSE — unchanged, Tally-agnostic)                   │
 │  rent cron · usage rollup (quota/overage) · booking rollup           │
 │            → billing_statements (the canonical bill)                  │
 └───────────────────────────────┬─────────────────────────────────────┘
                                 │ finalize
 ┌───────────────────────────────▼─────────────────────────────────────┐
 │  ISSUE + DELIVER + MONITOR  (NEW — Tally layer + new page)           │
 │  Tally issues invoice (number + IRN) → CRM delivers (PDF+link,       │
 │  email/WhatsApp) → payment tracking → 6-stage follow-up              │
 └─────────────────────────────────────────────────────────────────────┘
```

- **Reused unchanged:** `billing_statements` data model; `generateRentProformas` /
  `generateUsageStatements` / booking rollup (charge computation); Razorpay webhook
  (payment status); the 6-stage `payment-reminder` dunning cron; receivables/AR; contracts.
- **New:** the Tally issuance flow (already built: bridge + voucher + read-back + IRN),
  the **delivery** (`dispatchTallyInvoice`), the **new Billing page**, and the **guards**
  that make the CRM's own issuance step aside when Tally is the issuer.

---

## 3. Routing: one global switch

`app_settings.tally_sync_enabled` (the Pause/Active toggle on Admin → Tally Sync) is the
single router. **No per-contract tagging.**

| Switch | Behaviour |
|---|---|
| OFF (today) | CRM issues + delivers (existing flow). Tally idle. New page hidden/optional. |
| ON (go-live) | **Tally issues every GST invoice**; CRM's own issuance steps aside; the new Billing page is the working screen. |

Instantly reversible: flip OFF → existing flow resumes immediately (safety net).

---

## 4. Unified statement lifecycle (the heart of the new page)

A statement moves through one clear status line. The new page renders this per row.

```
 DRAFT ──finalize──▶ QUEUED ──bridge──▶ ISSUING
                                          │
                         ┌────────────────┴───────────────┐
                    (B2C: no IRN)                   (B2B: has GSTIN)
                         │                                │
                         ▼                                ▼
                      ISSUED ◀───────IRN arrives──── AWAITING_IRN
                         │
                         ▼
                       SENT ──▶ UNPAID ──▶ PARTIALLY_PAID ──▶ PAID
                                  │
                                  └──overdue──▶ IN_FOLLOWUP (stage 1..6)

 Exceptions (any stage): FAILED (Tally/ledger/IRP error) · VOIDED
```

Status derives from existing columns (no big new state machine):
- `status` (draft/finalized/voided) + `tally_sync_status` (pending/in_progress/issued/failed)
  + `tally_invoice_number` + `tally_irn` + delivery flag + `payment_status` + reminder stage.

Each status has exactly one primary action on the page (Finalize / Retry / Resend / View).

---

## 5. The new Billing page (UI)

Route: new `/billing` (old page moved to `/billing-legacy`, hidden from nav).

**Tabs / filters:** Rent · Usage · Bookings · All; status filter (Needs attention,
Awaiting IRN, Unsent, Unpaid, In follow-up, Done).

**Row (per statement):** customer · type · period · amount · **lifecycle badge** ·
Tally invoice # · IRN ✓/pending · sent ✓ · paid/unpaid · follow-up stage · action.

**Top bar:** "Needs attention" count (failed, ledger-missing, IRN-stuck), "Awaiting
IRN" count, "Unsent" count. Bridge health chip (reuse `TallyBridgeHealthCard`).

**Detail drawer:** full line items, the Tally voucher link, IRN/QR, payment history,
follow-up timeline, audit. Actions: Finalize, Retry (failed), Resend, Mark paid (manual),
Void.

**Generation controls:** "Generate this month" (rent/usage), reusing the existing
generators. Rent auto-finalizes (→ auto-issue+send); usage stays draft for review then
Finalize.

---

## 6. Backend changes

### 6.1 Guards (make CRM issuance step aside when sync ON) — global checks
| # | File / function | Guard |
|---|---|---|
| 1 | `enqueueTallySalesVoucher` (finalize) | already gated by `tally_sync_enabled` — keep |
| 2 | `dispatchProforma` | if sync ON → return early ("routed to Tally") |
| 3 | `dispatchGstDirect` | if sync ON → return early |
| 4 | `generateRentProformas` cron | if sync ON → finalize only (enqueues Tally), skip CRM dispatch |
| 5 | Razorpay webhook auto-`generate-gst-invoice` | if sync ON / statement has `tally_invoice_number` → skip |
| 6 | Manual `finalize-and-send` / `send-proforma` routes | if sync ON → refuse ("Tally billing active") |
| 7 | finalize `billingStatementReady` WhatsApp | if sync ON → suppress (Tally delivery is the real message) |

### 6.2 Delivery — `dispatchTallyInvoice(statementId)` (NEW)
Triggered from `/api/tally/ack` when an invoice is **ready** (B2C immediately; B2B once
IRN read back). Reuses existing helpers:
1. Generate GST PDF via `generateGstInvoicePDF` fed **Tally's** number, line items,
   amounts, Razorpay QR — **plus IRN + IRP signed-QR for B2B** (new PDF support).
2. Create Razorpay link (Tally total).
3. Email (`resend`, PDF attached) + WhatsApp (`messaging`).
4. Set `payment_status='unpaid'` + `due_date` → existing reminder cron auto-enrols it.
5. Store `tally_invoice_number`, link, pdf path. Mark delivered.

### 6.3 PDF: render IRP e-invoice QR + IRN for B2B (NEW)
`generateGstInvoicePDF` gains `irn`, `ackNo`, `ackDate`, `signedQrBase64` (rendered from
`tally_signed_qr_code`). Two-QR rule (D10.6): IRP QR (legal) never obscured; Razorpay
"Scan to Pay" QR labelled separately. B2C: no IRP QR.

### 6.4 No data-model rewrite
Reuse `billing_statements` + the Tally mirror columns already added (migration 00235/00236).
Possibly add: `tally_delivered_at` (delivery timestamp) — small additive migration.

---

## 7. What stays 100% untouched
Charge computation (rent/usage/booking), contracts, receivables/AR, payments table,
Razorpay webhook payment-matching, the dunning ladder, KYC gates. The guards only branch
on `tally_sync_enabled`; with it OFF everything behaves exactly as today.

---

## 8. Failure modes & edge cases (must handle on the page)
- **Customer ledger missing in Tally** → statement FAILED with "create ledger X"; Retry. (built)
- **Voucher create error** → FAILED + Tally message; Retry.
- **B2B IRN not generated for N hours** → "Awaiting IRN" highlighted; IRN-aging alarm. (built)
- **Delivery fails** (no email/phone, send error) → "Issued, not sent"; Resend.
- **Partial payment** → follow-up continues on balance.
- **Void** after issue → must also handle Tally (credit note is Phase 3 / out of scope here).
- **Duplicate guard** → idempotency_key + check-before-create (built); no double invoice.
- **Switch flipped mid-cycle** → in-flight drafts: finalizing after ON goes to Tally;
  already-CRM-issued statements are left as-is (not re-issued).

---

## 9. Phased rollout (all behind the paused switch)
1. **Backend guards** (make CRM issuance step aside) + `tally_delivered_at` migration.
2. **`dispatchTallyInvoice`** + B2B IRP-QR on PDF; wire to `/api/tally/ack`.
3. **New Billing page** (read + lifecycle + actions) at `/billing`; move old to `/billing-legacy`.
4. **Test** with a test statement (test customer, no real contact) end-to-end.
5. **Go live**: lock company, install bridge service, flip switch ON, watch first real invoices.

---

## 10. Open questions for review
- Should rent still **auto-finalize+auto-issue** under Tally, or require staff Finalize?
  (Proposed: keep rent auto, usage manual — mirrors today.)
- Old page: **hide from nav but keep routable** (`/billing-legacy`) as a fallback for the
  transition? (Proposed: yes.)
- Manual "Mark paid" for bank/cash on the new page — needed day one? (Proposed: yes,
  reuse existing payment recording.)
- B2C invoice PDF: send immediately on issue; B2B PDF: send only after IRN. (Confirmed.)
