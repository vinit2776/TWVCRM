# Tally Handoff Redesign — Human-Mediated Flow

**Status:** Draft for review
**Owner:** Vinit
**Last updated:** 2026-06-12
**Supersedes:** `tally-billing-redesign.md` (kept for history; do not implement against it)
**Affects:** `tally.md`, `tally-integration-design.md`, `tally-integration-status.md`, `tally-go-live-runbook.md` — these become "how the bridge writer USED to work" once this design ships.

---

## 1. Problem & goal

The bridge writer (CRM → Tally voucher creation) has shipped 5 versions in 2 days
(v1.3.2 → v1.3.13). Each release needs an on-site visit to the Tally server.
Recent fixes: XML entity decoding for `&` in party names, voucher read-back retry
for Tally commit lag, local-time dates, party_master auto-create races, `&` in
company names blocking ALL syncing. The writer is brittle by nature — a real-time
XML pipe into a desktop app maintained at v1.3.x with weekly patches.

The business outcome is simple:
- Customer gets a compliant GST invoice with IRN
- We collect money
- Accounts has clean Tally books
- CA has reconciled records at quarter-end

None of that requires the CRM to speak Tally XML in real time.

**Goal:** replace the bridge **writer** with a human-mediated handoff via a new
`/accounting/inbox` page in the CRM. Keep the bridge as a **reader** for nightly
verification. Reuse the existing state machine, charge engine, billing statement
schema, and Razorpay flow.

---

## 2. Core principle: humans bridge, machines verify

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  CRM (system of record for customer relationship)                     │
 │  - billing_statements (unchanged)                                     │
 │  - charge engine (unchanged)                                          │
 │  - Razorpay + dunning (unchanged)                                     │
 │  - NEW: /accounting/inbox (worklist for accounts)                     │
 └──────────────────────────────┬───────────────────────────────────────┘
                                │ email notification + inbox task
                                ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │  Accounts team (humans, in the loop)                                  │
 │  - Reads inbox in CRM                                                 │
 │  - Creates GST invoice in Tally (manual, owns numbering + IRN)        │
 │  - Uploads PDF back to inbox; CRM autofills number + IRN              │
 │  - Records receipts in Tally when payments land                       │
 └──────────────────────────────┬───────────────────────────────────────┘
                                │ read-only XML/ODBC pull (no writes)
                                ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │  Tally (system of record for statutory books + IRN)                   │
 │  - Voucher list (read)                                                │
 │  - Receipt list (read)                                                │
 │  - Party master (read)                                                │
 └──────────────────────────────────────────────────────────────────────┘
                                ▲
                                │ nightly + on-demand sync
                                │
 ┌──────────────────────────────┴───────────────────────────────────────┐
 │  Bridge v2 (READ-ONLY)                                                │
 │  - Pulls voucher/receipt/party snapshots                              │
 │  - Stores in tally_voucher_snapshots table                            │
 │  - Powers verification badges in inbox                                │
 └──────────────────────────────────────────────────────────────────────┘
