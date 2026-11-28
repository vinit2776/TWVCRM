# NOC service for registering a company at a TWV centre

Status: plan and mock only, nothing built. Mock: `mock-noc-service.html` (8 clickable screens).
Written 2026-11-24 after Vinit's brief. Builds on the contract addendum feature (PRs #1351/#1353).

## What it is

A paid service on a contract. The customer asks for a No Objection Certificate so their company can use one of our centres as its registered office (ROC) or principal place of business (GST registration).

| Rule | Decision |
|---|---|
| Purposes | ROC registration, GST registration. Two separate orders, so a customer wanting both gets two NOCs and two invoices |
| Fee | ₹20,000 + GST for each. Kept in Admin settings (`noc_fee_roc`, `noc_fee_gst`), frozen on each order when it is created |
| Centre | Any active centre, whatever centre the agreement is at |
| Payment gate | The NOC cannot be stamped, sealed or lose its DRAFT watermark until paid in full |
| Validity | Ends with the contract. A renewal or a new contract needs a new NOC, paid again |
| Activation | Never a blocker. The contract activation gate is untouched (a test pins this) |
| Marker | A visible indicator on the contract page and the contracts list whenever a NOC is issued, including one issued after the agreement started |
| After payment | Offer to update the live agreements to the new address, through an addendum, with a prompt that stays until done |

## The flow

1. **Order** (staff: admin, manager, sales rep). From the contract page: pick purpose, centre, company details. This creates a draft NOC (watermarked) and an ad-hoc invoice for ₹20,000 + 18% GST tied to the contract. It contacts nobody.
2. **Email to customer** (staff click). Sends the proforma invoice (PI) PDF plus a link to a page on our site. A preview sends nothing, same as the deposit instalment emails.
3. **Customer page** (public, token, no login). Shows the service, centre, fee and the disclaimers. Payment opens only after the customer ticks acceptance. We record when and from where. Accepting creates a fresh Razorpay link for the exact total, never reusing an old one, then forwards to the gateway.
4. **Payment**. By the gateway (webhook marks it paid), or by **Report paid** on the page, on the contract or on the Receivables row, which goes to accounts to verify against the bank, the same as every other receivable. Only a gateway payment or an accounts-verified payment counts.
5. **Confirmation**. The customer page shows payment details (amount, date, payment ID, validity). The customer also gets a receipt email.
6. **Issue**. Once the payment is recorded in full, the stamp and seal function unlocks for an **admin only**. It is the same company signature and seal already used on contracts and Virtual Office agreements (`drawCompanyStamp`, with a unique stamp reference printed beside the seal and logged). The watermark goes, and the NOC is emailed to the customer. Before payment the button is visible but disabled, with the reason beside it, so nobody is left guessing.
7. **Tally and AR**. The ad-hoc invoice mirrors into a billing statement, so it appears in Receivables with the usual reminder ladder (soft ladder, Remind, Report paid), and on payment lands in the Tally Inbox as a GST invoice task. Accounts do what they already do.
8. **Update the agreements**. After payment (and issue) the contract page offers "Update the agreements?", listing every live contract for the same customer. One click drafts a "Change of address" addendum for each, using the addendum flow (approve, customer signs on paper, stamp and seal, apply). The prompt is derived from data, so it stays until each addendum is applied or someone records why not.

## Data

New migration (number picked against every branch, checked with the CI script):

