# TWV CRM — Codebase Index

> Next.js 16 + Supabase + TailwindCSS 4 | Coworking Space Management CRM

## Directory Structure

```
src/
├── app/
│   ├── (auth)/           Auth pages (login, signup, forgot-password)
│   ├── (dashboard)/      Protected dashboard routes (~56 pages)
│   ├── api/              API routes (~150+ endpoints)
│   └── public routes     Home, enquiry, feedback, payment
├── components/           Domain-specific + UI primitives (~100+ files)
├── hooks/                7 custom React hooks
├── lib/                  Utilities, integrations, business logic
├── types/                Centralized TypeScript types (index.ts)
supabase/
└── migrations/           63 SQL migrations (00001–00063)
```

---

## Page Routes

### Dashboard Pages (`src/app/(dashboard)/`)

| Route | File | Description |
|-------|------|-------------|
| `/dashboard` | `dashboard/page.tsx` | Main dashboard with widgets |
| `/leads` | `leads/page.tsx` | Lead list + search/filter |
| `/leads/new` | `leads/new/page.tsx` | Create new lead |
| `/leads/[id]` | `leads/[id]/page.tsx` | Lead detail (tabs: activities, proposals, contracts, docs) |
| `/pipeline` | `pipeline/page.tsx` | Sales pipeline (kanban/list) |
| `/activities` | `activities/page.tsx` | Activity timeline |
| `/tasks` | `tasks/page.tsx` | Task management |
| `/proposals` | `proposals/page.tsx` | Proposal list |
| `/proposals/[id]` | `proposals/[id]/page.tsx` | Proposal detail/edit |
| `/bookings` | `bookings/page.tsx` | Booking list + calendar |
| `/bookings/new` | `bookings/new/page.tsx` | Create booking |
| `/bookings/[id]` | `bookings/[id]/page.tsx` | Booking detail |
| `/cases` | `cases/page.tsx` | Case list (kanban/table) |
| `/cases/new` | `cases/new/page.tsx` | Create case |
| `/cases/[id]` | `cases/[id]/page.tsx` | Case detail (tabs: comments, docs, agreement, compliance) |
| `/contracts` | `contracts/page.tsx` | Contract list |
| `/contracts/[id]` | `contracts/[id]/page.tsx` | Contract detail (vouchers, billing) |
| `/billing` | `billing/page.tsx` | Billing & usage charges |
| `/invoices` | `invoices/page.tsx` | Invoice management |
| `/accounting` | `accounting/page.tsx` | Accounting module (facilities, payments, GST) |
| `/vouchers` | `vouchers/page.tsx` | Voucher inventory & management |
| `/packages` | `packages/page.tsx` | Prepaid packages |
| `/aggregators` | `aggregators/page.tsx` | Aggregator management |
| `/aggregators/[id]` | `aggregators/[id]/page.tsx` | Aggregator detail (contacts, rate cards) |
| `/procurement` | `procurement/page.tsx` | Procurement dashboard |
| `/procurement/requests` | `procurement/requests/page.tsx` | Purchase requests list |
| `/procurement/requests/new` | `procurement/requests/new/page.tsx` | Create PR |
| `/procurement/requests/[id]` | `procurement/requests/[id]/page.tsx` | PR detail |
| `/procurement/orders` | `procurement/orders/page.tsx` | Purchase orders list |
| `/procurement/orders/new` | `procurement/orders/new/page.tsx` | Create goods PO |
| `/procurement/orders/new-service` | `procurement/orders/new-service/page.tsx` | Create service PO |
| `/procurement/orders/[id]` | `procurement/orders/[id]/page.tsx` | PO detail (deliveries, invoices, timeline) |
| `/procurement/bills` | `procurement/bills/page.tsx` | Vendor bills list |
| `/procurement/bills/new` | `procurement/bills/new/page.tsx` | Create vendor bill |
| `/procurement/bills/[id]` | `procurement/bills/[id]/page.tsx` | Bill detail (approval, payments) |
| `/procurement/vendors` | `procurement/vendors/page.tsx` | Vendor directory |
| `/procurement/catalog` | `procurement/catalog/page.tsx` | Item catalog |
| `/procurement/payables` | `procurement/payables/page.tsx` | Accounts payable summary |
| `/spaces` | `spaces/page.tsx` | Space management |
| `/spaces/[id]` | `spaces/[id]/page.tsx` | Space detail |
| `/locations` | `locations/page.tsx` | Location management |
| `/team` | `team/page.tsx` | Team/user management |
| `/settings` | `settings/page.tsx` | App settings |
| `/support` | `support/page.tsx` | Support tickets (admin) |
| `/my-tickets` | `my-tickets/page.tsx` | User's own tickets |
| `/audit-logs` | `audit-logs/page.tsx` | Audit trail viewer |
| `/documents` | `documents/page.tsx` | Document management |
| `/infrastructure` | `infrastructure/page.tsx` | Infrastructure info |
| `/help` | `help/page.tsx` | Help/documentation |