```

Tally is downgraded from a peer system to a verified mirror. CRM is the customer
system of record. Accounts is the only thing that writes to Tally — and they do
it in Tally directly, the way they always knew how.

### Hard invariant: the bridge is READ-ONLY

This is non-negotiable and applies to every flow in this document:

- **The bridge never POSTs to Tally.** No XML write requests. No voucher creation.
  No receipt creation. No credit note creation. No party master creation. No IRN
  generation calls. Nothing that mutates Tally state, ever, under any condition.
- **The bridge only READS from Tally** — voucher list, receipt list, party master,
  custom fields — and POSTs those snapshots to the CRM.
- **All writes into Tally are made by humans (accounts) using Tally's own UI.**
  The CRM may notify, prompt, surface a worklist, and verify after the fact, but
  it never automates a write.
- This invariant is what makes the bridge boring and stable. The moment we add
  a write path, we are back to v1.3.13 territory — race conditions, on-site
  visits, weekly patches. Don't.

---

## 3. What changes (the smallest possible diff)

### Reused unchanged
- `billing_statements` table and its lifecycle states (`draft → finalized → exported → voided`)
- `tally_sync_status`, `lifecycle_stage`, `issuance_channel` columns
- Charge computation: `generateRentProformas`, `generateUsageStatements`, booking rollup
- Razorpay payment link + webhook + 6-stage `payment-reminder` dunning cron
- D2 (decide once), D3 (deliver once), OV3 (mirror Tally's total) design rules — still hold, just expressed differently
- B2B vs B2C series logic — `SDIPL-REG` for GST-registered, `SDIPL-UNREG` for unregistered
- Contract billing_mode: `proforma_first` | `gst_direct`

### Quarantined (kill switches flipped, code kept dark for 60 days)
- `routeGstGenerationToTally()` — disabled when new handoff is on
- `dispatchTallyInvoice` — replaced by `confirmAndDispatchFromInbox`
- `tally_sync_jobs` writer enqueueing for `sales_voucher`, `receipt_voucher`, `credit_note`, `party_master`
- Bridge polling of `/api/tally/pending` for write jobs

After 60 days of clean run, these are deleted along with `bridge 2/` writer paths.

### New
- `gst_invoice_uploads` table (one row per accountant upload)
- `tally_voucher_snapshots` table (read-only mirror from bridge)
- `/accounting/inbox` page + sidebar entry
- `/api/billing-statements/[id]/upload-gst-invoice` route (autofill cascade)
- `/api/tally/sync-pull` route (bridge posts read-only snapshots)
- Bridge v2 read-only build (strips writers from v1.3.13 codebase)

### Deleted
- `tally-billing-redesign.md` content (kept as file marked superseded; reference
  for history only — do not implement)

---

## 4. The two flows

### 4A. PI cycle (proforma → payment → GST invoice)

For contracts where `contract.billing_mode = 'proforma_first'`.

```
[1] CRM finalizes statement
       │  statement.lifecycle_stage = 'queued'
       │  statement.handoff_state = 'pi_awaiting_payment'
       ▼
[2] CRM issues PI (proforma invoice number from CRM internal series, not Tally)
    Razorpay link generated, dunning starts
       │
       │  customer pays via link OR manual UTR recorded
       ▼
[3] Payment captured
       │  payment_status = 'paid', dunning stops
       │  handoff_state = 'pi_paid_awaiting_gst'
       │  → inbox task created (kind = 'issue_gst_invoice')
       │  → email digest to accounts
       ▼
[4] Accounts creates voucher in Tally (manual, in Tally UI)
    For B2B: generates IRN in Tally via NIC portal
    For B2C: no IRN needed
       │
       ▼
[5] Accounts uploads PDF to /accounting/inbox
    CRM autofills invoice_number + IRN via QR/text parse
    Name check vs contract runs automatically
       │
       │  if mismatch → handoff_state = 'name_check_pending'
       │  if amount mismatch → BLOCK send, surface red banner
       │  if all match → handoff_state = 'ready_to_send'
       ▼
[6] Accounts clicks "Save & send to customer"
       │  CRM dispatches GST invoice PDF (email + WhatsApp)
       │  handoff_state = 'gst_sent'
       │  lifecycle_stage = 'sent'
       │  tally_delivered_at = now() (D3 gate closed)
       ▼
[7] DONE
```

**Critical:** the payment-followup-stop happens at step 3, BEFORE the GST invoice
is issued. This is correct — the customer has paid; they don't need reminders.
But it creates the SLA window we need aging alerts for (step 5 must complete
within 48h or escalate).

### 4B. Direct GST cycle (no PI)

For contracts where `contract.billing_mode = 'gst_direct'`.

```
[1] CRM finalizes statement
       │  statement.lifecycle_stage = 'queued'
       │  statement.handoff_state = 'direct_gst_requested'
       │  → inbox task created (kind = 'issue_gst_invoice_direct')
       │  → email digest to accounts
       ▼
[2] Accounts creates voucher in Tally + generates IRN if B2B
       │
       ▼
[3] Accounts uploads PDF to /accounting/inbox
    Same autofill cascade as PI flow
       │  handoff_state = 'ready_to_send' (or name_check_pending)
       ▼
[4] Accounts approves; CRM auto-generates Razorpay link, dispatches to customer
       │  handoff_state = 'gst_sent_awaiting_payment'
       │  lifecycle_stage = 'sent'
       │  dunning starts (6-stage cron)
       ▼
[5] Customer pays (link or manual UTR)
       │  payment_status = 'paid', dunning stops
       │  handoff_state = 'paid_awaiting_receipt_record'
       │  → inbox task created (kind = 'record_receipt')
       │  → email digest to accounts
       ▼
[6] Accounts records receipt in Tally (manual)
    Marks "Done" in inbox
       │  handoff_state = 'complete'
       ▼