- `noc_requests`: `id`, `noc_number` (NOC-0001…), `contract_id`, `lead_id`, `purpose` (`roc` | `gst`), `location_id` (any active centre), `company_name`, `cin`, `address_snapshot` (centre address when ordered), `fee_excl_gst`, `tax_percentage`, `invoice_id` (ad-hoc invoice), `billing_statement_id`, `status` (`draft`, `sent`, `accepted`, `paid`, `issued`, `void`), `public_token`, `accepted_at`, `accepted_ip`, `terms_version`, `razorpay_link_id`, `paid_at`, `issued_at`, `issued_by`, `draft_document_id`, `sealed_document_id`, `stamp_reference`, `address_addendum_state`, `created_by`.
- `noc_audit_events`: the append-only legal trail described below (replaces a plain event log). `locations.noc_address`: the address text printed on the NOC for each centre. Settings: `noc_signatory_name`, `noc_signatory_designation`.
- Validity is not stored. It is read from `contracts.end_date`, so an extension (`days_extended`) lengthens it and a renewal (a new contract) starts with no NOC.
- RLS on, select policy for authenticated, writes by service role in API routes. Rollback: drop both tables.
- The existing addendum table's `purpose` check is extended with `change_of_address`.
- Invoice purpose: a new `noc` value so the invoice is identifiable in lists (visibility only, never opens an activation gate).

## Where the pieces go

- Staff UI: a compact "NOC service" card in the contract sidebar next to Signed Contract and Addenda (same pattern as the addendum sidebar card); the full NOC panel opens in the main column. Header badges and a chip in the contracts list.
- API under `/api/contracts/[id]/noc` (list, create) and `/api/contracts/[id]/noc/[nid]` (send, report, issue, void); public `/api/public/noc/[token]` (read, accept). Each mutation calls `logAudit`, validates with Zod, checks the role and the current status (compare-and-set).
- Public page `src/app/noc/[token]/page.tsx`, modelled on `/pay/[token]` (callback polling while the webhook lands).
- Webhook: `payment_link.paid` for a NOC link goes through the existing statement path (`handleStatementPaid`), then a small NOC hook moves the order to `paid`. No second payment code path.
- PDF: `src/lib/noc/pdf.ts` in the agreement's layout (same helper as the addendum PDF). Wording is a template with the purpose, centre, company and validity filled in; editable by staff before sending, then locked.
- Pure rules in `src/lib/noc/rules.ts` (fee, gate, validity, who can do what) with unit tests, the same way as `src/lib/addendum/change-of-name.ts`.

## The NOC wording (from Vinit's "Updated NOC - format.pdf")

One template serves both ROC and GST. The highlighted parts of the letter become fields, filled from the contract and the order. Everything else is fixed text kept in one place in the code.

| In the letter | Comes from |
|---|---|
| "for ROC Registration" / "for GST Registration" (twice) | The order's purpose |
| Address (twice) | The chosen centre's address as written for NOCs. Your sample has "Old No.669/GF-11, New No.306/GF-11, Anna Salai, Thousand Lights", which is not how a centre's normal address reads, so each centre gets its own "NOC address" field in Admin, filled once |
| "agreement on 07.10.2026 with AP MINES" | `contracts.agreement_date` and the company name on the order |
| "for the period of 11 months ending at 06.09.2027" | Contract tenure and `end_date`, the NOC's validity |
| "for AP MINES" | The company name on the order |
| Date | The issue date |
| Letterhead (logo, "SREE DESIGN INFRASTRUCTURE PVT LTD", address, phone, CIN, GST) | Fixed. The NOC uses this letterhead, not the branded teal agreement header |
| Signed by "Naval Chordia, Director", Place: Chennai | A setting, so the signatory can change without a code change |

The five standard paragraphs (compliance and books, no title, no responsibility, indemnity, discontinue on expiry) are unchanged. Added: a verification QR beside the seal, and the draft markings described under tamper resistance. The PDF is built from the same template constants the customer page shows, so what the customer accepts is word for word what is printed.

## Acceptance and the legal audit trail

The disclaimers printed in the NOC are shown on the link the customer opens, and each must be accepted before payment opens.

**What the customer does**
1. Opens the link, which shows the fee and the clauses (the same text as the certificate).
2. Ticks each paragraph individually (the three NOC paragraphs plus the service terms, four boxes), not one blanket tick.
3. Types their full name and designation, confirming they are authorised to bind the company.
4. Enters a one-time code sent to the email and mobile already on the contract, which proves it was the person we sent the link to.
5. Ticks a final "I accept on behalf of <company>" and continues to pay.