### Auth Pages (`src/app/(auth)/`)

| Route | File |
|-------|------|
| `/login` | `login/page.tsx` |
| `/signup` | `signup/page.tsx` |
| `/forgot-password` | `forgot-password/page.tsx` |

### Public Pages

| Route | File | Description |
|-------|------|-------------|
| `/` | `page.tsx` | Landing/home |
| `/enquire` | `enquire/page.tsx` | Public enquiry form |
| `/walkin` | `walkin/page.tsx` | Walk-in booking |
| `/pay/[token]` | `pay/[token]/page.tsx` | Payment link page |
| `/feedback/[token]` | `feedback/[token]/page.tsx` | Feedback form |

---

## API Routes (`src/app/api/`)

### Core CRUD Endpoints

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/leads` | GET, POST | Lead list + create |
| `/api/leads/[id]` | GET, PUT, DELETE | Lead CRUD |
| `/api/leads/[id]/activities` | GET | Lead activities |
| `/api/leads/[id]/proposals` | GET | Lead proposals |
| `/api/leads/import` | POST | Bulk CSV import |
| `/api/bookings` | GET, POST | Booking list + create |
| `/api/bookings/[id]` | GET, PUT, DELETE | Booking CRUD |
| `/api/bookings/calendar` | GET | Calendar view |
| `/api/bookings/bulk` | POST | Bulk operations |
| `/api/bookings/recurring/[id]` | GET, POST | Recurring bookings |
| `/api/bookings/waitlist` | GET, POST | Waitlist |
| `/api/booking-payments` | GET, POST | Payment records |
| `/api/booking-payments/[id]` | GET, PUT, DELETE | Payment CRUD |
| `/api/cases` | GET, POST | Case list + create |
| `/api/cases/[id]` | GET, PUT, DELETE | Case CRUD |
| `/api/cases/[id]/status` | PUT | Status transitions |
| `/api/cases/[id]/comments` | POST | Add comments |
| `/api/cases/[id]/documents` | POST | Upload docs |
| `/api/cases/[id]/agreement` | GET, POST | Agreement management |
| `/api/cases/[id]/leave-license` | GET, POST | Leave license |
| `/api/cases/[id]/subscriptions` | GET, POST | Subscriptions |
| `/api/contracts` | GET, POST | Contract list + create |
| `/api/contracts/[id]` | GET, PUT | Contract detail/update |
| `/api/contracts/[id]/vouchers` | GET, POST | Voucher issuance |
| `/api/proposals` | GET, POST | Proposal list + create |
| `/api/proposals/[id]` | GET, PUT | Proposal detail/update |
| `/api/proposal-presets` | GET, POST | Proposal templates |
| `/api/spaces` | GET, POST | Space management |
| `/api/spaces/[id]` | GET, PUT, DELETE | Space CRUD |
| `/api/locations` | GET, POST | Location management |
| `/api/tasks` | GET, POST | Task management |
| `/api/invoices` | GET, POST | Invoice management |

### Procurement Endpoints

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/procurement/requests` | GET, POST | Purchase requests |
| `/api/procurement/requests/[id]` | GET, PUT, DELETE | PR CRUD |
| `/api/procurement/orders` | GET, POST | Purchase orders |
| `/api/procurement/orders/[id]` | GET, PATCH | PO detail + actions (mark_ordered, mark_received, cancel, partial_cancel) |
| `/api/procurement/orders/[id]/deliveries` | GET, POST, DELETE | Delivery receipts + reject |
| `/api/procurement/bills` | GET, POST | Vendor bills |
| `/api/procurement/bills/[id]` | GET, PUT, DELETE | Bill CRUD + approval |
| `/api/procurement/items` | GET, POST | Item catalog |
| `/api/procurement/vendors` | GET, POST | Vendor directory |
| `/api/procurement/service-reports` | GET, POST | Service reports |
| `/api/procurement/settings` | GET, POST | Procurement config |