[7] DONE
```

---

## 5. State model

### 5A. New column on `billing_statements`

```sql
ALTER TABLE billing_statements ADD COLUMN handoff_state text;
ALTER TABLE billing_statements ADD CONSTRAINT handoff_state_check
  CHECK (handoff_state IS NULL OR handoff_state IN (
    'pi_awaiting_payment',
    'pi_paid_awaiting_gst',
    'direct_gst_requested',
    'name_check_pending',
    'ready_to_send',
    'gst_sent',
    'gst_sent_awaiting_payment',
    'paid_awaiting_receipt_record',
    'complete'
  ));
CREATE INDEX idx_billing_statements_handoff_state ON billing_statements (handoff_state) WHERE handoff_state IS NOT NULL;
```

`handoff_state` is a **derived workflow state** for the accounts inbox. The
existing `lifecycle_stage`, `tally_sync_status`, and `payment_status` remain
the system-of-record columns; `handoff_state` is the view accounts works against.

### 5B. Mapping to existing columns

| handoff_state | lifecycle_stage | tally_sync_status | payment_status | issuance_channel |
|---|---|---|---|---|
| `pi_awaiting_payment` | `queued` | `not_applicable` | `unpaid` | `crm` (PI) |
| `pi_paid_awaiting_gst` | `queued` | `pending` | `paid` | `crm` |
| `direct_gst_requested` | `queued` | `pending` | `unpaid` | `crm` |
| `name_check_pending` | `issuing` | `pending` | * | `crm` |
| `ready_to_send` | `issuing` | `issued` | * | `tally` (stamped on upload) |
| `gst_sent` | `sent` | `issued` | `paid` | `tally` |
| `gst_sent_awaiting_payment` | `sent` | `issued` | `unpaid` | `tally` |
| `paid_awaiting_receipt_record` | `sent` | `issued` | `paid` | `tally` |
| `complete` | `sent` | `issued` | `paid` | `tally` |

`issuance_channel = 'tally'` is stamped at the moment of upload (step 5 in PI
flow, step 3 in direct GST flow). This preserves the D2 rule: once tally
is stamped, CRM cannot generate its own GST invoice for this statement.

### 5C. Setting handoff_state

A small helper `computeHandoffState(statement)` derives the value from the
existing columns. We store it for index performance and audit, but the source
of truth is still the underlying columns. A backfill migration sets the column
on existing rows.

---

## 6. New tables

### 6A. `gst_invoice_uploads`

One row per accountant upload. Audit trail + autofill source attribution.

```sql
CREATE TABLE gst_invoice_uploads (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_statement_id    uuid NOT NULL REFERENCES billing_statements(id) ON DELETE RESTRICT,
  uploaded_by             uuid NOT NULL REFERENCES auth.users(id),
  uploaded_at             timestamptz NOT NULL DEFAULT now(),

  -- Extracted / entered values
  tally_invoice_number    text NOT NULL,        -- e.g. SD/A/26-27/175 (A) or SD/B/26-27/89 (B)
  tally_invoice_series    text NOT NULL CHECK (tally_invoice_series IN ('SDIPL-REG','SDIPL-UNREG')),
                                                -- SDIPL-REG = A-series (IRN required, customer has GSTIN)
                                                -- SDIPL-UNREG = B-series (no IRN, customer has no GSTIN)
  irn                     text,                 -- 64-char IRN; REQUIRED if series=SDIPL-REG, NULL otherwise
  CONSTRAINT irn_matches_series CHECK (
    (tally_invoice_series = 'SDIPL-REG'   AND irn IS NOT NULL) OR
    (tally_invoice_series = 'SDIPL-UNREG' AND irn IS NULL)
  ),
  invoice_date            date NOT NULL,
  invoice_amount          numeric(12,2) NOT NULL,

  -- Verification
  invoice_pdf_url         text NOT NULL,        -- B2 storage URL
  qr_payload              jsonb,                -- decoded JWT from QR if present
  autofill_source         text NOT NULL CHECK (autofill_source IN ('qr','pdf_text','bridge_match','manual')),
  nic_signature_verified  boolean DEFAULT false,

  -- Name check
  name_check_status       text NOT NULL CHECK (name_check_status IN ('pending','approved','overridden')),
  name_check_decided_by   uuid REFERENCES auth.users(id),
  name_check_decided_at   timestamptz,
  name_check_notes        text,

  -- Audit
  superseded_by           uuid REFERENCES gst_invoice_uploads(id), -- if re-uploaded
  notes                   text
);

