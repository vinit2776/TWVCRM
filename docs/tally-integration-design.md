# TWV CRM ↔ Tally Integration — Design Document

**Status:** Draft for approval
**Owner:** Vinit
**Last updated:** 2026-06-02

---

## 1. Purpose

Connect TWV CRM (cloud) with Tally Prime (on-premise) so that:

- **Tally issues the legal GST invoice** (invoice number + e-invoice / IRN). It stays
  the system of record and the source for GST returns.
- **The CRM owns the money funnel** — generating the Razorpay payment link, attaching it
  to the invoice, tracking payment, and running the follow-up / reminders.
- **Payments reconcile both ways automatically**, so the follow-up loop closes itself
  whether the customer pays online or by hand.

No more manual export/import between the two systems.

---

## 2. Decisions locked

| Decision | Choice | Why |
|---|---|---|
| System of record for GST invoice + IRN | **Tally** | E-invoicing already works there; books must be authoritative. |
| CRM's own e-invoice generation (`/api/e-invoice/*`) | **Disabled / parked** | Prevents two systems minting an IRN for the same sale. Tables kept as a mirror. |
| Tally hosting | **On-prem office server** | Existing setup. |
| Bridge host | **On the Tally server itself** | Talks to Tally via `localhost`; only needs outbound HTTPS. No LAN/firewall exposure. |
| Payment link on the invoice | **CRM overlays QR + Pay Now link onto Tally's PDF (pdf-lib)** | No Tally TDL customization needed; legal invoice stays as Tally issued it. |
| Link timing | **After Tally issues** the invoice number | Cleanest reference; the real GST number is on the link and PDF. |
| Sync scope | **Full** — sales invoices, payments (both directions), and credit notes (voids) | Closes the collections loop end to end. |
| Payment instrument | **Razorpay only** (not Tally's native UPI QR) | Only way the CRM can track and chase the payment. |

---

## 3. Architecture

```
                         ┌────────────────────────────────────────┐
   Vercel (cloud)        │            Office (on-prem)             │
 ┌──────────────────┐    │   ┌──────────────┐   localhost:9000    │
 │     TWV CRM      │HTTPS│   │   Bridge     │   XML over HTTP     │
 │   + Supabase     │◄────────┤   Agent      ├───────────►┌───────────┐
 │                  │poll/│   │ (Node svc on │            │  Tally    │
 │  /api/tally/*    │ ack │   │  Tally box)  │◄───────────┤  Prime    │
 └──────────────────┘    │   └──────────────┘  IRN / QR  │ + e-inv   │
                         │         ▲  reads receipts      └───────────┘
                         │         └── (manual payments) ────┘        │
                         └────────────────────────────────────────────┘
```

**Bridge agent** = a small Node.js service installed on the Tally server, running as a
Windows service (auto-start). It is the only component that talks to Tally. It:

- **Polls** the CRM over HTTPS for pending jobs (outbound only — no inbound firewall holes).
- **Writes** to Tally via `localhost:9000`: party masters, sales vouchers, receipt
  vouchers, credit notes.
- **Reads** from Tally via `localhost:9000`: new receipt vouchers (manual payments).
- **Acks** results back to the CRM (invoice number, IRN, QR, errors).

The CRM never connects to Tally directly. The cloud can't reach the office LAN — the
bridge bridges that gap by reaching *out* to the cloud.

---

## 4. The invoice flow (happy path)

1. **You** finalize a billing statement in the CRM. *(Only human step.)*
2. CRM marks it `tally_sync_status = 'pending'` and queues a sales job.
3. Bridge polls, picks up the job.
4. Bridge ensures the **party ledger** exists in Tally (creates/updates if missing).
5. Bridge posts a **Sales Voucher** to Tally → Tally generates **invoice number + IRN/QR**.
6. Bridge **acks** the number + IRN/QR back to the CRM.
7. CRM creates the **Razorpay payment link** for the invoice total.
8. CRM **overlays the QR + Pay Now link onto the Tally PDF** (pdf-lib) and sends it to the
   customer (email / WhatsApp).
9. CRM tracks payment and runs follow-up reminders.

---

## 5. Two-way payment reconciliation

Payments arrive through one of two doors; both end at *invoice = Paid in both systems,
follow-up stopped.* The shared **GST invoice number** is the matching key.

### Door 1 — Online (Razorpay link)
1. Customer pays via the link.
2. Razorpay webhook → CRM marks **Paid**, stops reminders.
3. Bridge posts a **Receipt Voucher** into Tally against the invoice.

### Door 2 — Manual (cash / cheque / bank)
1. Accounts records the receipt **in Tally** as usual.
2. Bridge **reads new receipts** out of Tally and reports them to the CRM.
3. CRM marks **Paid**, stops reminders.

### Edge cases
| Risk | Handling |
|---|---|
| Double counting (paid online *and* keyed into Tally) | Invoice can be marked Paid once; first door wins, second recognized as already-paid, no duplicate voucher. |
| Partial payments | CRM tracks **balance**; follow-up continues until balance = 0. |
| Unmatched Tally receipt (no matching invoice no.) | Flagged "needs review" + alert; never silently mismatched. |
| Round-off (paise) | Link created for `total_invoice_value` (round-off included). |

---

## 6. Error handling

**Golden rule: nothing is lost — jobs wait in a queue and retry until they succeed.**

| Failure | Behaviour |
|---|---|
| Tally off / server rebooting | Job stays `pending`, auto-retries when Tally is back. CRM keeps working. |
| Office internet down | Same — jobs wait, drain when internet returns. |
| Tally on but no internet | Voucher created; **IRN step** retried when internet returns (IRN needs the govt portal). |
| Tally rejects voucher (bad ledger/customer) | Job → `failed — needs attention`, alert, fix data + Retry. |
| Govt portal rejects IRN (invalid GSTIN) | Same — flagged for human. |

**Safeguards**
- **Idempotency:** every invoice carries a unique tag; retries never double-post.
- **Status dashboard** in the CRM: Pending → Sent to Tally → Issued → Sent → Paid.
- **Stuck-job alerts:** anything waiting too long pings an admin (email/WhatsApp).

**Hard requirement:** Tally must be **open with the company loaded** for vouchers to post.
If a TallyVault password is set, someone unlocks it after a reboot.

---

## 7. CRM-side changes

### 7.1 Database (new migration, e.g. `00232_tally_sync.sql`)
On `billing_statements` / `gst_invoices`:
- `tally_sync_status` (`pending` | `posted` | `failed` | `not_applicable`)
- `tally_voucher_guid` (Tally's voucher reference)
- `tally_invoice_number` (the number Tally assigned — becomes the GST invoice number)
- `tally_synced_at`, `tally_last_error`
- Reuse existing `irn`, `ack_no`, `signed_qr_code` columns as the **mirror** of what Tally
  returns (not CRM-generated).

New table `tally_sync_jobs` (the queue): `id`, `job_type` (`sales` | `receipt` |
`credit_note` | `party`), `payload`, `status`, `attempts`, `last_error`, `created_at`,
`completed_at`.

### 7.2 Ledger / Chart-of-Accounts mapping (config in `app_settings`)
Tally posts to named ledgers. The CRM has none today. Need a configurable map:
- charge type → Tally **sales ledger** (e.g. "Space Rent Income", "Usage Income")
- tax → "Output CGST" / "Output SGST" / "Output IGST"
- round-off → "Round Off"
- party-ledger naming convention (e.g. company name + GSTIN)

### 7.3 Bridge API endpoints (token-authenticated, not user session)
- `GET  /api/tally/pending` — bridge claims a batch of jobs
- `POST /api/tally/ack` — write back invoice no. / IRN / QR / voucher GUID, or mark failed
- `POST /api/tally/payments` — bridge reports manual receipts read from Tally

### 7.4 Behaviour changes
- **Park** `/api/e-invoice/generate` + `/cancel` (no CRM-side IRN minting).
- **Razorpay link** created after Tally ack; **pdf-lib overlay** of QR + link onto Tally PDF.
- **Void → Credit Note:** the existing void flow queues a CRN job to Tally instead of a
  silent unlink.
- **Online payment → Receipt Voucher** queued on webhook confirmation.

---

## 8. The bridge agent (outside this repo)

- **Runtime:** Node.js (TypeScript), Windows service via `node-windows` / NSSM.
- **Builds Tally XML** envelopes: party master, sales, receipt, credit note.
- **Posts** to `http://localhost:9000`, parses responses (incl. e-invoice block).
- **Polls** the CRM endpoints on an interval; backoff + retry on failure.
- **Config:** CRM base URL, agent token, poll interval, ledger map (or fetched from CRM).
- **Logs** locally + reports status to the CRM dashboard.

---

## 9. Security

- Tally gateway is unauthenticated → **firewall it to localhost / office LAN only**.
- Bridge ↔ CRM authenticated with a **dedicated agent token** (rotate-able), not a user
  session, scoped to the `/api/tally/*` routes only.
- No Tally credentials are stored anywhere in the CRM.
- All bridge↔CRM traffic over **HTTPS**.
- Webhook signature verification on Razorpay stays as-is.

---

## 10. Phased rollout

Even though scope is "full sync," build and prove in order — the plumbing is the risky 80%.

**Phase 0 — Connectivity (DONE-ish)**
- ✅ Connection test passes on the Tally server (port open).
- ⏳ Confirm full XML round-trip (company name returned with company loaded).

**Phase 1 — Sales invoices, one-way (CRM → Tally)**
- Bridge skeleton + auth + queue.
- Party master sync.
- Sales voucher post → invoice number + IRN back → CRM mirror.
- Razorpay link + pdf-lib QR overlay + send.
- Status dashboard + alerts.
- *Gate: a real finalized statement issues a real Tally GST invoice end-to-end.*

**Phase 2 — Payments both ways**
- Online: webhook → receipt voucher to Tally.
- Manual: bridge reads Tally receipts → marks CRM Paid → stops follow-up.
- Dedup, partial payments, unmatched-receipt handling.

**Phase 3 — Credit notes (voids)**
- Void flow emits a Tally CRN; CRM mirrors it.

**Phase 4 — Hardening**
- Idempotency soak test, failure-injection (Tally off / no internet), reconciliation report.

---

## 11. Open items — needed from Vinit

1. **Tally version** (Tally Prime release) + a **sample sales-voucher XML import** and an
   **e-invoice response** from the current setup → pins the exact envelope shape.
2. **Ledger names** for each income head, tax head, round-off, and party-naming convention.
3. **Voucher series** Tally uses for GST sales (so `TWV-BS-####` is demoted to internal ref).
4. **HSN/SAC** — confirm `997212` covers all current billing.
5. **B2C handling** — confirm walk-ins / no-GSTIN post as plain sales vouchers without IRN.
6. **Server specs / access** to install Node + the Windows service.
7. **TallyVault** — is a company password set? Who unlocks after reboot?

---

## 12. Out of scope (for now)

- Purchase / vendor bill sync into Tally (procurement side).
- Inventory / stock items (TWV is service-only).
- Multi-GSTIN / multi-entity (single seller GSTIN today).
- Historical backfill of past invoices into Tally.
