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
| Local visibility | **Tray icon on the Tally server + health card in the CRM** | Glanceable health on the machine *and* remotely. |

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
 └──────────────────┘    │   └──────┬───────┘  IRN / QR  │ + e-inv   │
        ▲ heartbeat      │          │ tray icon          └───────────┘
        │                │      [🟢 systray]                         │
        └─ health card ──┘                                           │
                         └────────────────────────────────────────────┘
```

**Bridge agent** = a small Node.js service installed on the Tally server, running as a
Windows service (auto-start). It is the only component that talks to Tally. It:

- **Polls** the CRM over HTTPS for pending jobs (outbound only — no inbound firewall holes).
- **Writes** to Tally via `localhost:9000`: party masters, sales vouchers, receipt
  vouchers, credit notes.
- **Reads** from Tally via `localhost:9000`: new receipt vouchers (manual payments).
- **Acks** results back to the CRM (invoice number, IRN, QR, errors).
- **Shows** a tray icon + sends a heartbeat to the CRM (see §7).

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

## 7. Health & monitoring

Health is visible in **two places** — on the server and remotely.

### 7.1 On the Tally server — system tray icon
A coloured dot near the clock, always visible. Click/hover for a status panel:

```
TWV ↔ Tally Bridge   (v1.0.3)
──────────────────────────────
● Tally        Connected (Sree Design… open)
● CRM          Connected
  Pending jobs   0
  Failed jobs    0
  Last sync      2 min ago
──────────────────────────────
[ Test connection ]  [ Retry failed ]  [ Open log ]
```

| Dot | Meaning | Action |
|---|---|---|
| 🟢 Green | Running; Tally + CRM reachable; queue flowing | None |
| 🟡 Amber | Degraded — Tally company closed, internet down, jobs waiting | Usually self-heals; check Tally is open |
| 🔴 Red | Service stopped, or jobs **failed** needing attention | Click → see error → fix / Retry |

### 7.2 In the CRM — remote health card
The bridge sends a **heartbeat** to the CRM every ~60s. The CRM shows a card: "Bridge:
online, last seen 30s ago, 0 failed." If the heartbeat stops, it flips to "⚠️ Bridge
offline" and can alert via email/WhatsApp. Lets you confirm health from anywhere.

> The dot/heartbeat prove the **pipe is open**. The deepest proof — "Tally accepted a
> voucher" — is the invoice status moving to **Issued** on a real invoice. We rely on both.

---

## 8. Local troubleshooting & updates (on the Windows server)

Yes — the bridge is fully serviceable on the server, by you, without needing a developer
on site for routine issues.

### 8.1 Troubleshooting locally
- **Logs:** rotating, timestamped plain-text log files at a fixed path; one click from the
  tray ("Open log"). No PII / secrets written to logs.
- **On-demand self-test:** the tray's **"Test connection"** button reruns the same checks
  as the standalone tester — Tally reachable? CRM reachable? — and shows pass/fail.
- **Service control:** Start / Stop / Restart from Windows **Services** (or the tray).
- **Plain-English errors:** each failed job shows a human-readable reason + suggested fix
  (e.g. "Ledger 'Usage Income' not found in Tally — create it or fix the mapping").
- **Config in one file:** CRM URL, agent token, poll interval, ledger map live in a single
  local config file; a **"Reload config"** action applies edits without reinstalling.
- **Export logs for help:** a "Zip logs" action bundles recent logs to send for diagnosis.

### 8.2 Updates / patches
- **Versioned builds:** the running version shows in the tray (e.g. `v1.0.3`).
- **Manual update (default):** download the new build, run `update.bat`; it stops the
  service, swaps files, restarts. Takes seconds. Tally and its data are never touched.
- **Safe rollback:** the previous version is kept. If a new build fails its startup
  health-check, it **auto-rolls back** to the last good version.
- **Assisted/auto-update (optional, later):** the bridge can check the CRM for a newer
  **approved** version and self-update on a schedule, with the same rollback guard. We'd
  start manual-first and enable auto only once it's proven.
- **Remote diagnosis:** with your OK, the bridge can push recent (PII-free) logs to the CRM
  so issues can be reviewed without remoting into the server.

> Updates change only the bridge agent. They never alter Tally, its company data, or the
> GST invoices already issued.

---

## 9. CRM-side changes

### 9.1 Database (new migration, e.g. `00232_tally_sync.sql`)
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

New table `tally_bridge_health` (heartbeat): `last_seen_at`, `version`, `tally_connected`,
`pending_count`, `failed_count`.

### 9.2 Ledger / Chart-of-Accounts mapping (config in `app_settings`)
Tally posts to named ledgers. The CRM has none today. Need a configurable map:
- charge type → Tally **sales ledger** (e.g. "Space Rent Income", "Usage Income")
- tax → "Output CGST" / "Output SGST" / "Output IGST"
- round-off → "Round Off"
- party-ledger naming convention (e.g. company name + GSTIN)

### 9.3 Bridge API endpoints (token-authenticated, not user session)
- `GET  /api/tally/pending` — bridge claims a batch of jobs
- `POST /api/tally/ack` — write back invoice no. / IRN / QR / voucher GUID, or mark failed
- `POST /api/tally/payments` — bridge reports manual receipts read from Tally
- `POST /api/tally/heartbeat` — bridge health ping (drives the §7.2 card)

### 9.4 Behaviour changes
- **Park** `/api/e-invoice/generate` + `/cancel` (no CRM-side IRN minting).
- **Razorpay link** created after Tally ack; **pdf-lib overlay** of QR + link onto Tally PDF.
- **Void → Credit Note:** the existing void flow queues a CRN job to Tally instead of a
  silent unlink.
- **Online payment → Receipt Voucher** queued on webhook confirmation.

---

## 10. The bridge agent (outside this repo)

- **Runtime:** Node.js (TypeScript), Windows service via `node-windows` / NSSM.
- **Tray UI:** small system-tray app (health dot + status panel + buttons).
- **Builds Tally XML** envelopes: party master, sales, receipt, credit note.
- **Posts** to `http://localhost:9000`, parses responses (incl. e-invoice block).
- **Polls** the CRM endpoints on an interval; backoff + retry on failure.
- **Config:** single local file — CRM base URL, agent token, poll interval, ledger map.
- **Logs** locally (rotating) + heartbeat to the CRM dashboard.
- **Self-update** with rollback (§8.2).

