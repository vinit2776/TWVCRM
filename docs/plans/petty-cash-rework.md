# Petty Cash rework — receipts, approvals, ledger, analytics

Status: **plan only, nothing built.** Interactive before/after: `mock-petty-cash-before-after.html` (repo root; open in a browser).

## 1. What exists today (read from the code, 2026-11-20)

Tables (`00064`): `petty_cash_books` (one per user, a single `current_balance`), `_requests` (funding in; has `issuance_proof_url`), `_entries` (spend out; has `receipt_url`), `_approvals` (audit), `_categories`.

Flow: employee requests funds → manager/admin/accounts approves → accounts issues (in **Accounting → Petty Cash**) → balance goes up. Employee logs expense → manager approves (≥ ₹5,000 needs a second approval from admin/accounts) → balance goes down. A daily day-book email goes to accounts/admin.

### Gaps found

| # | Gap | Where |
|---|-----|-------|
| 1 | **No upload anywhere.** `receipt_url` and `issuance_proof_url` columns exist; neither form can set them. | `entries-tab.tsx`, `petty-cash-issuance.tsx` |
| 2 | **Analytics undercount.** The tab fetches one page (API caps `limit` at 50) and sums in the browser, so past 50 approved expenses totals are silently wrong. | `analytics-tab.tsx`, `entries/route.ts` |
| 3 | Analytics has no per-person, per-location, trend, receipt-compliance or export. Entries have no location. | — |
| 4 | Approver decides blind: no receipt, balance, history or flags; one dialog per item; no bulk. | `approvals-tab.tsx` |
| 5 | **No self-approval guard.** A manager/admin can approve their own entry. Accounts can approve fund requests (route allows it). | `entries/[id]/route.ts`, `requests/[id]/route.ts` |
| 6 | **Balance is read-then-write** (`current_balance` edited in place), against the project's own atomic-RPC rule; two concurrent approvals can lose an update. Balance can go negative with no warning. No statement, so a mismatch can't be traced. | both `[id]` routes |
| 7 | The ₹5,000 second-approval threshold is hard-coded; approver isn't told why an item is "2 stages". | route + UI |
| 8 | Requester can't see where a request is; issuing lives in a different module. | — |
| 9 | Rejected entries can be resubmitted but not with a changed receipt. | `resubmit` action |

## 2. Proposal

Design principles: uploads are **optional** (warn, never block — house rule "Warnings Are Never Dead Ends"); every warning links to its fix; balances derive from an immutable ledger; fix the analytics bug first because it is wrong today.

### A. Bills & proof of payment (optional)
- New table `petty_cash_attachments` (`id, entry_id | request_id` (exactly one), `kind` = `receipt | payment_proof | other`, `storage_path`, `file_name`, `mime_type`, `size_bytes`, `uploaded_by`, `created_at`). RLS on, `SELECT` for authenticated.
- Store the **storage path, never a URL**; mint signed URLs on read. (`getPublicUrl()` on the private `crm-documents` bucket 400s — the trap that killed the GST WhatsApp sends.)
- Upload route follows `facility/assets/[id]/photos`: `normalizeUploadServer`, sharp resize for images, PDF passed through, bucket `crm-documents`, path `petty-cash/{entry|request}/{id}/{ts}-{name}`. Limits: 5 files, 10 MB each, image/PDF only.
- Who can add: submitter (while pending or rejected, and later via "Add receipt"), accounts/admin any time; request proofs by accounts/admin at issue. Every add/remove → `logAudit`.
- Existing `receipt_url` stays readable (legacy); new uploads go to the table. Backfill optional.
- Nudge: amount ≥ `app_settings.petty_cash_receipt_nudge_amount` (default ₹1,000) with no attachment → amber chip for submitter, approver and accounts; clears itself when a file is attached.