**What is recorded** (append-only table `noc_audit_events`; no update or delete policy, and a trigger refuses edits, so a row is written once and never changed):
- Order created, fee and template version frozen, by whom.
- Email sent: recipient, PI attached, link reference.
- Link opened: time, IP address, browser and device.
- Identity code sent and verified.
- Clauses accepted: which of the four boxes were ticked, the accepter's typed name and designation, time in UTC and IST, IP, device, and a hash of the exact clause text and the order details they saw.
- Payment received: gateway or accounts-verified reference, amount, balance zero.
- Stamped, sealed and issued: by whom, reference number, and a hash of the issued PDF.
- NOC emailed to the customer.

**Acceptance certificate.** At acceptance a one-page PDF is made: who accepted, the clauses and their hash, the date, time, IP and device, the verification code result and the order reference. It is emailed to the customer, filed on the contract, and linked from the staff audit-trail view (mock screen 9). Staff cannot edit it.

**Staff view.** A read-only audit trail on the NOC, the same list as above.

This is a strong evidence record. It is not legal advice: whether a click-through plus a one-time code is enough for an authority or a court is a question for the company's lawyer, and the wording of the clauses and service terms should be signed off by them.

## The customer link, and how the page works

The link (`/noc/<token>`) opens a page on our own site, never the raw Razorpay link. There the customer reads the paragraphs, ticks them, confirms their name and the code, and accepts. Only then does the page create a fresh Razorpay link for the exact total and forward the customer to the gateway. After payment the gateway returns to the same page, which shows the confirmation and payment details.

Once the order exists the link is shown on the NOC panel with Copy, Share by WhatsApp and "Open as customer", so staff can send it by hand as well as by the email button. A hand-sent link goes through exactly the same page, so acceptance and the audit trail are never skipped. The email is only one way to deliver the link.

## Letter wording: exact text, and one more item

The letter text in the mock is the template word for word, including the second "Address:" after the period sentence, the three standard paragraphs and the signature block. The template's last statement, "A copy of address proof is submitted as the proof of address", is **left out for now** (see "Deferred: address proof"). The three paragraphs the customer ticks on the link are the same paragraphs, from the same source in code. A fourth tick covers the service terms (full payment first, validity, renewal, no refund once issued), which are not printed in the NOC and are listed separately on the page.


### Linking the click to a person (what the certificate must show)

An IP address and a device identify a connection, not a person, so they are supporting detail only. The certificate links the click to the customer in three ways, shown in mock screen 10:

1. **The signatory on the agreement.** The typed name and designation are matched against the contract's recorded signatory (`member_signatory_name`, designation, ID ending). The certificate shows "name matches" or "does not match". A mismatch does not stop the order but is flagged for staff before the NOC is issued.
2. **Control of the contact details on the contract.** The one-time code goes to the email and mobile already on the contract. The certificate states where it was sent (masked), when it was sent and when it was entered.
3. **A chain from our side.** Who sent the link, to which address, and when; when it was first opened; the time of acceptance on our server's clock; the payment reference; and the audit-log entries it came from, with a hash of the certificate.

It also records the exact text accepted (version and SHA-256 of what was shown), with the full text attached.

**Is it legally enough?** I cannot say. It is a strong evidence record, but a click-through with a code is weaker than a recognised electronic signature. The stronger route is an **Aadhaar eSign through Leegality** (already integrated for agreements): it is a recognised electronic signature under the IT Act. Plan: build click-through plus code first, with the Leegality eSign behind a switch (extra cost per NOC, an extra step for the customer), and let the company's lawyer decide which is needed. Whether an authority or a court needs more, and the wording of the declaration, are for that lawyer.

## Deferred: address proof

Decided 2026-11-24: the address proof is **not part of this release**. The certificate does not carry the statement "A copy of address proof is submitted as the proof of address", nothing is attached to the NOC, and issuing a NOC does not need a proof document on file. It will come later. When it does, the design noted earlier still stands: one proof per centre, kept in Admin, released only with the final NOC after full payment, watermarked with the issue date and validity, flattened, logged in the audit trail, with the template statement added back at the same time.

