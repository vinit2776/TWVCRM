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

---

## 11. Engineering review decisions (locked — /plan-eng-review 2026-06-03)

| # | Decision |
|---|---|
| D1 | **Backend first, new page second.** Phase 1 = guards + delivery + PDF (validated on current page). Phase 2 = new Billing page (own review). |
| D2 | **Stamp `issuance_channel` ('tally'|'crm') on the statement at finalize.** All guards branch on the stamp, NOT the live switch — immune to mid-run flips. One `isTallyIssued(stmt)` helper everywhere. |
| D3 | **Delivered-once gate + retry.** `dispatchTallyInvoice` checks `tally_delivered_at` (set = skip); Razorpay link uses a deterministic `reference_id` (no 2nd link); failures → 'issued, not sent' + an undelivered-sweep cron + manual Resend. |
| D4 | **Verify IRP signed-QR from a real B2B IRN first.** Until confirmed, B2B PDF prints IRN + Ack No + Ack Date as TEXT; add the scannable QR once proven. |
| D5 | **Block void of a Tally-issued statement** (`tally_invoice_number` set) with a clear message. Drafts/unissued void normally. |
| D6 | **Isolate `dispatchTallyInvoice`** — own orchestration reusing leaf helpers (`generateGstInvoicePDF`/`resend`/`messaging`); do NOT refactor live `dispatchGstDirect`. TODO to unify later. |
| D9 | **B2B: wait for IRN, then send invoice + link together** (reaffirmed). B2C sends immediately on issue. |

### Outside-voice fixes (adopted — verified in code)
| # | Fix |
|---|---|
| OV1 | **Dunning must not chase unsent invoices.** `payment-reminder` cron enrols on `due_date != null` + unpaid, and `due_date` is stamped at finalize (`billing.ts:483`). Add a predicate so the cron only chases **delivered/issued** invoices (e.g. `tally_delivered_at IS NOT NULL` for tally statements). **Highest-priority fix.** |
| OV2 | **Guard the `generate-gst-invoice` route** (mints the CRM number + emails the PDF — was missing from the guard table). Audit EVERY PDF-email/link/number path, incl. the deposit/pro-rata `payment_link.paid` webhook and the legacy page's Resend. |
| OV3 | **Mirror `total_amount := tally_total_amount` on ack** (`ack/route.ts` writes the number but not the amount). Otherwise a ₹1 GST round-off delta breaks payment auto-matching → stuck 'unpaid' → dunning a paid invoice. Decide canonical invoice-number column post-flip and migrate all readers. |
| OV4 | **Flip-time migration sweep.** At go-live, enumerate finalized-but-unissued statements and assign an owner (force-complete legacy OR re-stamp tally) before flipping — no orphans. |
| OV5 | **Reconciliation sweep cron.** Detect 'Tally has the voucher, CRM never got the ack' (lost-ack) and recover; also flag orphan Tally vouchers with no CRM statement. |
| OV6 | **Documented manual correction procedure** for a mis-issued Tally invoice (cancel/CRN in Tally + mark CRM) for go-live, until CRN automation (Phase 3). |
| OV7 | **Stamp a single `lifecycle_stage` enum** at each transition (ack, deliver, webhook) instead of deriving 9 states from 6 columns live — page + cron read the same field, no divergence. |

### Guard table (corrected & complete)
All branch on `issuance_channel === 'tally'`:
1. `enqueueTallySalesVoucher` (finalize) — gated by stamp + sync.
2. `dispatchProforma` — early return.
3. `dispatchGstDirect` — early return.
4. `generateRentProformas` cron — finalize only (FIFO drain; clocks start at delivery not finalize).
5. Razorpay webhook auto-`generate-gst-invoice` — skip.
6. **`generate-gst-invoice` route (direct)** — skip (OV2).
7. Manual `finalize-and-send` / `send-proforma` — refuse.
8. Legacy page Resend — respect guards (OV2).
9. finalize `billingStatementReady` WhatsApp — suppress.
10. `payment-reminder` cron — only chase delivered invoices (OV1).
11. Void route — block if Tally-issued (D5).

---

## 12. NOT in scope (deferred, with rationale)
- **New Billing page (Phase 2)** — own design + review after the backend is proven (D1).
- **Credit-note automation (Phase 3)** — void is blocked + manual procedure documented (D5/OV6).
- **IRP scannable QR on B2B PDF** — deferred until the signed-QR is verified (D4); text IRN meanwhile.
- **Refactor/unify `dispatchTallyInvoice` ↔ `dispatchGstDirect`** — isolate now, unify when CRM issuance retired (D6).
- **Multi-GSTIN / inter-state IGST** — coworking is always TN intra-state.

