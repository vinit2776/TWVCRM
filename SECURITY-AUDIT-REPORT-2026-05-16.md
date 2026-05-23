# TWV CRM Audit Report

Date: 2026-05-16
Scope: Business workflow understanding, application architecture, infrastructure setup, and code/security audit
Auditor: Codex

## Executive Summary

TWV CRM is a full-stack internal operations platform for The WorkVilla covering sales, contracts, recurring billing, bookings, procurement, facilities, and accounting. The system is operationally rich and encodes several important business controls in application code, especially around proposal-to-contract activation, invoice generation, procurement approvals, and finance workflows.

The strongest positive finding is that the codebase clearly models business process gates rather than treating the CRM as a generic CRUD app. Good examples include the contract activation gate, split proposal-payment flow, procurement approval/payment separation, audit logging on many mutations, and signed payment webhook handling.

The biggest risk is that the security boundary is inconsistent. The database and storage layers are broadly permissive for any authenticated user, and the application compensates with route-level checks in selected handlers. That pattern can work, but only if every privileged route is implemented perfectly. In this repository, that assumption does not hold consistently.

Most important findings:

1. A public payment endpoint can mark booking payments as `verified` purely from client-supplied fields.
2. Any authenticated user can generate a signed URL for any document by document ID.
3. Core database and storage RLS policies are intentionally broad, creating lateral-access risk across staff roles.
4. Approval-code signing falls back to the service-role key and then to a hardcoded default secret.
5. OTPs are stored and transmitted in plaintext.
6. Backup coverage appears incomplete because storage backup only lists the first 1000 objects per bucket and does not paginate.

## Business Understanding

### What the system does

TWV CRM is the internal system of record for coworking operations. Based on the codebase and route structure, its primary business areas are:

- Sales CRM: leads, follow-ups, proposals, activities, tasks
- Revenue operations: proposal deposits, pro-rata invoicing, recurring contract billing, GST invoices, receivables
- Space operations: room/day-pass bookings, voucher issuance, occupancy/headcount, facility usage
- Procurement and AP: requests, orders, deliveries, vendor bills, approvals, payment batches, TDS
- Facilities and IT: issue reporting, SLA tracking, public satisfaction links, asset/category management
- Admin and infrastructure: users, settings, infra metrics, cron health, backups

### Key workflow rules observed in code

#### Proposal -> Contract activation gate

The contract activation flow is tightly controlled in code. A contract cannot become active unless the linked proposal exists and required collections are complete, with a renewal exception and an admin-only override path.

Evidence:
- [src/app/api/contracts/[id]/route.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/app/api/contracts/[id]/route.ts:141)

Highlights:
- Proposal must be linked before activation
- Pro-rata/first invoice must be paid
- Deposit must be paid if required
- Deposit waiver requires explicit OTP verification when deposit is not required
- Admin override is audited

#### Proposal invoicing and payment-link generation

The proposal invoice flow intentionally generates a fresh Razorpay link each time an invoice is sent so the payable amount matches the latest pro-rated computation.

Evidence:
- [src/app/api/proposals/[id]/send-invoice/route.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/app/api/proposals/[id]/send-invoice/route.ts:104)

Highlights:
- Preview vs send mode is explicit
- Pro-rata amount is recalculated from occupation date
- Fresh payment link is created in send mode
- Invoice PDF is generated and uploaded

#### Procurement approval vs payment recording separation

Vendor bill approval and vendor payment recording are separated by role and state. Payment recording is blocked until approval, and different roles are restricted to different payment modes.

Evidence:
- [src/app/api/procurement/bills/[id]/route.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/app/api/procurement/bills/[id]/route.ts:146)

Highlights:
- Only admin/manager can approve
- Only accounts/admin/office_admin can record payments
- Managers are explicitly blocked from recording payments
- Bill must be approved before payment

#### Central recurring billing engine

Recurring monthly billing is centralized in a shared generator rather than duplicated in multiple routes, which is a strong maintainability and correctness choice for financial logic.

Evidence:
- [src/lib/billing.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/lib/billing.ts:1)

## Infrastructure Setup

### Application stack

- Framework: Next.js 16 App Router + React 19 + TypeScript
- Database/Auth/Storage: Supabase
- Hosting: Vercel
- Email: Resend and SMTP/Nodemailer
- Payments: Razorpay
- File storage/backups: Supabase Storage + Backblaze B2
- CI: GitHub Actions