CREATE INDEX idx_gst_uploads_statement ON gst_invoice_uploads (billing_statement_id);
CREATE INDEX idx_gst_uploads_irn ON gst_invoice_uploads (irn) WHERE irn IS NOT NULL;

ALTER TABLE gst_invoice_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "accounts_admin_select_uploads" ON gst_invoice_uploads
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid()
            AND role IN ('accounts','admin','office_admin','manager'))
  );
CREATE POLICY "accounts_admin_insert_uploads" ON gst_invoice_uploads
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('accounts','admin'))
  );
```

### 6B. `tally_voucher_snapshots`

Read-only mirror from the bridge. Re-populated on each pull (UPSERT by
voucher_master_id + company).

```sql
CREATE TABLE tally_voucher_snapshots (
  voucher_master_id       text NOT NULL,        -- Tally's REMOTEID
  company_name            text NOT NULL,        -- guard
  voucher_kind            text NOT NULL,        -- sales | receipt | credit_note
  voucher_series          text,                 -- SDIPL-REG etc.
  invoice_number          text,                 -- voucher number
  party_name              text,
  party_gstin             text,
  voucher_date            date,
  voucher_amount          numeric(12,2),
  irn                     text,
  custom_fields           jsonb,                -- narration, cost center, etc.

  -- Linkage to CRM (best-effort match)
  matched_statement_id    uuid REFERENCES billing_statements(id),
  match_confidence        text CHECK (match_confidence IN ('exact','probable','unmatched')),

  -- Sync metadata
  last_synced_at          timestamptz NOT NULL DEFAULT now(),
  sync_batch_id           uuid NOT NULL,        -- so we can tell stale rows from fresh

  PRIMARY KEY (voucher_master_id, company_name)
);

CREATE INDEX idx_voucher_snapshots_invoice ON tally_voucher_snapshots (invoice_number);
CREATE INDEX idx_voucher_snapshots_statement ON tally_voucher_snapshots (matched_statement_id);
CREATE INDEX idx_voucher_snapshots_irn ON tally_voucher_snapshots (irn) WHERE irn IS NOT NULL;

ALTER TABLE tally_voucher_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "accounts_admin_select_snapshots" ON tally_voucher_snapshots
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid()
            AND role IN ('accounts','admin','office_admin','manager'))
  );