## Two rules reconfirmed (hard rules, each pinned by tests)

**1. A NOC expires with the contract term and is never carried forward.**
- Validity is not copied or extended by a renewal. A renewal is a new contract (a new contract id), and it starts with no NOC and no NOC marker.
- If the customer still needs one, staff order a new NOC on the renewed contract: a new order, a new reference (TWV-C-0210/NOC-1), the full fee again, a fresh acceptance and audit trail, a fresh address proof copy with its own issue date and validity.
- The old NOC stays on the old contract's record as "expired with the previous term" and the verify page reads "expired" after the end date.
- On the renewed contract the sidebar card says "No NOC. The one on the previous term has expired. Order again if still needed", with the Order button, so it is never a dead end.
- Open point from the earlier plan, now settled by this rule: an extension of the same contract (`days_extended`) lengthens the validity, because it is still the same contract. A renewal never does.

**2. The wording depends on the purpose, and a certificate names only one.**
- A ROC order prints "for ROC Registration" and a GST order prints "for GST Registration", in the subject and in the confirmation paragraph. The two words never appear together on one certificate, in the watermarked address proof, or on the customer page.
- If a customer needs both, that is two orders and two certificates, each for its own purpose, each paid for separately.
- Built as one template with a purpose switch. A test renders both and asserts that the ROC certificate contains no "GST Registration" and the GST certificate contains no "ROC Registration". The mock's screen 3 has a ROC/GST toggle that shows the same letter with only that word changed.
- Still open (decision 5): whether the addressee line changes for GST. The sample is addressed to the Registrar of Companies, which reads right for ROC.

## The gate, precisely

`canIssue(noc)` is true only when the linked statement's balance is zero, derived from payments (gateway or accounts-verified), never from a flag a person can set. Server-enforced in the issue route and in the PDF route (the PDF route keeps the DRAFT watermark otherwise). A reported but unverified payment does not count. A part payment does not count.

## Tamper resistance: the draft cannot be made into a real NOC

A watermark on a PDF can always be removed by someone determined, including with AI image tools. So the design does not rely on the watermark. It makes sure a doctored draft is worthless, in four layers:

1. **The customer never receives the draft.** The email carries the PI and the terms link only. The draft NOC is staff-only. Nothing clean or unclean about the NOC leaves the building before payment, so there is nothing to alter.
2. **The server never produces a clean NOC before payment.** The unwatermarked, sealed PDF does not exist until the issue step runs after a full payment. The PDF route decides watermark or not on the server from the payment status, with no cached clean copy. Files sit in the private bucket with short-lived signed links.
3. **Every NOC is verifiable by its number.** The issued NOC carries a unique reference (TWV-C-0125/NOC-1) and a QR code. Scanning it opens a public verify page that shows the live status: issued, company, centre, valid till, or "not issued", "void" or "expired". Whoever receives a NOC (the ROC or GST officer, a bank) can check it. A forged or doctored copy fails the check, because only a paid, sealed NOC ever reads "issued". The page reveals only what is on the certificate.
4. **The draft marking is part of the content, not a layer on top.** The draft has "DRAFT, NOT VALID" in the heading and the body wording, a tiled watermark over the whole page, and the order number and company in the footer, so even a cleaned copy is traceable and reads as a draft. Removing the diagonal mark leaves a document that still says it is a draft.

Later, optionally: a digital signature on the issued PDF (a hash stored in the order, shown on the verify page), so even a pixel-perfect edit of the issued file is detectable.

What this cannot do: stop a person printing a fake letter from scratch. Nothing technical can. The verify page and the unique reference are what protect the people who rely on the certificate.

## The PI, Receivables and Tally path (checked against the code)

The NOC fee is raised as an ad-hoc invoice, and that path already does most of this:

- It is mirrored into a billing statement (`created_via = adhoc_invoice`, `handoff_state = pi_awaiting_payment`) with the invoice title and line items. Receivables already lists these as an "ad-hoc invoice" kind with the reminder ladder, Remind and Report paid.
- On payment, `handleStatementPaid` puts it in the Tally Inbox, and accounts upload the GST invoice and send it, as for any invoice.