---

## 11. Security

- Tally gateway is unauthenticated → **firewall it to localhost / office LAN only**.
- Bridge ↔ CRM authenticated with a **dedicated agent token** (rotate-able), not a user
  session, scoped to the `/api/tally/*` routes only.
- No Tally credentials are stored anywhere in the CRM.
- All bridge↔CRM traffic over **HTTPS**.
- Logs are PII-free; webhook signature verification on Razorpay stays as-is.

---

## 12. Phased rollout

Even though scope is "full sync," build and prove in order — the plumbing is the risky 80%.

**Phase 0 — Connectivity**
- ✅ Connection test passes on the Tally server (port open).
- ⏳ Confirm full XML round-trip (company name returned with company loaded).

**Phase 1 — Sales invoices, one-way (CRM → Tally)**
- Bridge skeleton + auth + queue + **tray icon + heartbeat/health card**.
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
- Idempotency soak test, failure-injection (Tally off / no internet), reconciliation report,
  self-update + rollback.

---

## 13. Open items — needed from Vinit

1. **Tally version** (Tally Prime release) + a **sample sales-voucher XML import** and an
   **e-invoice response** from the current setup → pins the exact envelope shape.
2. **Ledger names** for each income head, tax head, round-off, and party-naming convention.
3. **Voucher series** Tally uses for GST sales (so `TWV-BS-####` is demoted to internal ref).
4. **HSN/SAC** — confirm `997212` covers all current billing.
5. **B2C handling** — confirm walk-ins / no-GSTIN post as plain sales vouchers without IRN.
6. **Server specs / access** to install Node + the Windows service.
7. **TallyVault** — is a company password set? Who unlocks after reboot?

---

## 14. Out of scope (for now)

- Purchase / vendor bill sync into Tally (procurement side).
- Inventory / stock items (TWV is service-only).
- Multi-GSTIN / multi-entity (single seller GSTIN today).
- Historical backfill of past invoices into Tally.