### Accounting Endpoints

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/accounting/contract-facilities` | GET, POST | Contract facilities |
| `/api/accounting/contract-payments` | GET, POST | Contract payments |
| `/api/accounting/contract-summary` | GET | Summary report |
| `/api/accounting/facility-usage` | GET, POST | Usage tracking |
| `/api/accounting/gst-invoices` | GET, POST | GST invoices |
| `/api/accounting/periods` | GET, POST | Accounting periods |
| `/api/accounting/monthly-summary` | GET | Monthly summary |
| `/api/accounting/cash-handovers` | POST | Cash handover |

### Other Endpoints

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/aggregators` | GET, POST | Aggregator management |
| `/api/aggregator-invoices` | GET, POST | Aggregator invoices |
| `/api/payments/create-order` | POST | Razorpay order |
| `/api/payments/create-payment-link` | POST | Payment links |
| `/api/payments/verify` | POST | Payment verification |
| `/api/payments/webhook` | POST | Razorpay webhook |
| `/api/prepaid-packages` | GET, POST | Packages |
| `/api/prepaid-purchases` | GET, POST | Package purchases |
| `/api/usage-charges` | GET, POST | Usage charges |
| `/api/billing-statements` | GET, POST | Billing statements |
| `/api/activities` | GET, POST | Activity logging |
| `/api/followups` | GET, POST | Follow-ups |
| `/api/support-tickets` | GET, POST | Support tickets |
| `/api/documents` | GET, POST | Documents |
| `/api/team` | GET, POST | Team management |
| `/api/users` | GET, POST | User management |
| `/api/audit-logs` | GET | Audit trail |
| `/api/dashboard` | GET | Dashboard data |
| `/api/settings` | GET, POST | Settings |
| `/api/me` | GET | Current user |
| `/api/push/subscribe` | POST | Push notifications |
| `/api/email/inbound` | POST | Email webhook |
| `/api/webhooks/whatsapp` | POST | WhatsApp webhook |
| `/api/webhooks/leegality` | POST | E-signature webhook |
| `/api/public/enquiry` | POST | Public enquiry |
| `/api/public/feedback` | POST | Public feedback |

---

## Components (`src/components/`)

### Domain Components

| Directory | Key Components |
|-----------|---------------|
| `accounting/` | contract-facility, contract-payment, aging-buckets, gst-invoice, cash-handover, payment-receipt |
| `activities/` | activity-form, activity-timeline, lead-timeline |
| `aggregators/` | aggregator-form, contacts-tab, rate-cards-tab |
| `billing/` | add-usage-charge, generate-statement, view-statement |
| `bookings/` | calendar-view, collect-payment, create-recurring, customer-history, reschedule, revenue-report, utilization-dashboard, waitlist |
| `cases/` | case-form, kanban-board, status-pipeline, comments-tab, documents-tab, agreement-tab, compliance-tab, leave-agreement-tab, subscription-history |
| `contracts/` | create-contract-dialog, vouchers-section, voucher-replace |
| `dashboard/` | dashboard-main, sidebar, header, notification-bell, widgets (booking, financial, kpi, notes, procurement, activities, support, team) |
| `help/` | faq-item, keyboard-shortcuts, role-permissions, search |
| `invoices/` | invoice-form |
| `leads/` | lead-form, import-leads, contracts-tab, documents-tab, feedbacks-tab, proposals-tab, tasks-tab |
| `locations/` | location-form-dialog |
| `packages/` | prepaid-banner, sell-package-dialog |
| `procurement/` | item-history-dialog |
| `proposals/` | proposal-form, preset-picker |
| `settings/` | dashboard-settings, payment-gateway-settings, procurement-settings |
| `shared/` | command-palette, email-document-dialog, empty-state, line-items-editor, loading-skeleton, location-selector, mobile-nav, status-badge, toast-provider |
| `spaces/` | space-form-dialog |
| `support/` | report-issue-button/dialog, ticket-detail-dialog, my-ticket-detail-dialog |
| `tasks/` | create-task-dialog |
| `vouchers/` | low-stock-alert, reclassify-dialog, upload-dialog, inventory-card |

### UI Primitives (`src/components/ui/`)

avatar, badge, button, card, checkbox, dialog, dropdown-menu, input, label, select, separator, switch, table, tabs, textarea

---

## Lib Utilities (`src/lib/`)