### B. Approval flow
- Replace the flat list with an **inbox**: queue left, detail right — receipt inline, balance before/after, person's usual spend in that category, flags (no receipt over threshold, same amount logged recently, ≥2× usual, weekend), approval path ("Manager, then Admin/Accounts because ≥ ₹5,000").
- **Approve all clean**: ≤ ₹1,000, receipt present, no flags, not own. Per-item audit rows still written.
- Reject needs a reason (preset chips + free text); the submitter sees it and can resubmit **with attachments edited**.
- **Self-approval blocked** server-side for entries and requests (`submitted_by/created_by !== approver`); the UI shows the row locked with the reason. Accounts can't approve fund requests unless also admin/manager (confirm — see questions).
- Threshold moves to `app_settings` (`petty_cash_second_approval_amount`, default 5000).

### C. Requests & issuing
- Request **timeline** (requested → approved → issued → in book) on the requester's page and the accounts screen.
- Issue form gets optional proof upload and shows book balance before/after. Still done by accounts/admin; the Accounting entry point stays, linking to the same screen.

### D. Ledger (makes balances trustworthy)
- New `petty_cash_ledger` (`book_id, kind` = `issue | spend | reversal | adjustment | return`, `amount` signed, `entry_id/request_id`, `created_by`, `created_at`); no UPDATE/DELETE policy. `current_balance` becomes a cached sum maintained **inside** the RPCs.
- RPCs (service role only, `FOR UPDATE` lock): `pc_approve_entry`, `pc_issue_request`, `pc_reverse_entry`. Replace the read-then-write in both routes.
- Negative balance: warn at submission ("over what you hold"), allowed at approval only with a note (warn, don't block).
- Book statement view with running balance and proof icon per row. A correction is a new row, never an edit. Migration backfills one `opening` row per book equal to today's balance, so history starts reconciled.

### E. Analytics for management
- New `GET /api/petty-cash/analytics` that **aggregates in SQL** (fixes gap 2). Filters: period, person, category, location. Returns totals, weekly trend, by-category, by-person (with receipt %), receipt coverage (₹ and count), cash in hand per book, top expenses.
- UI: KPI row, trend, category and person drill-downs (click to filter), the expenses behind the numbers, CSV export of the current filter.
- Needs `location_id` on books and entries (default from the person's location; see questions).
- Optional later: per-person monthly limit and "book below ₹X" alert to accounts.

### F. Notifications
Staff-only, in-app + existing day-book email: add "expenses without receipt" and "books below threshold" lines. No customer is ever messaged by this module.

## 3. Delivery — four small PRs

| PR | Contents | Migration | Risk |
|----|----------|-----------|------|
| 1 | **Analytics fix** (server aggregation, filters, export) — corrects wrong numbers today | `location_id` columns (nullable) | low |
| 2 | Attachments: table, upload/read routes, UI on log/resubmit/issue, nudge setting | attachments + settings | low |
| 3 | Approval inbox + self-approval guard + threshold setting | none/settings | medium (behaviour change for approvers) |
| 4 | Ledger + atomic RPCs + statement view + timeline | ledger + RPCs + opening backfill | **highest** (money) — staging first, verify balances match before prod |

Next free migration number is ≥ 00734 on `main` — re-run `node .github/scripts/check-migration-numbers.mjs` at build time. Staging migrations are mine to apply; prod ones are applied after merge per the usual rule. Update `docs/modules/accounting.md`/help content and the CLAUDE.md role table (self-approval rule, accounts on requests) in the same PRs.

## 4. Verification plan
Staging with the amber banner: click through each role (seeded logins) — log with/without file, reject → resubmit with a new file, approve below/above threshold, self-approve attempt (expect refusal), issue with proof, compare ledger sum to book balance, analytics totals vs a direct SQL sum over >50 expenses, CSV row count. Concurrency check on the RPC (two approvals at once).

## 5. Decisions (Vinit, 2026-11-20)
1. Receipt nudge: ₹1,000 and above, one setting for all categories.
2. Location lives on each **expense** (defaults to the person's usual location); books stay per person.
3. Accounts **only issue** fund requests; admin/manager approve. (Route change in PR 3; update the CLAUDE.md role table.)
4. Second approval stays at ₹5,000 as an `app_settings` value; admin alone may approve in one step.
5. Ledger opens from each book's current balance (one `opening` row).
6. Month-end cash count is **later**, not in these four PRs.

Next step: start PR 1 (analytics fix) on its own branch/worktree.
