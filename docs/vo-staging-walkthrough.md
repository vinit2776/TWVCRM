# Virtual Office lifecycle: staging walkthrough

Branch under test: `integration/vo-lifecycle` (18 PRs, #1218 to #1235, merged in order).
Verified before this script: type check clean, 3,083 tests pass, production build passes.
**Not yet verified by anyone:** the screens, the routes against a real database, and every PDF. That is what this walkthrough is for.

Use only **staging data and a staging database**. Do not run any step against production, and do not send anything to a real customer: use test emails and test phone numbers you control.

Mark each step Pass / Fail / Blocked in the checklist at the end. A Fail on a step marked **PDF** or **MONEY** blocks the release of that PR.

---

## 0. Before you start

### 0.1 Deploy
- Deploy `integration/vo-lifecycle` to staging (Vercel preview of the branch, or merge it into the `staging` branch if that is what staging deploys from). **Deploy first, migrate second.**
- Confirm the app loads and you can sign in as an admin.

### 0.2 Apply migrations, in this order, to the staging database
`00677`, `00678`, `00679`, `00680`, `00681`, `00682`, `00683`, `00684`, `00685`, `00686`, `00687`, `00688`, `00689`, `00690` (all are in `supabase/migrations/`).

Notes:
- Apply `00682` **before** `00683`, and `00680` **before** `00689`.
- `00682` and `00684` add enum values and **cannot be rolled back**. Fine on staging.
- `00680` drops and recreates the `billing_statements.statement_type` CHECK constraint. Before applying, run
  `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'billing_statements'::regclass and contype = 'c';`
  and confirm the existing list of allowed types matches what the migration re-creates (it adds only `vo_holdover`).
- `main` already has migrations up to `00698` and `00721`. If you use `supabase db push` it may refuse the lower numbers without `--include-all`; applying the SQL by hand avoids that.
- After applying, re-open any page that was open: schema caches can be stale.

### 0.3 Settings
Everything new is **off** by default. Set these in `app_settings` on staging (SQL editor, or the admin settings page if the key is exposed):

| Key | Value for the walkthrough | Used in section |
|---|---|---|
| `vo_terms_library_mode` | `on` | 5 |
| `vo_draft_gate_mode` | `enforce` | 6 |
| `vo_agg_billing_mode` | leave `legacy` first, then `once_per_tenure` in section 8 | 8 |
| `vo_address_watch_mode` | `dry_run` (then `live` only in 11.4) | 11 |
| `vo_holdover_clause_approved` | `false` first, then `true` in 11.4 | 11 |
| `vo_proposal_expiry_cron_mode` | `dry_run` | 3 |
| `vo_renewal_cron_mode` | leave as is (`dry_run`) | 9 |

Settings are cached briefly. Wait about a minute after changing one, or restart the preview.

### 0.4 Test data
Create these before you start. Use obviously fake names (prefix `ZZ TEST`).
- **Users:** one each of admin, manager, sales_rep, accounts. You will switch between them.
- **Locations:** at least two (so you can test the exact-location rate and the "Any" fallback).
- **Direct lead** "ZZ TEST Direct Co" with a test email you can read.
- **Aggregator** "ZZ TEST Partner" with billing method postpaid, and a second aggregator "ZZ TEST Prepaid Partner" with prepaid.
- **Cron secret:** you need `CRON_SECRET` for staging to call cron endpoints with `Authorization: Bearer <secret>`.

---

## 1. Rate cards (PR 4, 5)

**1.1 Direct card** (`/admin/vo-rate-cards`, as manager)
1. Add a rate: purpose `gst_new`, location A, term 12 months, guide 18,000, floor 14,000.
2. Add the same purpose with location "Any", term 12, guide 20,000, floor 15,000.
3. Add `gst_new`, location A, term 24: guide **18,000** (this is the ANNUAL rate for terms above 12 months).
4. Revise one rate and confirm a new version appears and the old one stays in history.
Expected: saved, versioned, sales_rep sees it read-only (check by signing in as sales_rep: no edit controls).

**1.2 Aggregator card**
1. For "ZZ TEST Partner" add an open-share row (share %) for location A, and a fixed-price row for "Any".
2. Use "copy from another aggregator", then edit.
Expected: rows saved; existing old aggregator rate cards still work.

---

## 2. Terms library (PR 6)

(`/admin/terms-library`, as admin)
1. Confirm the seeded clauses T01 to T13 exist and are **unapproved**.
2. Edit one clause, approve it, confirm a new version is created. Approve the clauses you want in the proposal (leave **T13, the holdover clause, unapproved** for now).
Expected: versions kept, approvals recorded.

---

## 3. Direct VO proposal (PR 7, 8, 10)

**3.1 Create** (lead "ZZ TEST Direct Co", as sales_rep, "New VO Proposal")
1. Choose purpose `gst_new`, location A, term 12. The guide, floor, suggested ask and trend should appear **before** you type a price.
2. Enter a quote of 17,000 (between floor and guide). Expected: no approval needed.
3. Try a term of 24: the form labels the rate as per-year, and the whole-term amount is 2 x the annual rate.
4. Choose a purpose/location/term with **no** rate card row. Expected: submit is blocked with a clear message (no silent zero).
5. Enter a quote **below the floor**. Expected: a reason is required.
**MONEY:** confirm the proposal total shown equals the whole-term fee (24 months at 18,000 annual = 36,000 before GST) and GST is 18%.

**3.2 Below-floor approval** (PR 8, 10)
1. Submit the below-floor quote. Try to send the proposal. Expected: sending is **blocked** until approved.
2. As manager, check you received an in-app notification and an internal email, and that `/approvals` shows a "VO Below-Floor Quotes" section with quoted vs floor.
3. Approve it. Send the proposal. Expected: now allowed.
4. Change the price after approval and try to send again. Expected: blocked again (an older approval does not carry over to a changed price).
Note: no customer email should have gone anywhere except the staging test address you set.

**3.3 Customer page** (`/vo-proposal/<token>`; staff can copy the link from the proposal page)
1. Open the link in a private window (not signed in). Expected: proposal details, and the terms list if `vo_terms_library_mode` is on and the proposal was sent after turning it on.
2. Use "Request changes" (a note is required). Expected: status `changes_requested`.
3. As staff, **Reissue**. Expected: a new revision supersedes the old one, zero deposit, a fresh draft.
4. Send the new revision, open its link, **Decline** a second test proposal. Expected: `declined`.
5. On a third, **Accept**. Expected: `accepted`; no payment link or message is sent automatically (the signer-details step after acceptance is a known follow-up, not built).
6. **Withdraw** a proposal from the staff page. Expected: status `withdrawn`, customer link no longer accepts.

**3.4 Expiry**
1. Set a proposal's `expires_at` to the past in the database.
2. Try to accept from the customer link. Expected: refused as expired, even before the cron runs.
3. Call the cron: `GET /api/cron/vo-proposal-expiry?dry_run=1` with the bearer secret. Expected: it reports what it would expire, changes nothing.

**3.5 Standard proposals** (regression)
Create and send a normal (non-VO) proposal. Expected: behaves exactly as before, including the deposit and OTP-waiver rules.

---

## 4. KYC review (PR 1, 2)

(Open a VO case for the accepted customer; the KYC panel sits under the documents tab.)
1. As sales_rep, run checks with a **mismatching** PAN/GSTIN and company name, and record a portal check as "mismatch" with a note.
2. Expected: warnings are shown, nothing is blocked.
3. As manager, try to sign off **without** acknowledging a warning. Expected: refused, listing what is missing.
4. Acknowledge each warning with a reason of at least 10 characters. Expected: sign-off succeeds, `kyc_reviewed` set.
5. Re-run the checks. Expected: the existing sign-off is cleared.
6. Check the Aadhaar field shows only the masked number anywhere it appears (UI, API response, audit log).
7. Existing KYC waiver and the weekly reminder digest still work as before.

---

## 5. Purposes (PR 3)

1. Create a case with purpose `gst_new` and another with `gst_existing`. Expected: each gets the KYC checklist and agreement template of its legacy twin (`gst_registration`, `branch_office`).
2. Create a case with a legacy purpose (`mca_registration`). Expected: unchanged.
3. Note: the case form default is still `gst_registration` on purpose.

---

## 6. Case creation and price snapshot (PR 8)

1. Create a **direct** case. Expected: a price snapshot (card version, guide, floor, quoted) is stored on the case. Edit the rate card afterwards: the case snapshot does not change.
2. Create a case for "ZZ TEST Partner" in a location with an aggregator card row. Expected: the aggregator's price is used; the snapshot records open/fixed pricing.
3. Create a case for that aggregator in a location **without** a row. Expected: blocked with a clear message. Create one for an aggregator with **no** rows on the new card: expected to behave as before.

---

## 7. Agreement, terms, and the draft gate (PR 9, 13)

**7.1 Terms in the agreement** (`vo_terms_library_mode = on`)
1. Generate the agreement for the direct case.
2. **PDF:** open it. Under "SPECIAL CONDITIONS" you should see only **approved** clauses, with the term, fee and dates filled in. No unfilled `{placeholders}`.
3. Edit a clause in the library afterwards and regenerate/re-open the issued agreement. Expected: the issued agreement text does not change (it is a frozen snapshot).
4. With the mode set to `off`, generate another: expected output identical to today.

**7.2 Draft before payment** (`vo_draft_gate_mode = enforce`)
1. On a **direct** case with an unpaid case invoice, before the customer has accepted: try to hand out the draft. Expected: refused.
2. After acceptance **and** a reviewed KYC: hand out the draft. **PDF:** the draft carries a diagonal watermark reading "DRAFT, not for signing".
3. Try to send for signing, apply the seal/stamp, or take the clean copy while unpaid. Expected: locked everywhere the execution gate applies (the gate is checked at six call sites; try every route that sends for signing, seals or stamps, or produces a clean copy, and note any that still lets it through).
4. Record a **part** payment. Expected: still locked.
5. Mark the case invoice paid in full. Expected: everything unlocks.
6. As admin, use the payment override with a reason. Expected: allowed, and the reason appears in the audit log.
7. For a **postpaid aggregator** case: expected to be exempt from the payment requirement.

---

## 8. Aggregator billing and the rate meaning (PR 14, 16, 17)

**MONEY / PDF. Do this one carefully.**

**8.1 Case invoice** (direct case, "Generate invoice")
1. 12-month case, rate 18,000: **PDF**: Qty 1 x Rate 18,000 = Amount 18,000, GST 3,240, total 21,240. Same as today.
2. 24-month case, annual rate 18,000: **PDF**: Qty 1 x Rate 36,000 = Amount 36,000, GST 6,480, total 42,480.
3. 36-month case at 18,000: Amount 54,000.

**8.2 Monthly aggregator run, legacy mode** (`vo_agg_billing_mode = legacy`)
1. Note what the postpaid aggregator invoice would bill for a 24-month case with annual rate 18,000. In legacy mode it bills the raw rate **every month** (this is the known over-billing).

**8.3 Preview, then once-per-tenure**
1. Call `GET /api/aggregator-invoices/billing-preview` (as admin). Expected: a read-only comparison of legacy vs once-per-tenure per case.
2. Review the numbers with accounts. **Do not flip the setting until the preview is signed off.**
3. Set `vo_agg_billing_mode = once_per_tenure`, run the monthly job for the period containing the term start. **PDF:** a 24-month case bills **36,000 once** in the first period and nothing in later months; Qty x Rate = Amount on every line.
4. Run the job again for the same period. Expected: no duplicate (the billed-terms ledger prevents it).
5. Known risks to confirm with the owner: a term whose first period was never invoiced is not picked up later, and a term already billed monthly can be billed again because the ledger starts empty.

**8.4 Rounding**
Renew or create a 36-month case with a total fee of 25,000. Expected: annual rate stored as 8,333 (nearest rupee), and the term fee computes to 24,999. Confirm this is acceptable.

---

## 9. Renewals (PR 15, 16, 17)

1. Open `/cases/renewals`. Expected: tabs including Active/renewed, a "needs action" toggle, a read-only drawer showing the notice schedule.
2. Confirm the sales owner is copied on reminders, and accounts from R4 (check the recipient preview in the drawer, **do not let real sends go out**; the renewal cron stays in `dry_run`).
3. **Start renewal** on a 24-month case (annual rate 18,000) for 12 months, then for 24 months. **MONEY / PDF:** the offer and proforma show 18,000 and 36,000 respectively. Compare to the dialog.
4. Pay the 24-month renewal (use the staging payment link / test mode). Expected: the new case row stores the annual rate (18,000 for a 36,000 fee), and an immediate re-renewal quotes consistently.
5. **Partner renewal** on a postpaid partner case, for 12 and 24 months with agreed, none and custom escalation. Expected: "Fee now (N months)", "Fee for the new term (M months)", and an "Annual rate" row above 12 months; the rolled case stores the annual rate.
6. Confirm the renewal payment link is the **same** across reminders (intentional).
7. Open question to settle in the room: a partner renewal that moves from a 6-month to a 24-month term quotes 2x the escalated rate, whereas a direct renewal scales pro rata. Which is right?

---

## 10. Non-renewal checklist (PR 18)

(A lapsed case with a **discontinue** decision, as manager.)
1. The checklist appears next to the discontinuation documents. Walk the steps in order: services off, notice drafted and approved, delivered, customer confirmation.
2. Try to mark a step out of order. Expected: refused.
3. After 15 days (set `confirmation_requested_at` back 16 days in the database), expected: overdue, and the **second request is only drafted**, shown read-only, never sent.
4. GST portal check: for `gst_new`/`gst_registration` (principal place), expect the "alternative principal place or cancel registration" wording; for `gst_existing`/`branch_office` (additional place), expect "amendment". For other purposes, "Not needed".
5. Mark the portal check "still shows our address", then re-mark it cleared. Expected: allowed.
6. Release badge moves not released, awaiting confirmation, confirmed, released.
7. As sales_rep: expected to be unable to mark steps.

---

## 11. Address watch and holdover (PR 11, 12)

**11.1 Evidence** (a lapsed case, as accounts or manager)
1. Record a public-record check: source GST portal, finding `found_using`. Expected: shown in the evidence trail, oldest first.
2. Record `not_found` from a weak source (e.g. a search engine). Expected: stored as inconclusive, not clear.

**11.2 Dry run** (`vo_address_watch_mode = dry_run`)
1. `GET /api/cron/vo-address-watch` with the bearer secret.
2. Expected: a report of what it **would** do, including `wouldCreate`, cases needing a check, and partner-billed cases listed as "needs a person". Nothing is created.

**11.3 Clause gate**
1. Set `vo_address_watch_mode = live` with `vo_holdover_clause_approved = false`. Run the cron.
2. Expected: it reports the cycle as **blocked** and creates nothing.

**11.4 Live, drafts only** (only after the legal text is approved, otherwise skip)
1. Set `vo_holdover_clause_approved = true`, mode `live`. Run the cron once.
2. Expected: a **draft** `vo_holdover` statement is created for a case with the address still in use. The uplift is 25% and +10% every 3 months, capped at 60%, with GST split CGST/SGST.
3. **PDF / MONEY:** preview the draft proforma: Qty x Rate = Amount, correct uplift for the cycle, due date 7 days out.
4. Run the cron again for the same period. Expected: no second draft.
5. Nothing is sent to the customer. A person approves and sends through the normal flow.

**11.5 Release**
1. With two clear checks at least 7 days apart (or deregistration proof recorded), mark the address released. Expected: allowed and audited.
2. Release with fewer checks. Expected: refused.

---

## 12. Cross-cutting checks

- **Audit log:** each mutation above has an entry with the right actor (customer actions show actor "customer").
- **Roles:** sales_rep cannot edit rate cards or sign off KYC; only admin/manager mark non-renewal steps.
- **Deploy-before-migration:** (optional) point a second preview at a database **without** the new migrations. New panels should hide and new POSTs should return 503/409, not 500.
- **No customer sends:** check the email and WhatsApp logs. Nothing should have gone out except to your test addresses.
- **Old flows:** a standard proposal, an existing case's agreement, an existing renewal and a normal aggregator invoice all behave as before with every new setting at its default.

---

## 13. Checklist

| # | Area | Pass / Fail / Blocked | Notes |
|---|---|---|---|
| 1 | Direct and aggregator rate cards | | |
| 2 | Terms library | | |
| 3 | VO proposal: create, approval, customer page, expiry | | |
| 4 | KYC two-step review | | |
| 5 | Purposes | | |
| 6 | Case price snapshot | | |
| 7 | Agreement terms, draft gate **(PDF)** | | |
| 8 | Case invoice, aggregator once-per-term **(PDF, MONEY)** | | |
| 9 | Renewals and partner renewals **(PDF, MONEY)** | | |
| 10 | Non-renewal checklist | | |
| 11 | Address watch, holdover draft **(PDF)** | | |
| 12 | Cross-cutting | | |

## 14. Decisions to make during the walkthrough

1. Partner renewal moving between short and long terms: scale pro rata (4x) or quote 2x?
2. A paisa of rounding on whole-term fees (nearest rupee): acceptable?
3. "Monthly Rate" label on the case page: change to "Rate"?
4. Make a missing aggregator rate block for **all** aggregators, or only those with rows on the new card?
5. Legal sign-off on the holdover clause (T13) and on the seed text of T03 ("No deposit is taken").
6. When to flip `vo_agg_billing_mode`, after the preview review.
7. Which known follow-ups to schedule: signer details after acceptance, proposal email link to the customer page, proper dialog for withdraw reasons, sidebar entries for the two new admin pages, making `cases.purpose` optional at creation.