Three gaps to close in the build, so accounts get what they need:

1. **Buyer details.** The GST invoice must be raised to the company, with its GSTIN and address. The ad-hoc path takes the buyer from the customer record, which for TWV-C-0125 is still the individual. The NOC order will store a buyer snapshot (company name, GSTIN, address) and print it on the PI and show it on the Tally Inbox row.
2. **Description for accounts.** The title and line read "NOC for ROC registration at Perungudi, contract TWV-C-0125, valid till 31 Aug 2027", so the inbox row says what it is for, with a "NOC service" tag.
3. **SAC code.** The ad-hoc path stamps a generic SAC (`ad_hoc_charges`). The NOC needs its own entry, to be confirmed with accounts (decision 4).

These were checked by reading the code. Not yet exercised end to end on staging.

## Edge cases and decisions

- **Name mismatch.** If the customer record is still a person while the NOC names a company, the order warns and points to the name-change addendum (warning, not a block).
- **Centre inactive later.** An issued NOC stays valid for its term. An ordered-but-unissued NOC for a centre that becomes inactive warns the issuer.
- **Contract ends early.** The NOC ends with it (terminated, expired, exited). The card shows "ended with the contract".
- **Renewal.** The renewal is a new contract, so the card shows "previous NOC expired with the old term; order again". We do not carry it over.
- **Void.** An unpaid order can be voided (invoice and link cancelled). A paid order cannot be voided; a refund is manual and recorded by accounts.
- **Never contacts a real customer in testing.** All build and click-through on staging, Razorpay test mode, `@example.com` customers. The Email to customer step is only ever clicked on staging fixtures.

## Build order (three PRs, each reviewable alone)

1. **Order and draft** (staff only, contacts nobody): table, fee settings, order dialog, draft PDF, sidebar card, header marker, contracts list chip, tests including "never blocks activation". Ships dark behind `app_settings.noc_service_enabled`.
2. **Customer and money**: invoice + PI, email, public page with disclaimers and acceptance, payment link, webhook hook, Report paid, receipt email, Receivables and Tally Inbox rows, confirmation page.
3. **Issue and address update**: stamp and seal gate, issue email, "Update the agreements?" prompt, the `change_of_address` addendum purpose, persistent reminder until applied.

## Needs your decision before building

1. **Clause wording.** Now taken from your template, so approved in substance. Please still have the lawyer confirm the clauses and service terms as shown to the customer. They are stored with a version and hash, so a later change never rewrites what a customer accepted.
2. **Who issues.** Settled: admin only, and only once the payment is recorded. Admin, manager and sales rep can order, email and void an unpaid order.
3. **Validity and extensions.** Proposed: validity follows the contract's end date live, so a short extension also lengthens the NOC. Or should it be frozen at the date of issue?
4. **GST invoice details.** SAC code and 18% for this service: confirm with accounts, since the Tally invoice will carry it.
5. **Addressee.** The template is addressed 'To The Registrar of Companies, (Tamilnadu)' for both purposes. For GST, should it name the GST officer instead? Proposed: one template, with the addressee switching by purpose unless you say it stays the same.
6. **Centre NOC addresses.** I need the NOC address text for each active centre (your sample shows the Old/New number form for Thousand Lights).
7. **One-time code.** Proposed: the code goes to the email and mobile already on the contract, using the existing email and MSG91 SMS. Confirm you want it as a required step.
8. **Address proof (deferred).** Out of scope for now; to be designed when you want it.
9. **Acceptance strength.** Click-through plus one-time code, or Aadhaar eSign through Leegality (stronger, costs more, one more step). Proposed: build click-through first with eSign behind a switch; the lawyer decides.
10. **Address on the agreement.** On the addendum step, the new address is the centre's address. Confirm the agreement should show the centre address even though the customer may still operate from elsewhere.

## Not in scope

Automatic renewal of a NOC, WhatsApp delivery (email only until a template exists), changing the fee per customer (one fee for everyone, editable in settings), and refunds.