| File | Purpose |
|------|---------|
| `utils.ts` | formatDate, formatCurrency, cn, general helpers |
| `constants.ts` | Status labels/colors, enums, billing cycles |
| `validations.ts` | Zod schemas for shared validation |
| `audit.ts` | logAudit(), diffChanges() |
| `supabase/client.ts` | Browser Supabase client |
| `supabase/server.ts` | Server Supabase client |
| `supabase/middleware.ts` | Auth middleware |
| `pdf-generator.ts` | General PDF generation |
| `pdf-utils.ts` | PDF utilities |
| `po-pdf-generator.ts` | Purchase order PDF |
| `voucher-pdf-parser.ts` | Voucher PDF parsing |
| `agreement-generator.ts` | Membership agreement PDF |
| `leave-license-generator.ts` | Leave license PDF |
| `ics-generator.ts` | Calendar invite (.ics) generation |
| `case-workflow.ts` | Case status transition logic |
| `auto-status.ts` | Automatic status transitions |
| `compliance.ts` | Compliance checking |
| `gmail.ts` | Gmail API integration |
| `email-parser.ts` | Email parsing |
| `mailer.ts` | Email sending (Nodemailer) |
| `digio.ts` | DigiO e-signature API |
| `leegality.ts` | Leegality e-signature API |
| `whatsapp.ts` | WhatsApp messaging |
| `push.ts` | Web push notifications |
| `dashboard-config.ts` | Dashboard layout config |
| `help-content.ts` | Help documentation content |
| `logo-data.ts` | Logo/branding data |
| `zoho-field-mapping.ts` | Zoho CRM field mapping |
| `procurement/pr-status.ts` | PR status recalculation |

---

## Custom Hooks (`src/hooks/`)

| Hook | Purpose |
|------|---------|
| `use-leads.ts` | Lead data fetching, useUsers() |
| `use-activities.ts` | Activity CRUD |
| `use-cases.ts` | Case data management |
| `use-aggregators.ts` | Aggregator data |
| `use-locations.ts` | Location data |
| `use-enquiry-notifications.ts` | Enquiry alert handling |
| `use-push-notifications.ts` | Push notification setup |

---

## Types (`src/types/index.ts`)

Single file with all TypeScript interfaces: Lead, Booking, Case, Contract, Proposal, PurchaseOrder, PurchaseRequest, VendorBill, ProcurementVendor, ProcurementItem, Space, Location, User, AuditLog, Activity, Task, SupportTicket, and many more.

---

## Database Migrations (`supabase/migrations/`)

| # | File | Description |
|---|------|-------------|
| 01 | `00001_initial_schema.sql` | Users, leads, activities, proposals |
| 02 | `00002_contracts_billing.sql` | Contracts, billing |
| 03–05 | `00003–00005` | Voucher validity, signed docs, per-seat email |
| 06 | `00006_multi_location.sql` | Multi-location support |
| 07 | `00007_membership_agreement.sql` | Agreement tracking |
| 08–10 | `00008–00010` | Conference bookings, enhancements, feedback |
| 11 | `00011_payments_gateway.sql` | Razorpay integration |
| 12 | `00012_accounting_module.sql` | Accounting module |
| 13–14 | `00013–00014` | Booking v2, payment links |
| 15 | `00015_aggregator_virtual_office.sql` | Aggregators + virtual offices |
| 16–18 | `00016–00018` | Google Ads, charges, security |
| 19 | `00019_procurement_module.sql` | Procurement (POs, PRs, items, vendors) |
| 20–22 | `00020–00022` | RLS policies, security fixes |
| 23–28 | `00023–00028` | Procurement settings, enhancements, vendor terms, invoices, partial orders, delivery receipts |
| 29–33 | `00029–00033` | 3hr vouchers, push, followup audit, cascade deletes |
| 34–42 | `00034–00042` | Prepaid packages, admin role, credit types, RLS, enhancements, reclassify, usage-booking link, statements |
| 43–50 | `00043–00050` | WhatsApp, messages, proposal presets, leave license, PAN, Leegality, signatory ID, lessee sign URL |
| 51–53 | `00051–00053` | Lead activity fix, bill approval workflow, support tickets RLS fix |
| 54–58 | `00054–00058` | Vendor bill grants, service PO, advance payments, ticket status, accounts/FMS roles |
| 59–63 | `00059–00063` | Email stats, lead entity type, proposal rejection, GST number |

---

## Key Dependencies

- **Framework**: Next.js 16.1.6, React 19.2.3
- **Database**: Supabase (PostgreSQL + Auth + Storage)
- **Styling**: TailwindCSS 4, Radix UI primitives
- **Payments**: Razorpay
- **E-signatures**: DigiO, Leegality
- **Email**: Gmail API, Nodemailer
- **Messaging**: WhatsApp Business API
- **PDF**: jsPDF
- **Charts**: Recharts
- **State**: Zustand
- **Validation**: Zod
- **Notifications**: Web Push