## 13. What already exists (reused, not rebuilt)
Charge computation (`billing.ts` generators), `generateGstInvoicePDF`, `resend`/`messaging`,
the `payment-reminder` dunning cron, the Razorpay webhook, receivables/AR, contracts,
the Tally bridge + ack + IRN read-back. New: `dispatchTallyInvoice`, guards, `issuance_channel`
+ `tally_delivered_at` + `lifecycle_stage` columns, sweep crons, the new page (Phase 2).

## 14. Failure modes (Phase 1)
| Failure | Test? | Handling | User sees | Verdict |
|---|---|---|---|---|
| Dunning chases unsent invoice | ✅ CRIT | OV1 delivered predicate | n/a (prevented) | covered |
| Double invoice via any email/number path | ✅ CRIT | guard table 1-11 | n/a (prevented) | covered |
| Payment ₹1 off → never matches | ✅ | OV3 total mirror | n/a (prevented) | covered |
| Delivery fails (email/RZP down) | ✅ | 'issued not sent' + sweep + resend | retry visible | covered |
| Lost ack → stuck in_progress | ✅ | OV5 reconciliation sweep | flagged | covered |
| Orphan at flip | ✅ | OV4 flip-time sweep | n/a | covered |
| Mis-issued Tally invoice | ✅ | OV6 manual procedure | documented | covered (manual) |
| Switch flipped mid-run | ✅ | D2 stamp-at-finalize | n/a | covered |
No silent-failure critical gaps remain.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 6 decisions, 0 critical gaps |
| Outside Voice | Claude subagent | Independent challenge | 1 | issues_found→adopted | 3 P0 (code-verified) + 4 hardening, all adopted |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Design Review | `/plan-design-review` | UI/UX | 0 | — | Phase 2 (new page) |

- **OUTSIDE VOICE:** caught the dunning-chases-unsent leak (cron enrols on due_date stamped at finalize), the ungated generate-gst-invoice route, and total_amount not mirrored to Tally's total. All adopted (OV1-OV7).
- **CROSS-MODEL:** no tension — outside voice was additive, not contradictory.
- **UNRESOLVED:** 0.
- **VERDICT:** ENG CLEARED — Phase 1 backend plan locked. Build order: guards+stamp → dispatchTallyInvoice+total-mirror → sweep crons. Blocked only on D4 B2B-IRN sample before the IRP QR.

---

## 15. SCOPE CORRECTION (authoritative — supersedes §3 routing breadth & §6 guard table)

**The only change is the GST-invoice GENERATION engine: Tally instead of CRM. The
Proforma flow and the per-contract mode choice are untouched.**

### What the switch actually controls
`tally_sync_enabled` decides **where a GST tax invoice is generated** (Tally vs CRM) —
NOT whether there's a PI. The per-contract `billing_mode` (`proforma_first` | `gst_direct`)
**stays, selectable on every contract.** Two independent axes.

### Untouched (CRM, exactly as built)
- `dispatchProforma` (PI issuance), the PI's Razorpay link, PI payment, PI dunning.
- Per-contract `proforma_first` vs `gst_direct` selection.
- PI→GST conversion *trigger* logic (`convert-to-gst-early`, webhook-on-PI-paid).

### The swap: 3 GST-generation entry points → Tally (when sync ON)
| Entry point | Today (CRM) | Under Tally |
|---|---|---|
| `dispatchGstDirect` (gst_direct, at finalize) | mints CRM GST # + PDF + link + send | enqueue Tally → voucher → number/IRN → `dispatchTallyInvoice` (unpaid: + link + dunning) |
| `generate-gst-invoice` (proforma_first, after PI paid; or manual) | mints CRM GST # + PDF | enqueue Tally → voucher → `dispatchTallyInvoice` (PAID tax doc, **no new link**) |
| `convert-to-gst-early` (PI→GST before payment) | mints CRM GST # + PDF | enqueue Tally → voucher → `dispatchTallyInvoice` (unpaid: + link + dunning) |

The webhook auto-trigger needs no separate guard — it calls `generate-gst-invoice`, which
routes to Tally internally.

### Enqueue trigger MOVES: finalize → GST-generation moment
Today `enqueueTallySalesVoucher` fires at finalize (wrong for proforma_first, where GST
comes after PI payment). **Remove the finalize enqueue; enqueue at the 3 entry points
above** when sync ON. Stamp `issuance_channel='tally'` there (D2).

### dispatchTallyInvoice — paid vs unpaid (mirrors existing dispatchGstDirect/generate-gst-invoice)
- **proforma_first (PI already paid):** Tally GST invoice = a **paid** tax document.
  Deliver the PDF; **no new Razorpay link, no dunning** (already collected).
- **gst_direct / convert-to-gst-early (unpaid):** Tally GST invoice + Razorpay link;
  set `due_date` at delivery; dunning chases (OV1 predicate applies here only).

### Revised guard set (smaller than §6.1)
1. **3 GST-generation entry points** → redirect to Tally enqueue (not CRM mint) when sync ON.
2. `payment-reminder` cron → only chase **delivered, unpaid** Tally GST invoices (OV1) —
   PI dunning unchanged.