-- No insert/update policy: only service role (bridge endpoint) writes here.
```

---

## 7. The /accounting/inbox page

### 7A. Visual spec
See preview rendered during design discussion (2026-06-12). Key invariants:

- One row per pending action, not per statement (a statement can produce both a
  GST-to-issue task AND a payment-to-record task in sequence)
- Inline expandable form, no modal
- Tally column on the right showing verification badge (✓ matched, ⚠ missing, ✗ drift)
- Top stats: GST to issue, Payments to record, Discrepancies, Aging >48h
- "Last synced" timestamp + manual refresh button
- Filter tabs: All open, GST to issue, Payments, Discrepancies

### 7B. Roles + RLS
- View: `accounts`, `admin`, `office_admin`, `manager` (manager read-only)
- Upload + name-check approve: `accounts`, `admin`
- Override name mismatch with reason: `admin` only
- Manual "mark receipt recorded": `accounts`, `admin`

### 7C. Page-level RLS scope
Inbox query returns statements where `handoff_state` is NOT `null` AND NOT `complete`.
Stale items (>30 days, manual override only) drop off but stay queryable via filter.

### 7D. Notification cadence
- **Sidebar badge:** count of open inbox tasks for the current user's role
- **Daily digest email:** 09:30am IST, summary of pending items (no per-event email)
- **Aging escalation:** items in `pi_paid_awaiting_gst` or `paid_awaiting_receipt_record`
  for >48h → ping admin via email digest with red flag

---

## 8. Autofill cascade (the "review-not-entry" form)

When accounts uploads a PDF, the form is filled BEFORE they see it. They review,
they don't type. Three sources, tried in order:

### 8A. QR code scan (most reliable)
- All Indian GST e-invoices (B2B above e-invoicing threshold) have a mandatory
  signed QR on page 1
- Library: `jsqr` against rendered PDF page canvas (use `pdfjs-dist` to render)
- QR payload is a JWT signed by NIC IRP
- Decoded fields used: `DocNo`, `DocDt`, `TotInvVal`, `SellerGstin`, `BuyerGstin`, `Irn`, `IrnDt`
- Optional: verify JWT against NIC public key (well-known) → adds "NIC verified" badge

### 8B. PDF text parse (fallback)
- Library: `pdf-parse` (Node-side) extracts text layer
- Regexes against your Tally template:
  - Invoice number: `/SD\/(A|B)\/\d{2}-\d{2}\/\d+/` — matches both `SD/A/26-27/175` (IRN series) and `SD/B/26-27/...` (non-IRN series). The captured letter determines `tally_invoice_series` (`A → SDIPL-REG`, `B → SDIPL-UNREG`).
  - IRN: `/[a-f0-9]{64}/` (Tally prints IRN as hex below invoice header — only present on A-series invoices)
  - Total: extract from "Total Invoice Value" line
  - Party GSTIN: `/\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2}/`
- Used for: B2C invoices (no QR), PI uploads (no IRN), older Tally templates

### 8C. Bridge match (cross-check)
- If `tally_voucher_snapshots` has a row matching `invoice_amount + party_gstin + date_range`
- Bumps autofill_source to `bridge_match`, adds "✓ matched in Tally" badge
- If QR parse + bridge match agree → highest confidence

### 8D. Manual entry (last resort)
- Scanned image PDF, no QR, no text layer → form fields stay blank
- Optional: tesseract.js OCR behind a "Try OCR" button (slow, opt-in)
- Accounts types invoice_number + IRN; we still run the name + amount checks
  against the contract and Tally snapshot

### 8E. Verification logic at upload time

```
on upload:
  1. extract via cascade → populate form
  2. determine expected series from lead.gst_number:
     - GSTIN present → expect A-series (SDIPL-REG) + IRN required
     - GSTIN absent  → expect B-series (SDIPL-UNREG) + IRN must NOT be present
  3. run checks:
     a. Party GSTIN matches contract.gst_number → ✓ or ⚠ (admin review)
     b. Party name matches contract.client_name (fuzzy) → ✓ or name_check_pending
     c. invoice_amount equals statement.total_amount → ✓ or HARD-BLOCK (no override)
     d. invoice series matches expected (A or B) → ✓ or HARD-BLOCK
     e. IRN presence matches series rule (required for A, forbidden for B) → ✓ or HARD-BLOCK
  4. if all ✓ → handoff_state = 'ready_to_send'
  5. if name fuzzy only → handoff_state = 'name_check_pending' (needs approval)
  6. if any hard-block fires → send button disabled, red banner names the failed check;
     resolution path: re-upload correct PDF, or admin voids the statement and accounts re-issues
```

The form is the **decision surface for accounts**, not the data-entry surface.

---

## 9. Bridge v2 (read-only)

### 9A. What stays from v1.3.13
- All XML readers (`extractAllCompanyNames`, `ledgerExists`, voucher list extraction)
- Day Book / collection reader logic (already tolerant of Tally schema variance)
- B2 client config (for snapshot uploads to CRM)
- Tray launcher, INSTALL.bat, health page
- The `unescapeXml` normalization (hard-won, do not lose)
- Local-time date handling
- Idempotency / dedup logic on snapshot writes

### 9B. What gets ripped out
- `createSalesVoucher`, `createReceiptVoucher`, `createCreditNote`, `createPartyLedger`
- IRN-generation calls (we don't generate; accounts does in Tally portal)
- `tally_sync_jobs` consumer logic (`/api/tally/pending` is no longer polled for writes)
- Ack handlers (`/api/tally/ack`) — kept for 60-day backward compat then deleted
- All retry/lease logic for writer jobs

### 9C. New: snapshot pull

Bridge runs as a tray app on the Tally server (business-hours-on, weekends off).
On a schedule (every 30 min during business hours) plus on-demand from CRM:

```
1. Bridge reads voucher master list for current FY and previous month
   - Sales vouchers (SDIPL-REG, SDIPL-UNREG)
   - Receipt vouchers
   - Credit notes (CREDIT NOTE-REG)
2. Bridge reads party master snapshot (Sundry Debtors only)
3. Bridge POSTs to /api/tally/sync-pull with:
   - sync_batch_id (uuid)
   - company_name (guard: must match tally_locked_company)
   - vouchers[] (full list)
   - parties[] (full list)
4. CRM endpoint:
   - Validates company guard
   - UPSERTs into tally_voucher_snapshots
   - Runs match logic against billing_statements (by invoice_number → IRN → amount+date+party_gstin)
   - Sets matched_statement_id + match_confidence
   - Returns ack: {accepted: N, matched: M, unmatched: U}