Evidence:
- [package.json](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/package.json:1)
- [vercel.json](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/vercel.json:1)
- [.github/workflows/ci.yml](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/.github/workflows/ci.yml:1)

### Deployment and operations model

- Production appears to auto-deploy from GitHub to Vercel
- CI runs `npm ci`, `npm run lint`, and `npm run build`
- Vercel cron jobs trigger business and maintenance routes
- A public health endpoint exposes DB reachability and cron freshness
- Separate cron routes handle DB backup and storage backup

### Auth and data access pattern

There are two distinct Supabase access modes:

- User-scoped SSR client for normal requests
- Service-role admin client for privileged operations

Evidence:
- [src/lib/supabase/server.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/lib/supabase/server.ts:1)

This is a good pattern in principle, but because the app uses the service-role frequently, route-level authorization has to be consistently correct.

## Security Findings

### 1. Critical: Public payment endpoint trusts client-supplied payment proof

Severity: Critical

Evidence:
- [src/app/api/public/pay/route.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/app/api/public/pay/route.ts:60)

What happens:
- The public `POST /api/public/pay` route accepts a booking `token`
- It inserts a `booking_payments` record
- If `razorpay_payment_id` is present, it marks the payment `verified`
- No signature verification is performed in this route

Why this matters:
- Anyone holding a valid payment link token can submit arbitrary `razorpay_payment_id`, `razorpay_order_id`, and `razorpay_signature` fields
- The route will treat that as a verified payment and may mark the booking as paid
- This is a direct integrity failure in a financial workflow

Impact:
- False payment confirmation
- Unauthorized booking check-in or fulfillment
- Audit and finance reconciliation corruption

Recommendation:
- Remove the ability for this route to set `status: "verified"`
- Force all public-link payments into `pending`
- Allow verification only through signed Razorpay webhook processing or the authenticated `/api/payments/verify` flow
- Add idempotency and duplicate-payment safeguards on `booking_payments`

### 2. High: Any authenticated user can view any document by ID

Severity: High

Evidence:
- [src/app/api/documents/[id]/view/route.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/app/api/documents/[id]/view/route.ts:11)

What happens:
- The route only checks whether a user is logged in
- It then uses the service-role client to fetch any document by ID
- It returns a one-hour signed URL for the file

Why this matters:
- There is no ownership, role, folder, lead, or case linkage check
- Any staff user who learns or guesses a document UUID can retrieve the file
- The comment says “user with access to the document”, but no such access check exists

Impact:
- Cross-department document disclosure
- Potential exposure of KYC, contracts, invoices, signed documents, and internal attachments

Recommendation:
- Enforce document authorization before generating signed URLs
- Model document ACLs explicitly or check parent entity access
- Avoid service-role reads unless authorization is already proven

### 3. High: Database RLS is broadly permissive for all authenticated users

Severity: High

Evidence:
- [supabase/migrations/00001_initial_schema.sql](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/supabase/migrations/00001_initial_schema.sql:430)

What happens:
- Core tables such as `users`, `leads`, `documents`, `lead_documents`, `proposals`, and others are readable by any authenticated user
- Many write policies are also effectively “any authenticated user”
- The migration comments explicitly describe this as the intended boundary

Why this matters:
- The true security boundary becomes “any signed-in employee”
- Role separation then depends on API handlers not making mistakes
- Any client-side Supabase query or overlooked route can expose or mutate data beyond role expectations

Impact:
- Lateral access between sales, accounts, FMS, IT, and office staff
- Harder compliance story for HR, finance, customer contracts, and KYC
- Higher blast radius if one account is compromised

Recommendation:
- Move toward role-aware RLS for sensitive domains first: users, documents, contracts, billing, procurement, OTPs
- Treat service-role usage as exception-only
- Create read scopes by module or department instead of “all authenticated”

### 4. High: Storage bucket access is also broad for all authenticated users

Severity: High

Evidence:
- [supabase/migrations/00071_crm_documents_bucket.sql](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/supabase/migrations/00071_crm_documents_bucket.sql:19)

What happens:
- Any authenticated user can upload to `crm-documents`
- Any authenticated user can read from `crm-documents`
- The storage policy does not restrict by path, owner, entity, or role

Why this matters:
- Even without the vulnerable document-view route, the bucket itself is broadly open to staff
- The application also issues signed upload URLs using the admin client for caller-chosen paths