3. Void of a Tally-issued statement → blocked (D5).
4. `dispatchProforma` → **NOT guarded** (PI stays CRM).
Decisions D2/D3/D4/D6, OV3/OV4/OV5/OV6/OV7 all still apply at the GST-generation/delivery layer.

### Build order (revised, Phase 1)
1. Move enqueue to the 3 GST-gen entry points + stamp `issuance_channel`; remove finalize enqueue.
2. `dispatchTallyInvoice` (paid-vs-unpaid) + `total_amount` mirror (OV3) + delivered-once (D3).
3. OV1 reminder predicate; void block (D5); sweep crons (OV4/OV5).

---

## 16. Clarifications: cancel/modify + manual payments

### Q1 — Cancel / modify a Tally-issued GST invoice (Tally is source of record)
- **B2B within 24h of IRN:** cancel the IRN (via Tally), re-issue corrected.
- **B2B after 24h:** issue a Credit Note in Tally, then a fresh invoice (IRN'd invoices can't be edited).
- **B2C (no IRN):** edit/cancel directly in Tally.
- **Reflect in CRM:** manual now (mark statement cancelled/superseded to match Tally; the
  OV5 reconciliation sweep flags mismatches). **Phase 3:** one-click CRN from the CRM.
- This is why CRM-only void is blocked (D5) — corrections must be Tally-first/coordinated.
- Cheapest to modify **before** Tally issues (edit the PI/statement pre-conversion).

### Q2 — Manual payments: CRM is primary; bridge posts the receipt to Tally
**Decision: enter manual (bank/cash) payments ONCE in the CRM** (as today — `billing_payments`).
- CRM marks the statement paid → **follow-up/dunning stops immediately** (CRM stays the
  authority for collection).
- **NEW build — receipt-voucher sync:** when a payment is recorded (manual entry OR the
  Razorpay webhook), enqueue a `receipt_voucher` job (job type already exists in
  `tally_sync_jobs`). The bridge posts a Receipt Voucher into Tally against the invoice,
  so Tally's books show it paid. One entry, both systems agree.
- **Online (Razorpay):** already flows CRM→Tally via the webhook → same receipt-voucher job.
- **Interim (until receipt sync ships):** double-entry (CRM for follow-up + accounts records
  the receipt in Tally). Build receipt sync in Phase 1 to remove the double entry.

### Added to Phase 1 scope
- `dispatchTallyInvoice` already handles paid (no link) vs unpaid (+link).
- **Receipt-voucher sync** (CRM payment recorded → bridge posts receipt to Tally) — needed
  for correct books once invoices are Tally-issued. Bridge: implement `postReceiptVoucher`
  (mirror of `postSalesVoucher`); CRM: enqueue `receipt_voucher` on payment.

---

## 17. Guiding principle: CRM is the single control surface (locked)

**Every accounting action is initiated in the CRM, executed in Tally by the bridge, and
reflected back. Tally remains the system of record for the books; the CRM is the one
place humans operate.** Same outbox pattern for all actions:

```
 CRM action ──enqueue job──▶ bridge ──XML──▶ Tally ──confirm/read-back──▶ CRM reflects
   issue        sales_voucher                  voucher + IRN
   payment      receipt_voucher                receipt
   cancel       credit_note                    CRN + IRN (B2B)
   modify       credit_note + sales_voucher    CRN + new invoice
```

### Cancel / modify (CRM-first) — build as fast-follow phase (Phase 1b)
- "Modify" = **cancel + re-issue** (GST: e-invoices can't be edited).
- **Cancel:** CRM "Cancel" → `credit_note` job → bridge posts CRN voucher in Tally
  (+ its own IRN for B2B, via the existing IRN read-back loop) → CRM marks cancelled.
- **Modify:** CRM "Modify" → CRN for the old + a new `sales_voucher` for the corrected →
  CRM reflects both.
- **<24h B2B optimization:** *optionally* cancel the IRN instead of a CRN — only if Tally
  exposes IRN-cancellation via XML (verify with a sample). The CRN path always works, so
  we never depend on it.
- **Needs:** one real Credit Note XML sample from Tally (like the sales-voucher sample) +
  CRN-IRN read-back. Bridge: `postCreditNote` (mirror of `postSalesVoucher`).
- **Interim (until Phase 1b ships):** documented manual Tally cancel (§16 Q1) for the
  short gap after core go-live.

### Revised phase roadmap
1. **Phase 1 (core):** GST issuance via Tally at the 3 entry points + `dispatchTallyInvoice`
   (paid/unpaid) + **receipt-voucher sync** + guards/hardening (D2-D6, OV1-OV7).
2. **Phase 1b (fast-follow):** CRM-first cancel/modify (credit_note voucher + IRN read-back).
   Needs a CRN sample. Replaces the manual procedure + the deferred "Phase 3" CRN automation.
3. **Phase 2:** new Billing page (UI) — own design + review.