```

### 9D. Hosting + ops
- Bridge runs on the Tally server (you confirmed)
- Business hours only (~9am–8pm IST)
- Outside business hours: snapshots go stale; UI shows "last synced 3h ago"
- No write paths means no race conditions, no on-site visits to fix data
- Future updates: bridge gets rebuilt maybe once a quarter to track Tally version
  changes. Read-only bridges are dramatically more stable than write bridges.

---

## 10. Existing design rules — how they survive

| Rule | How it survives the redesign |
|---|---|
| **D2 — Decide once** | `issuance_channel` stamped `tally` at upload time (step 5 in PI / step 3 in direct GST). Same column, same guard, different trigger. |
| **D3 — Deliver once** | `tally_delivered_at` written before email/WhatsApp dispatch. The new `confirmAndDispatchFromInbox` honors the same gate as `dispatchTallyInvoice` did. |
| **D8 — Tally computes tax** | Tally still computes; accounts enters it; CRM mirrors via QR/text parse. The CRM's job is to display, not compute. |
| **OV3 — Mirror Tally's total** | `tally_total_amount` on `billing_statements` is overwritten from the upload's `invoice_amount`. If it differs from CRM's computed total, send is BLOCKED — surfaced as a discrepancy. |
| **Company guard** | Bridge POST to `/sync-pull` includes `x-tally-company` header; validated against `tally_locked_company` setting. Same guard, now applied to reads. |
| **CRM void blocked for Tally invoices** | Unchanged — `issuance_channel='tally'` check stands. Void requires admin + a void note + a separate Tally credit note recorded manually. |

---

## 11. Failure modes & mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Accounts forgets to upload after PI paid | Customer never gets GST invoice | 48h aging alert → admin email digest red flag |
| PDF has no QR + no text layer (scanned image) | Autofill fails | Blank form + "Try OCR" button; manual entry always available |
| Wrong PDF uploaded (different customer) | Caught by GSTIN mismatch check | Red banner: "GSTIN belongs to X, expected Y. Re-upload?" Block send. |
| Tally amount ≠ CRM statement amount | Statement total wrong OR Tally voucher wrong | **Hard-block, no override** (DECIDED 2026-06-12). Send button disabled. Resolution: accounts edits Tally and re-uploads, OR admin voids the CRM statement and accounts re-issues with correct amount. |
| A-series uploaded with no IRN | Customer expecting compliant e-invoice doesn't get one | Hard-block. CRM enforces: A-series number requires IRN field populated. |
| B-series uploaded with an IRN | Wrong series chosen in Tally for a non-GST customer | Hard-block. CRM enforces: B-series must NOT have IRN. |
| Series mismatch (e.g. customer has GSTIN but B-series uploaded) | Compliance failure — GST customer got wrong invoice type | Hard-block. CRM checks `leads.gst_number` against series at upload. |
| Bridge offline (Tally server off) | Snapshots stale | "Last synced 3h ago" badge. No new inbox items affected; only verification freshness. |
| Bridge schema mismatch (Tally version upgrade) | Reader fails for some fields | Tolerant readers: unknown fields → `null`, not crash. Logged + alert. |
| Customer pays via UPI direct to bank (no Razorpay) | Not captured automatically | "Mark payment received manually" with UTR field — existing flow, now feeds inbox |
| Razorpay link expires before payment | Customer link 404s | 30-day expiry on link, "Regenerate link" button on inbox + statement page |
| Accounts uploads wrong PDF, re-uploads | First upload `superseded_by` second, audit chain preserved | Allowed until `gst_sent`; after that, void+reissue path required |
| Two accounts users both work the same item | Race on save | Optimistic lock: `handoff_state` must match expected on save; second save fails with "Already updated, refresh" |
| In-flight bridge writer jobs at cutover | Could double-process | Pre-cutover step: drain `tally_sync_jobs`, mark all `pending` as `cancelled` with note "migrated to handoff flow" |

---

## 12. Migration plan

### 12A. May/early-June in-flight statements
Per your note: handled separately, not in scope of this redesign. Treat them as
the existing flow finishing out under the v1.3.13 bridge. New flow applies to
statements created after cutover.

### 12B. Cutover sequence (one deploy weekend)
1. Deploy CRM with feature flag `tally_handoff_v2_enabled = false`. New tables exist, no behavior change.
2. Drain `tally_sync_jobs`: stop all writer jobs from being enqueued, let bridge finish what's in-flight, cancel remainder.
3. Deploy bridge v2 (read-only) to Tally server. Run initial snapshot pull.
4. Verify `tally_voucher_snapshots` matches Tally manually for ~10 recent vouchers.
5. Set `tally_handoff_v2_enabled = true` AND `crm_gst_enabled = false`. New flow live.
6. Old `tally_sync_enabled` setting becomes informational only — no code path consumes it for writes.

### 12C. Rollback
If anything breaks in the first 72h:
1. Set `tally_handoff_v2_enabled = false`. CRM stops creating inbox tasks for new statements.
2. Manually resolve any in-flight inbox items via the existing `manual correction procedure` in `tally.md` §"Manual correction procedure".
3. Re-enable bridge writers if needed (code still present behind flag).

Rollback window is 60 days — after that, writer code gets deleted.

### 12D. Cleanup (60 days post-cutover, after stable run)
- Delete `bridge 2/` writer paths, ship bridge v2.1 (smaller, read-only only)
- Delete `routeGstGenerationToTally`, `dispatchTallyInvoice`, writer enqueue helpers
- Delete `tally_sync_jobs` consumer logic (table can stay for audit)
- Move `tally-billing-redesign.md` to `docs/archive/`

---

## 13. Phasing (the four PRs)

| PR | Scope | Effort (CC) | Risk |
|---|---|---|---|
| **#1: This design doc + schema (this PR)** | This doc + migration: `handoff_state` enum on `billing_statements`, `gst_invoice_uploads` table, `tally_voucher_snapshots` table, RLS policies. No UI, no behavior change. | ~1 hour | Zero — additive |
| **#2: Inbox MVP (manual entry)** | `/accounting/inbox` page, sidebar entry, filterable worklist, inline upload form (manual fields), email notifications, "Save & send" wired to existing `dispatchTallyInvoice` paths. Feature flag `tally_handoff_v2_enabled` gates visibility. Bridge writer paths feature-flagged off in same PR. | ~3 hours | Low — flag-gated, parallel to bridge |
| **#3: Read-only bridge v2 + verification** | Strip writers from `bridge 2/`, ship as `twv-tally-bridge-v2.0.0-readonly`. New `/api/tally/sync-pull` endpoint. Verification badges + Tally column on inbox rows. | ~3 hours | Low — read-only |
| **#4: Autofill cascade** | QR scan (`jsqr` + `pdfjs-dist`), PDF text parse (`pdf-parse`), bridge-match prefill, "review-not-entry" form variant, GSTIN/amount mismatch hard-block on send. | ~2 hours | Low — fallback to manual always works |

Stretch PRs after #4 (separate, optional):
- **#5:** Aging SLA + escalation alerts
- **#6:** Bulk upload (multiple PDFs at once for same customer)
- **#7:** Contract-page "Issue GST invoice" button for `gst_direct` contracts
- **#8:** Quarterly CA reconciliation report (CRM ↔ Tally diff for FY)
- **#9:** Writer code deletion (60 days post-cutover)

---

## 14. What is NOT in scope

- Auto-IRN fetch from NIC portal (defer until manual is proven painful)
- Bank statement reconciliation automation (Tally owns this)
- Accounts mobile app (desktop inbox is enough)
- Re-introducing any form of write bridge (TODOS if the human flow proves untenable)
- Migrating May/early-June in-flight statements (handled separately)
- Replacing internal PI numbering — CRM keeps owning PI numbers, Tally owns GST numbers
- Touching the charge computation engine (rent, usage, bookings — all untouched)
- Touching the Razorpay flow (untouched)
- Touching the 6-stage dunning cron (only adds a new stop reason)
- Building anything in Tally itself (it's a black box accounts owns)

---

## 15. Open questions for the reviewer

These should be answered in PR review of this doc, before PR #2 starts:

1. **Mismatch resolution UI:** ~~in §11 I describe blocking the send on amount mismatch. Should we offer an "override with reason" path for `admin` role, or hard-block universally?~~ **DECIDED (2026-06-12): hard-block universally, no override.** If Tally amount ≠ CRM amount, the send button is disabled with a red banner. Resolution path is either (a) accounts fixes Tally and re-uploads, or (b) admin voids the CRM statement and accounts re-issues with the correct amount. Schema implication: no `override_reason` column needed on `gst_invoice_uploads`.

2. **Direct GST entry point:** ~~cron-only or also ad-hoc button?~~ **DECIDED (2026-06-12): both.**
   - **Cron path:** monthly billing cron auto-finalizes recurring `gst_direct` statements, creates inbox task with `handoff_state = 'direct_gst_requested'`. Same as today.
   - **Ad-hoc path:** "Request GST invoice" button on the contract detail page, visible only when `contract.billing_mode = 'gst_direct'` and role is `admin`/`accounts`/`manager`/`sales_rep`. Opens a small form (line items, amount, narration), creates a draft statement + inbox task in one shot.
   - Schema implication: `billing_statements.created_via` text column (`cron` | `ad_hoc_request`) for audit. Already partially present via `auto_generated` boolean — extend or replace.

3. **Custom Tally fields in verification view:** ~~Which fields to surface?~~ **DECIDED (2026-06-12): all available custom fields, shown in a collapsible "Tally details" panel on the inbox row detail view.**
   - The inbox row summary still shows just amount + Tally invoice number + IRN badge (compact).
   - Clicking "Tally details" expands a key-value panel rendering every key in `tally_voucher_snapshots.custom_fields` for that voucher: narration, cost center, voucher class, dispatch info, reference details, godown, ledger breakup, anything else the bridge reader extracts.
   - Bridge reader should pull liberally; the CRM can choose what to display. No schema constraint on the jsonb keys — flexibility wins here.

4. **Receipt voucher matching:** ~~auto-complete or manual confirm?~~ **DECIDED (2026-06-12): auto-complete via read-only bridge verification.** Reinforces the core invariant: **the bridge NEVER writes to Tally. Ever. Under any circumstances.**
   - On Razorpay payment capture: CRM marks `payment_status = 'paid'`, dunning stops, **intimation email** fires to accounts with payment details (amount, date, mode, Razorpay payment ID, UTR if present).
   - Inbox row appears in `paid_awaiting_receipt_record` state, showing a **payment confirmation card** with all details from the captured payment.
   - Accounts manually enters the receipt voucher in Tally directly (in Tally UI, not CRM).
   - Next bridge sync (≤30 min during business hours) reads the new receipt voucher, POSTs the snapshot to CRM.
   - CRM matches receipt to statement by `against_voucher` reference + amount + party.
   - On confirmed match: row auto-transitions to `complete`, displays "✓ verified by Tally on `<date>`" badge, stays in the inbox view (under "Recently completed" filter) for 24h then drops off.
   - Manual payment paths (UTR entry, cheque deposit) follow the same flow — payment recorded in CRM → email + inbox card → accounts enters in Tally → bridge verifies → auto-complete.

5. **IRN requirement rule:** ~~Hard-code threshold or make it a setting?~~ **DECIDED (2026-06-12): IRN requirement is per-customer, driven by whether the customer has shared GST with us.**
   - **Customer has `lead.gst_number` populated** → A-series invoice (Tally `SDIPL-REG`, prints `SD/A/26-27/####`) → **IRN is required**. Accounts must generate IRN in Tally via NIC portal before uploading. CRM blocks upload if IRN field is empty for an A-series invoice.
   - **Customer has no `lead.gst_number`** → B-series invoice (Tally `SDIPL-UNREG`, prints `SD/B/26-27/####`) → **IRN is NOT required**. Upload form hides the IRN field for B-series.
   - The series is auto-selected at request-time from `leads.gst_number` presence (same logic already in `tally.md` §"B2B vs B2C routing"). No turnover-threshold setting needed.
   - Schema implication: `gst_invoice_uploads.tally_invoice_series` is constrained to `('SDIPL-REG','SDIPL-UNREG')`; the autofill cascade validates that an A-series number must come with an IRN and a B-series number must not.

---

## 16. References

- `tally.md` — current bridge operational reference, supersedes nothing here; this doc replaces the writer-bridge philosophy it describes
- `tally-billing-redesign.md` — SUPERSEDED, kept for history only
- `tally-integration-design.md` — historical context for D2/D3/D8/OV3 rules; still useful for understanding why those rules exist
- `tally-integration-status.md` — pre-cutover build status; will be archived post-cutover
- `tally-go-live-runbook.md` — pre-cutover runbook for the WRITER bridge; will be archived post-cutover and replaced with a new "Handoff v2 ops" doc

---

## 17. Sign-off checklist

Before PR #2 starts:

- [ ] Vinit reviews and approves §3 (what changes vs reused vs deleted)
- [ ] Vinit reviews and approves §5 (state model + mapping table)
- [ ] Vinit reviews and approves §6 (new tables + RLS)
- [ ] Vinit reviews and approves §12 (migration + rollback)
- [ ] Vinit answers §15 open questions (or marks "decide in PR #2")
- [ ] Sample Tally GST invoice PDF received (for §8 autofill testing in PR #4)