Related code:
- [src/app/api/documents/upload-url/route.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/app/api/documents/upload-url/route.ts:13)
- [src/app/api/documents/register/route.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/app/api/documents/register/route.ts:12)

Recommendation:
- Partition storage by module/entity path
- Restrict storage RLS by path prefix and role
- Validate `customPath` server-side against an allowlist
- Tie document registration to authorized parent entities only

### 5. Medium: Approval-code signing secret has unsafe fallback behavior

Severity: Medium

Evidence:
- [src/lib/procurement/approval-code.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/lib/procurement/approval-code.ts:15)

What happens:
- Approval codes use `APPROVAL_CODE_SECRET`
- If absent, the code falls back to `SUPABASE_SERVICE_ROLE_KEY`
- If that is absent, it falls back again to a hardcoded string

Why this matters:
- Reusing the service-role key for a different crypto purpose is poor secret hygiene
- A hardcoded fallback silently weakens guarantees in misconfigured environments

Recommendation:
- Require `APPROVAL_CODE_SECRET`
- Fail fast at startup if missing
- Do not reuse the Supabase service-role key for application signing

### 6. Medium: OTPs are stored and distributed in plaintext

Severity: Medium

Evidence:
- [src/app/api/admin/otp/route.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/app/api/admin/otp/route.ts:38)

What happens:
- OTP values are generated with `Math.random()`
- Raw OTPs are stored as `otp_code`
- OTPs are sent in email subject lines and SMS
- Verification compares plaintext equality in the database

Why this matters:
- Plaintext OTP storage increases insider and log exposure risk
- Email subjects are especially widely retained in mail systems and notifications
- `Math.random()` is not a cryptographically strong generator

Recommendation:
- Use `crypto.randomInt()` for OTP generation
- Store only a salted hash of the OTP
- Remove OTP values from email subject lines
- Add rate limiting per requester and per reference object

### 7. Medium: Storage backup job appears incomplete for large buckets

Severity: Medium

Evidence:
- [src/app/api/cron/storage-backup/route.ts](/Users/vinitchordia/Library/Mobile%20Documents/com~apple~CloudDocs/Projects/TWV%20CRM/src/app/api/cron/storage-backup/route.ts:20)

What happens:
- `listBucketFiles()` requests only `limit = 1000`
- `offset` is always `0`
- There is no pagination loop

Why this matters:
- Once a bucket exceeds 1000 objects, backups will silently become partial
- This is an operational resilience issue rather than a direct exploit, but it materially affects disaster recovery

Recommendation:
- Implement pagination until exhaustion
- Emit counts and alert if object totals exceed copied totals
- Record backup manifests and checksums

## Additional Observations

### Strengths

- Clear business-process enforcement in contracts, billing, and procurement
- Many mutation routes call `logAudit()`
- Webhook signature validation is implemented for Razorpay
- Cron endpoints generally require `CRON_SECRET`
- Public bearer-link flows use UUID tokens rather than sequential identifiers

### Weaknesses in security model

- Security depends too much on route correctness instead of least-privilege data policies
- Service-role access is common across many handlers
- Document and file handling lacks strong authorization boundaries
- OTP and approval mechanisms need stronger secret and verification hygiene

## Prioritized Remediation Plan

### Immediate

1. Disable client-driven verification in `POST /api/public/pay`
2. Lock down `/api/documents/[id]/view`
3. Validate and constrain document upload paths and document registration ownership

### Short term

4. Require a dedicated `APPROVAL_CODE_SECRET`
5. Replace plaintext OTP flow with hashed OTP storage and cryptographic generation
6. Review every service-role route for explicit authorization checks

### Medium term

7. Redesign RLS for sensitive tables and storage paths
8. Split access by role or department for finance, contracts, documents, and users
9. Add security-focused regression tests for authz-sensitive routes

### Operational

10. Fix storage backup pagination and add restore validation
11. Add monitoring for unauthorized/abnormal access to signed URL generation
12. Add a security review checklist for new API routes using `createAdminClient()`

## Overall Rating

Business-process maturity: Strong
Architecture clarity: Good
Operational maturity: Moderate
Security posture: Moderate risk with several high-impact authorization gaps

Overall conclusion:
This is a capable internal platform with meaningful business logic and decent operational discipline, but it currently relies on trust boundaries that are too wide for the amount of sensitive financial and customer data it handles. The fastest path to materially lower risk is to close the public payment verification bug, restrict document access, and reduce the “all authenticated users” database/storage trust model.
