# Dashboard

## Purpose and Business Context

The Dashboard (`/dashboard`) is the primary landing page for all authenticated CRM users at The WorkVilla. It functions as a real-time operations nerve center, surfacing:

- **Live enquiry alerts** (audio chime + banner + badge) when new form submissions or re-enquiries arrive via Google Ads, Meta Ads, or Walk-in forms
- **Role-tailored KPI widgets** — each role sees only the widgets relevant to their function
- **Pending approvals** for admin/manager (deposit waivers, vendor bills, material requests)
- **Pipeline and conversion metrics** (scoped per user for sales reps, global for admin/manager)
- **Financial health** (revenue pulse, cash aging, renewal pipeline, rent-vs-revenue)
- **Operational status** (SLA risk, occupancy, booking summary, procurement spend)

The dashboard is purely a read-only view — no mutations are performed from the dashboard page itself. All actions navigate the user to the relevant module page.

---

## Route

| Route | Purpose |
|-------|---------|
| `/dashboard` | Single-page dashboard with role-gated widget grid |

The page is inside `src/app/(dashboard)/` so it uses the authenticated sidebar/header layout defined by `src/app/(dashboard)/layout.tsx`.

---

## Key Source Files

| File | Role |
|------|------|
| `src/app/(dashboard)/dashboard/page.tsx` | Main dashboard page — "use client", widget layout engine |
| `src/components/dashboard/dashboard-main.tsx` | Client wrapper for the dashboard layout shell (Header, EnquiryNotificationsProvider, EnquiryAlertBanner, PushNotificationPrompt, InstallPrompt) |
| `src/lib/dashboard-config.ts` | Single source of truth: `WidgetId` union type, `WIDGET_REGISTRY`, `DASHBOARD_ROLE_WIDGETS` — defines which widgets each role sees by default |
| `src/hooks/use-enquiry-notifications.ts` | Core hook — one Supabase realtime subscription shared across all consumers via context; plays audio chime on new events |
| `src/providers/enquiry-notifications-provider.tsx` | Context wrapper around `useEnquiryNotificationsCore` — prevents duplicate subscriptions |
| `src/components/dashboard/header.tsx` | Top header bar: search (command palette), notification bell group (ApprovalBell + InAppNotificationBell + NotificationBell), user avatar/logout |
| `src/components/dashboard/notification-bell.tsx` | Enquiry notification dropdown (new leads, re-enquiries, WhatsApp inbound) |
| `src/components/dashboard/enquiry-alert-banner.tsx` | Full-width dismissable alert banner below Header; slides in on new enquiry |
| `src/components/dashboard/followups-widget.tsx` | Follow-ups widget with inline close/reschedule actions |
| `src/components/settings/dashboard-settings.tsx` | Admin UI at `/admin/settings` for reordering/enabling widgets per role |

### Widget Components (`src/components/dashboard/widgets/`)

| Component | WidgetId | API Endpoint |
|-----------|----------|--------------|
| `pending-actions-widget.tsx` | `pending_actions` | `/api/dashboard/pending-actions` |
| `kpi-stats-widget.tsx` | `kpi_stats` | `/api/dashboard` (main stats) |
| `recent-activities-widget.tsx` | `recent_activities` | `/api/dashboard` |
| `notes-widget.tsx` | `notes` | `/api/dashboard` |
| `followups-widget.tsx` | `followups` | `/api/followups` |
| `recent-leads-widget.tsx` | `recent_leads` | `/api/dashboard/recent-leads` |
| `procurement-summary-widget.tsx` | `procurement_summary` | `/api/dashboard/procurement` |
| `support-summary-widget.tsx` | `support_summary` | `/api/dashboard/support` |
| `team-performance-widget.tsx` | `team_performance` | `/api/dashboard/team` |
| `booking-summary-widget.tsx` | `booking_summary` | `/api/dashboard/bookings` |
| `financial-summary-widget.tsx` | `financial_summary` | `/api/dashboard/financial` |
| `renewal-pipeline-widget.tsx` | `renewal_pipeline` | `/api/dashboard/renewals` |
| `cash-aging-widget.tsx` | `cash_aging` | `/api/dashboard/cash-aging` |
| `revenue-pulse-widget.tsx` | `revenue_pulse` | `/api/dashboard/revenue-pulse` |
| `occupancy-widget.tsx` | `occupancy` | `/api/dashboard/occupancy` |
| `sla-risk-widget.tsx` | `sla_risk` | `/api/dashboard/sla-risk` |
| `member-health-widget.tsx` | `member_health` | `/api/dashboard/member-health` |
| `lead-funnel-widget.tsx` | `lead_funnel` | `/api/dashboard/lead-funnel` |
| `schedule-widget.tsx` | `schedule` | `/api/dashboard/schedule` |
| `source-roi-widget.tsx` | `source_roi` | `/api/dashboard/source-roi` |
| `aggregator-performance-widget.tsx` | `aggregator_performance` | `/api/dashboard/aggregator-performance` |
| `procurement-spend-widget.tsx` | `procurement_spend` | `/api/dashboard/procurement-spend` |
| `quota-overuse-widget.tsx` | `quota_overuse` | `/api/dashboard/quota-overuse` |
| `mtd-bookings-widget.tsx` | `mtd_bookings` | `/api/dashboard/mtd-bookings` |
| `rent-revenue-widget.tsx` | `rent_revenue` | `/api/dashboard/rent-revenue` |
| `network-widget.tsx` (in `/components/network/`) | `network` | `/api/unifi/dashboard` |

---

## API Routes

### `GET /api/dashboard`

Main stats endpoint consumed by `kpi_stats`, `recent_activities`, and `notes` widgets.

**Auth:** any authenticated user. Role-scoped results.

**Query params:** `location_id` (optional UUID)

**Role scoping logic:**
- `sales_rep` and `floor_manager`: data filtered to leads assigned to `dbUser.id`. Uses a `NULL_ID` sentinel (`"00000000-0000-0000-0000-000000000000"`) to return empty counts when the user has zero leads, avoiding full-table scans.
- All other roles: global or location-filtered data.

**Response shape:**
```typescript
{
  data: {
    pipeline: { status: string; count: number }[];  // ALL lead statuses, full history
    tasks_due_today: number;
    tasks_overdue: number;
    recent_activities: Activity[];  // last 10
    recent_notes: DashboardNote[];  // last 20 activities of type='note'
    conversion: {
      total_leads: number;  // only leads created >= CONVERSION_CUTOFF
      won: number;
      lost: number;
      rate: number;         // percentage integer (0-100)
      this_month?: {
        total: number;      // leads created >= first day of current month
        won: number;
        rate: number;
      };
    };
    pending_follow_ups: number;
  }
}
```

**Critical constants:**
- `CONVERSION_CUTOFF = "2026-04-01"` — conversion rate denominators exclude leads created before this date (legacy bulk-import skew). Pipeline totals are unaffected.
- `MONTH_CUTOFF` — computed at request time: `YYYY-MM-01` for current month.
- PostgREST 1,000-row default cap: the pipeline query uses `.range(0, 9999)` to bypass truncation. **Never remove this range** — with 1,500+ leads the pipeline total would silently be wrong.

---

### `GET /api/dashboard/pending-actions`

**Auth:** authenticated. Returns empty array for non-admin/manager (no 403).

**Access:** `admin`, `manager` only (returns `{ data: [] }` for others).

**Sources queried in parallel:**
1. `proposals` where `security_deposit_months = 0` AND `deposit_waiver_requested_at IS NOT NULL` AND `deposit_waiver_verified_at IS NULL` — deposit waiver OTP pending
2. `vendor_bills` where `approval_status = 'pending'`
3. `material_requests` where `status = 'pending'`

Returns up to 20 items per source, sorted oldest-first.

---

### `GET /api/dashboard/occupancy`

**Access:** `admin`, `manager` only (403 for others). Uses `createAdminClient`.

**Query param:** `location_id` optional

**Tables:** `space_units` (filtered `is_active = true`), `space_seat_occupants` (filtered `status = 'active'`), `locations`

**Exclusion rule:** Units with `type = 'business_centre'` are excluded from capacity count — they are hourly-only units, not seats.

**Response:**
```typescript
{
  data: {
    total_capacity: number;
    total_occupied: number;
    total_vacant: number;
    overall_pct: number;
    locations: {
      location_id: string;
      location_name: string;
      capacity: number;
      occupied: number;
      vacant: number;
      occupancy_pct: number;
    }[];
  }
}
```
Locations sorted descending by `occupancy_pct`.

---

### `GET /api/dashboard/revenue-pulse`

**Access:** `admin`, `manager`, `accounts`. Uses `createAdminClient`.

**Query param:** `location_id` optional

**Window:** current month MTD vs same-period last month (same day of month cutoff).

**Revenue streams:**
- `contract_payments` where `status = 'verified'`
- `booking_payments` where `status = 'verified'`
- `prepaid_purchases` where `payment_status = 'paid'`

Location filtering is done in JS after fetching (nested join via `contract.lead.location_id` or `booking.location_id`).

**Response:**
```typescript
{
  data: {
    total_mtd: number;
    total_last_mtd: number;
    change_pct: number | null;  // null when last month = 0
    streams: {
      contracts: { current: number; previous: number };
      bookings: { current: number; previous: number };
      prepaid: { current: number; previous: number };
    };
  }
}
```

---

### `GET /api/dashboard/cash-aging`

**Access:** `admin`, `accounts` only. Uses `createAdminClient`.

**Receivables:** `billing_statements` where `status = 'finalized'` AND `payment_status != 'paid'` — uses `period_end` as the aging reference date.

**Payables:** `vendor_bills` where `payment_status IN ('unpaid', 'partially_paid')` — uses `due_date` if set, falls back to `invoice_date`, then today.

**Buckets:**
- `current`: `age < 0` (not yet due)
- `d_0_30`: 0–30 days
- `d_31_60`: 31–60 days
- `d_60_plus`: 61+ days

---

### `GET /api/dashboard/renewals`

**Access:** `admin`, `manager`, `accounts`. Uses `createAdminClient`.

**Query param:** `location_id` optional

**Window:** contracts with `status = 'active'` and `end_date` between today and +60 days.

**Renewal status computation (per contract):**
```
if renewal_declined       → "declined"
else if child active      → "renewed"
else if child exists      → "in_progress"
else if reminder_count > 0 → "reminded"
else                      → "pending"
```

Returns up to 8 items. `monthly_value` = `total_amount / max(tenure_months, 1)`.

---

### `GET /api/dashboard/sla-risk`

**Access:** `admin`, `manager`, `fms`, `it_manager`, `it_technician`, `office_admin`. Uses `createAdminClient`.

**SLA targets (hours by priority):**
```
critical: 4
high:     24
medium:   72
low:      168  (7 days)
```

**Sources:**
- `support_tickets` where `status IN ('open', 'in_progress', 'build_approved')`
- `facility_issues` where `status IN ('new', 'acknowledged', 'in_progress', 'reopened')`

Location filter applies only to `facility_issues` (support_tickets have no `location_id`).

---

### `GET /api/dashboard/lead-funnel`

**Access:** authenticated. `sales_rep` and `floor_manager` see only their own leads.

**Active pipeline stages** (terminal statuses `won`/`lost` excluded):
`new`, `contacted`, `tour_scheduled`, `tour_completed`, `proposal_sent`, `negotiating`

**Aging threshold:** 7 days since `updated_at` (or `created_at` if no updates).

---

### `GET /api/dashboard/source-roi`

**Access:** `admin`, `manager`. Uses `createAdminClient`.

**Window:** leads created in the last 180 days.

**Revenue:** sum of `contracts.total_amount` for `status IN ('active', 'renewed')` contracts linked to won leads. Only the first contract per lead is counted (not renewals stacked).

---

### `GET /api/dashboard/aggregator-performance`

**Access:** `admin`, `manager`, `accounts`. Uses `createAdminClient`.

**Tables:** `aggregators`, `cases`, `aggregator_invoices`

**Invoice window:** `period_year = current year`, `status IN ('sent', 'overdue', 'paid')`. Outstanding = sent + overdue invoices.

Returns top 8 aggregators sorted by `outstanding_ytd DESC`.

---

### `GET /api/dashboard/mtd-bookings`

**Access:** `admin`, `manager`, `accounts`, `office_admin`, `floor_manager`. Uses `createAdminClient`.

**Exclusion:** `customer_type = 'contract_holder'` AND `total_amount = 0` → free-quota bookings excluded. A contract holder with a non-zero total is a real paid booking and is kept.

**Window:** bookings where `booking_date` falls in current month.

---

### `GET /api/dashboard/rent-revenue`

**Access:** `admin` only. Uses `createAdminClient`.

**Rent:** `lease_payments` where `payment_month = 'YYYY-MM'` AND `status = 'paid'`. Net = `gross_rent_amount - tds_amount`.

**Revenue:** `billing_statements` where `status IN ('finalized', 'exported')` AND period overlaps current month, joined to `contracts.location_id`.

`rent_ratio` = rent / revenue × 100 (null if no revenue). Useful for seeing which locations run at a loss.

---

### `GET /api/dashboard/quota-overuse`

**Access:** `admin`, `manager`, `accounts`. Uses `createAdminClient`.

Queries `service_usage_records` where `period_year = current`, `period_month = current`, `amount > 0`, `billing_statement_id IS NULL`. Unbilled overages that haven't been included in a statement yet.

---

### `GET /api/dashboard/procurement-spend`

**Access:** `admin`, `fms`, `accounts`, `office_admin`. Uses `createAdminClient`.

**Chain:** `vendor_bills` → `purchase_orders.po_id` → `purchase_requests.department`

Department budgets from `department_budgets` where `is_active = true`.

---

### `GET /api/dashboard/schedule`

**Access:** authenticated. `sales_rep` / `floor_manager` see only own leads.

**Sources for today's schedule:**
1. `bookings` where `booking_date = today`, `status != 'cancelled'`
2. `activities` of type `meeting` or `tour` with `meeting_start_at` in today
3. `activities` with `is_follow_up_done = false` and `follow_up_date` in today

Items merged and sorted by time. Returns up to 12 items.

---

### `GET /api/dashboard/team`

**Access:** `admin`, `manager` only. Uses `createAdminClient`.

**Window:** current ISO week (Monday to Sunday).

Counts activities created by each user + tasks completed (status = 'done', `updated_at` in this week). All active users included regardless of activity.

---

### `GET /api/dashboard/member-health`

**Access:** `admin`, `manager`. Uses `createAdminClient`.

**Source:** `booking_feedbacks` from the last 90 days.

**At-risk threshold:** `avg_renewal_likelihood <= 2.5` OR `avg_overall_rating <= 2.5`.

Promoters: `avg_renewal >= 4`. Detractors: `avg_renewal <= 2`.

Returns up to 5 at-risk members sorted by lowest `avg_renewal`.

---

### `GET /api/dashboard/financial`

**Access:** `admin`, `accounts`. Uses `createAdminClient`.

Returns outstanding vendor bills (unpaid + partially_paid) and overdue contracts count.

---

### `GET /api/dashboard/recent-leads`

**Access:** authenticated. `sales_rep`/`floor_manager` see own leads only.

Returns last 10 leads by `created_at DESC` with assigned user and last activity per lead.

---

### `GET /api/dashboard/bookings`

**Access:** all roles except `sales_rep` (returns 403). Uses `createAdminClient`.

Returns today's booking summary: total, confirmed, completed, no_show, cancelled counts + revenue (sum of verified `booking_payments`).

---

### `GET /api/dashboard/support`

**Access:** `admin` only. Uses `createAdminClient`.

Returns counts for `open`, `in_progress`, `build_approved` support tickets.

---

### `GET /api/dashboard/procurement`

**Access:** `admin`, `manager`, `fms`. Uses `createAdminClient`.

Returns pending PRs (status = `submitted`), pending PO approvals (status = `pending`), unpaid vendor bills count and total.

---

### `GET /api/settings/dashboard`

Widget configuration endpoint.

- **GET without role param:** full config JSON for all roles (admin only — 403 otherwise)
- **GET with `?role=<role>`:** widget array for that role (any authenticated user)
- **PATCH:** update widget order/visibility for a role (admin only). Body: `{ role: UserRole, widgets: WidgetId[] }`. Validated against `WIDGET_REGISTRY`. Audit-logged via `logAudit()`.

**Storage:** `app_settings` table, key = `"dashboard_role_widgets"`, value = JSON string `Record<UserRole, WidgetId[]>`.

**Merge behavior on read:** if the DB config doesn't include a widget that exists in the code defaults (a newly added widget), it's automatically appended after the saved list. This ensures new widgets appear without requiring a DB update.

---

### `GET /api/followups`

**Access:** authenticated.

Returns activities where `is_follow_up_done = false` AND `follow_up_date IS NOT NULL`, ordered by `follow_up_date ASC`, limit 25. Scoped to location if `location_id` param provided. Uses RLS-scoped `createClient` (no admin bypass), so sales reps naturally only see their own leads' follow-ups via RLS policies.

---

## Data Model

### Tables Queried by Dashboard

| Table | Key Columns Used |
|-------|-----------------|
| `leads` | `id`, `status`, `source`, `created_at`, `assigned_to`, `location_id`, `tags` |
| `activities` | `id`, `type`, `subject`, `lead_id`, `created_by`, `created_at`, `is_follow_up_done`, `follow_up_date`, `meeting_start_at` |
| `tasks` | `id`, `lead_id`, `status`, `due_date`, `assigned_to` |
| `contracts` | `id`, `status`, `end_date`, `total_amount`, `tenure_months`, `seats`, `location_id`, `renewal_declined`, `renewal_reminder_count`, `parent_contract_id` |
| `contract_payments` | `amount`, `payment_date`, `status` (verified/pending/rejected) |
| `billing_statements` | `id`, `status`, `payment_status`, `period_start`, `period_end`, `total_amount` |
| `booking_payments` | `amount`, `status` |
| `prepaid_purchases` | `total_amount`, `payment_status`, `purchase_date`, `location_id` |
| `vendor_bills` | `id`, `total_amount`, `amount_paid`, `payment_status`, `approval_status`, `invoice_date`, `due_date`, `po_id` |
| `material_requests` | `id`, `request_number`, `title`, `status`, `created_at` |
| `purchase_requests` | `status`, `department` |
| `purchase_orders` | `status`, `location_id`, `po_id` |
| `proposals` | `id`, `proposal_number`, `security_deposit_months`, `deposit_waiver_requested_at`, `deposit_waiver_verified_at` |
| `space_units` | `id`, `location_id`, `capacity`, `is_active`, `type` |
| `space_seat_occupants` | `id`, `location_id`, `status` |
| `support_tickets` | `id`, `priority`, `status`, `created_at` |
| `facility_issues` | `id`, `priority`, `status`, `created_at`, `location_id` |
| `booking_feedbacks` | `id`, `lead_id`, `overall_rating`, `renewal_likelihood`, `created_at` |
| `bookings` | `id`, `booking_date`, `start_time`, `end_time`, `status`, `total_amount`, `location_id`, `customer_type` |
| `service_usage_records` | `id`, `contract_id`, `period_year`, `period_month`, `amount`, `total_with_gst`, `billing_statement_id` |
| `aggregators` | `id`, `name`, `status` |
| `cases` | `id`, `aggregator_id`, `status`, `total_amount`, `rate` |
| `aggregator_invoices` | `id`, `aggregator_id`, `status`, `total_amount`, `period_year` |
| `lease_payments` | `net_amount_paid`, `gross_rent_amount`, `tds_amount`, `payment_month`, `status` |
| `property_leases` | `location_id` |
| `department_budgets` | `department`, `location_id`, `monthly_budget`, `is_active` |
| `users` | `id`, `auth_id`, `role`, `full_name`, `is_active` |
| `locations` | `id`, `name` |
| `whatsapp_messages` | `id`, `direction`, `channel`, `from_number`, `message_body`, `entity_type`, `entity_id`, `created_at` |
| `app_settings` | `key`, `value` — stores `"dashboard_role_widgets"` JSON |

### `app_settings` Table Schema

```sql
CREATE TABLE app_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key VARCHAR(100) UNIQUE NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  is_encrypted BOOLEAN DEFAULT false,
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

RLS: all authenticated users can SELECT, INSERT, UPDATE. The `"dashboard_role_widgets"` key is accessible to all roles on read; writes require admin check at the application layer (not the DB layer).

---

## Widget Configuration System

### How Widget Config is Resolved (Client → Server → DB → Defaults)

1. On page load, `fetchWidgetConfig(role)` calls `GET /api/settings/dashboard?role=<role>`.
2. Server reads `app_settings` key `"dashboard_role_widgets"`. If the key has a saved array for this role, it returns that array merged with any new widgets from `DASHBOARD_ROLE_WIDGETS[role]` that weren't in the saved config.
3. If no saved config, returns the hardcoded `DASHBOARD_ROLE_WIDGETS[role]`.
4. Client applies the same merge logic as a safety net.

### Adding a New Widget

1. Add the `WidgetId` string literal to the union in `src/lib/dashboard-config.ts`.
2. Add an entry to `WIDGET_REGISTRY`.
3. Add the widget ID to the relevant role arrays in `DASHBOARD_ROLE_WIDGETS`.
4. Add a `case` in the `renderWidget()` switch in `src/app/(dashboard)/dashboard/page.tsx`.
5. Create the component in `src/components/dashboard/widgets/`.
6. If the widget needs its own API, create it under `src/app/api/dashboard/<widget-name>/route.ts`.

The merge-on-read behavior means existing users will automatically see new widgets appended to their current list without a DB migration.

---

## Role Permissions and Widget Access

### Widget Layout by Role (default, configurable by admin)

| Role | Widgets (in order) |
|------|--------------------|
| `admin` | pending_actions, live_enquiries, kpi_stats, mtd_bookings, revenue_pulse, renewal_pipeline, cash_aging, rent_revenue, occupancy, sla_risk, lead_funnel, source_roi, schedule, member_health, aggregator_performance, quota_overuse, procurement_spend, team_performance, followups |
| `manager` | pending_actions, live_enquiries, kpi_stats, mtd_bookings, schedule, renewal_pipeline, occupancy, lead_funnel, revenue_pulse, sla_risk, source_roi, member_health, team_performance, followups |
| `sales_rep` | live_enquiries, schedule, lead_funnel, kpi_stats, followups, recent_leads |
| `floor_manager` | live_enquiries, schedule, booking_summary, mtd_bookings, kpi_stats, followups |
| `accounts` | mtd_bookings, cash_aging, revenue_pulse, renewal_pipeline, quota_overuse, aggregator_performance, procurement_spend, financial_summary |
| `fms` | sla_risk, procurement_spend, procurement_summary |
| `office_admin` | schedule, mtd_bookings, procurement_spend, sla_risk, procurement_summary, booking_summary |
| `it_manager` | network, sla_risk |
| `it_technician` | network, sla_risk |
| `viewer` | kpi_stats, mtd_bookings, revenue_pulse, occupancy, renewal_pipeline, cash_aging, sla_risk, procurement_spend |

### API-Level Access Control (per endpoint)

| Endpoint | Allowed Roles |
|----------|--------------|
| `/api/dashboard` | All authenticated (role-scoped results) |
| `/api/dashboard/pending-actions` | admin, manager |
| `/api/dashboard/occupancy` | admin, manager |
| `/api/dashboard/revenue-pulse` | admin, manager, accounts |
| `/api/dashboard/cash-aging` | admin, accounts |
| `/api/dashboard/renewals` | admin, manager, accounts |
| `/api/dashboard/sla-risk` | admin, manager, fms, it_manager, it_technician, office_admin |
| `/api/dashboard/lead-funnel` | All authenticated (own leads for sales_rep/floor_manager) |
| `/api/dashboard/source-roi` | admin, manager |
| `/api/dashboard/aggregator-performance` | admin, manager, accounts |
| `/api/dashboard/mtd-bookings` | admin, manager, accounts, office_admin, floor_manager |
| `/api/dashboard/rent-revenue` | admin only |
| `/api/dashboard/quota-overuse` | admin, manager, accounts |
| `/api/dashboard/procurement-spend` | admin, fms, accounts, office_admin |
| `/api/dashboard/schedule` | All authenticated (own leads for sales_rep/floor_manager) |
| `/api/dashboard/team` | admin, manager |
| `/api/dashboard/member-health` | admin, manager |
| `/api/dashboard/financial` | admin, accounts |
| `/api/dashboard/recent-leads` | All authenticated (own leads for sales_rep/floor_manager) |
| `/api/dashboard/bookings` | All except sales_rep |
| `/api/dashboard/support` | admin only |
| `/api/dashboard/procurement` | admin, manager, fms |
| `/api/settings/dashboard` GET (no role param) | admin only |
| `/api/settings/dashboard` GET (with role param) | All authenticated |
| `/api/settings/dashboard` PATCH | admin only |

---

## Real-time Enquiry Notifications

The enquiry notification system is one of the most complex parts of the dashboard. It uses a single Supabase Realtime channel (`"enquiry-alerts"`) shared via `EnquiryNotificationsProvider`.

### Realtime Subscriptions

Three events subscribed:

1. **`leads` INSERT** — triggers if `tags` overlaps `['google-ads-form', 'meta-ads-form', 'walkin-form']`. Increments `newLeadCount`, plays audio chime, queues an `EnquiryAlert`, shows a `toast.success`.

2. **`leads` UPDATE** — if the lead's status changes away from `"new"` and it has form tags, removes it from the alert list and decrements `newLeadCount`. This cleans up alerts when a sales rep picks up the lead.

3. **`activities` INSERT** — triggers if `subject` starts with `"Re-enquiry via"`. Fetches the lead name async, increments `reEnquiryCount`, plays chime, queues alert.

4. **`whatsapp_messages` INSERT** with filter `direction=eq.inbound` — increments `waInboundCount`, plays chime, shows toast.

### Persistence

- **New lead count:** live state only (reset on page reload from DB query)
- **Re-enquiry seen:** `localStorage` key `twv_last_seen_reenquiry` (ISO timestamp). On load, only activities after this timestamp are counted.
- **WhatsApp seen:** `localStorage` key `twv_last_seen_wa_inbound`. Default look-back: 24 hours.
- **Alert queue:** in-memory only; dismissed alerts are gone on refresh.

### Self-healing

On `document.visibilitychange` to `"visible"`, if more than 120 seconds have passed since last load, `loadInitialData()` is called again. This handles stale state when the user returns after a long absence.

### Audio Chime

Two-tone sine wave generated via Web Audio API (880 Hz → 1320 Hz). No external audio file. Silently fails in restrictive audio environments.

---

## Layout Architecture

### Full-width vs. Grid Widgets

Three widgets always render full-width, outside the masonry grid:
- `pending_actions`
- `live_enquiries`
- `kpi_stats`

All other widgets are rendered in a CSS masonry grid:
```css
.columns-1.md:columns-2.lg:columns-3.gap-6.space-y-6.[&>*]:break-inside-avoid
```

This means adding a new widget to the `FULL_WIDTH` array in `page.tsx` changes it from grid to full-width. Currently hardcoded — not configurable from the admin settings UI.

### Loading Skeleton

While `userRole` is not yet loaded (user context pending), the page renders 4 empty skeleton cards. Once the role is known, widget config is fetched, then widgets mount. Widgets that depend on `/api/dashboard` stats (`kpi_stats`, `recent_activities`, `notes`) render `null` until stats arrive — they do not show their own skeleton while waiting.

Widgets that fetch from their own endpoints start fetching independently in parallel, so first paint is not blocked by the slowest widget.

---

## Location Filter

A `LocationSelector` in the page header allows filtering the entire dashboard to a specific location. The selected `location_id` is passed as a prop to widgets that support it. Widgets that don't accept a `locationFilter` prop (e.g., `financial_summary`, `cash_aging`, `aggregator_performance`, `quota_overuse`) always show global data.

The location filter is local state — it is not persisted to localStorage or URL params.

---

## Business Rules

1. **Conversion rate excludes pre-April 2026 leads.** `CONVERSION_CUTOFF = "2026-04-01"`. Pipeline totals include all leads. If the team wants a tighter window, bump this constant in `src/app/api/dashboard/route.ts`. All three code paths (self-scoped, location-filtered, global) must use the same cutoff — they currently do.

2. **PostgREST 1,000-row cap.** Pipeline queries use `.range(0, 9999)` explicitly. Without this, pipeline counts silently truncate at 1,000 leads. Never remove the range call.

3. **`business_centre` units excluded from occupancy.** `space_units` with `type = 'business_centre'` are skipped when summing `capacity`. Only fixed-seat unit types count.

4. **Free-quota bookings excluded from MTD bookings.** `customer_type = 'contract_holder'` + `total_amount = 0` = free quota. Do not pre-filter in SQL because a contract holder with `total_amount > 0` is a real paid booking.

5. **Rent-revenue ratio uses gross_rent minus TDS.** `net = gross_rent_amount - tds_amount`. TDS is deducted by the operator, so it is not cash the vendor receives.

6. **Dashboard widget config is per-role, not per-user.** All users sharing a role see the same widget layout. There is no per-user customization.

7. **Pending actions widget is `admin`/`manager` only** at the API level but does not return a 403 — it returns an empty array for other roles. The widget component itself calls the API unconditionally and just renders nothing if the array is empty.

8. **Re-enquiry detection** relies on `activity.subject` starting with `"Re-enquiry via"` — this is a string convention, not a flag column. Breaking this string format (e.g., changing how re-enquiry activities are created) will silently break the notification system.

9. **Conversion rate denominator** is `won + lost + active pipeline` (not `won / total_ever`). Specifically it's leads created since `CONVERSION_CUTOFF` regardless of status, so a lead sitting at `negotiating` is in the denominator.

---

## Integration Points with Other Modules

| Dashboard Feature | Links To |
|-------------------|----------|
| Live enquiries | `/leads?status=new`, `/leads/:id` |
| Pending actions - waiver | `/proposals/:id` |
| Pending actions - vendor bills | `/procurement/bills/:id` |
| Pending actions - material requests | `/procurement/requests/:id` |
| Follow-ups widget | `/leads/:id?tab=activities&highlight=:activity_id` |
| Renewal pipeline | `/leads/:id` (via lead_id) |
| SLA risk | `support_tickets`, `facility_issues` tables |
| Revenue pulse | `contract_payments`, `booking_payments`, `prepaid_purchases` |
| Quota overuse | `service_usage_records` (links to billing module) |
| Rent revenue | `lease_payments`, `property_leases` (Finance > Rent module) |
| Aggregator performance | `aggregators`, `cases`, `aggregator_invoices` |

---

## Known Pitfalls and Gotchas

### 1. Widget Config Merge — New Widgets Auto-Append

When a new widget is added to `DASHBOARD_ROLE_WIDGETS` in code, it automatically appends to the saved DB config for that role on the next GET. This is intentional. The consequence: removing a widget from the code defaults does NOT remove it from existing saved configs — it will show as an unknown widget ID (the `default: return null` in the switch handles this gracefully).

### 2. `NULL_ID` Sentinel for Empty User Pipelines

When a `sales_rep` has zero leads, the query uses a nil UUID (`"00000000-0000-0000-0000-000000000000"`) as a fake lead ID to filter tasks/activities. This returns an empty result set without a full-table scan. If the tasks or activities tables have a row with this lead_id for any reason, it would incorrectly appear in that user's dashboard.

### 3. Location Filter Does Not Affect All Widgets

Widgets like `cash_aging`, `aggregator_performance`, `financial_summary`, `quota_overuse`, `rent_revenue`, and `support_summary` always show global data regardless of the location selector. This is by design — these are cross-location finance views. If a user selects a location, they may see widgets with mismatched scopes in the same view.

### 4. Realtime Subscription Deduplication

`EnquiryNotificationsProvider` wraps the entire dashboard layout. **Do not add a second `EnquiryNotificationsProvider` or call `useEnquiryNotificationsCore()` directly** from a component inside the layout — this creates duplicate Supabase channels. Always use `useEnquiryNotifications()` (the context hook) inside the layout.

### 5. Revenue Pulse — Location Filtering in JS

Revenue pulse does not filter by location in the SQL query. It fetches all verified payments for the month and then filters in JS by `contract.lead.location_id` or `booking.location_id`. This means it fetches more data than needed when a location filter is active. For high-volume months this may become slow.

### 6. Schedule Widget — UTC vs. IST

`start_time` for bookings is stored as a `TIME` type (plain time, no timezone). The schedule widget formats it with `.slice(0, 5)` (taking `HH:MM`). Activities use `meeting_start_at` (TIMESTAMPTZ), which is formatted with `getHours()`/`getMinutes()` in the browser's local timezone. If the server and browser are in different timezones, meeting times may display differently than booking times.

### 7. Conversion Rate Double-Display

`KpiStatsWidget` shows two conversion rates: cumulative since `CONVERSION_CUTOFF` (primary, large number) and this-month cohort (secondary, smaller). Both use data from the same `/api/dashboard` response. The `this_month` field is optional in the type — if the API doesn't return it, the secondary section simply doesn't render.

### 8. `sales_rep` Gets 403 from `/api/dashboard/bookings`

The booking summary widget is not in the `sales_rep` default widget list, but if an admin enables it for `sales_rep` via dashboard settings, the API will return a 403. The widget should handle this gracefully (rendering null/empty), but it's a mismatch to be aware of.

---

## TypeScript Types

### `DashboardStats` (from `src/types/index.ts`)

```typescript
export interface DashboardStats {
  pipeline: { status: LeadStatus; count: number }[];
  tasks_due_today: number;
  tasks_overdue: number;
  recent_activities: Activity[];
  recent_notes: DashboardNote[];
  conversion: {
    total_leads: number;
    won: number;
    lost: number;
    rate: number;
    this_month?: { total: number; won: number; rate: number };
  };
  pending_follow_ups: number;
}
```

### `WidgetId` (from `src/lib/dashboard-config.ts`)

A string union of all 26 widget identifiers. See `WIDGET_REGISTRY` for the human-readable title of each.

### `PendingActionItem` (from `src/app/api/dashboard/pending-actions/route.ts`)

```typescript
export interface PendingActionItem {
  module: string;     // "Deposit Waiver" | "Vendor Bills" | "Material Requests"
  title: string;
  subtitle: string;
  link: string;       // internal CRM URL
  created_at: string; // ISO timestamp
  id: string;         // composite key: "waiver-{uuid}" | "bill-{uuid}" | "mr-{uuid}"
}
```

---

## Environment / Config Dependencies

| Key | Source | Purpose |
|-----|--------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | env var | Supabase connection for realtime + REST |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | env var | Client-side Supabase auth |
| `SUPABASE_SERVICE_ROLE_KEY` | env var | `createAdminClient()` — bypasses RLS for dashboard API routes |
| `app_settings.dashboard_role_widgets` | DB (app_settings table) | Saved widget config per role; falls back to code defaults if absent |

No feature flags or additional env vars are specific to the dashboard. All financial keys (Razorpay, MSG91, etc.) are irrelevant here — the dashboard is read-only.

---

## Key User Flows

### Flow 1: Admin Opens Dashboard

1. Browser navigates to `/dashboard`
2. `DashboardMain` mounts: registers service worker, wraps children with `EnquiryNotificationsProvider`
3. `EnquiryNotificationsProvider` calls `useEnquiryNotificationsCore()` → initial DB query loads unread enquiries + re-enquiries + WhatsApp messages; Supabase Realtime channel subscribed
4. `Header` renders: shows `NotificationBell` (badge count from context), `ApprovalBell`, `InAppNotificationBell`
5. `DashboardPage` mounts: reads `user` from `CurrentUserProvider`, calls `fetchWidgetConfig("admin")` → `GET /api/settings/dashboard?role=admin`
6. Widget config returned; page calls `fetchStats()` → `GET /api/dashboard`
7. Full-width widgets render: `pending_actions`, `live_enquiries`, `kpi_stats` (last two wait for stats)
8. Grid widgets mount in parallel, each calling their own API endpoint independently
9. As each widget's API responds, it renders its content

### Flow 2: New Enquiry Arrives in Real-time

1. A visitor submits the Google Ads form at `/enquire`
2. A lead is created in the `leads` table with tag `google-ads-form` and `status = 'new'`
3. Supabase broadcasts the `INSERT` event to the `"enquiry-alerts"` channel
4. `useEnquiryNotificationsCore` receives the event: plays two-tone chime, increments `newLeadCount`, adds to `alertQueue`, shows `toast.success`
5. `EnquiryAlertBanner` detects a non-empty `alertQueue` → slides in a green banner at the top of the page
6. `NotificationBell` badge updates from context (no re-fetch needed)
7. `LiveEnquiriesWidget` on the dashboard page re-renders from the same context
8. When a sales rep opens the lead and changes status away from `"new"`, the `UPDATE` event fires → lead is removed from `newLeadCount` and the `recentItems` list

### Flow 3: Admin Customizes Widget Layout

1. Admin navigates to `/admin/settings` (dashboard tab)
2. `DashboardSettings` component fetches `GET /api/settings/dashboard` (no role param) → returns full config for all roles
3. Admin selects a role tab, reorders or toggles widgets
4. Clicks Save → `PATCH /api/settings/dashboard` with `{ role, widgets }`
5. Server validates role and widget IDs against `WIDGET_REGISTRY`, upserts `app_settings` with key `"dashboard_role_widgets"`, audit-logs the change
6. Next time a user of that role loads the dashboard, `fetchWidgetConfig` returns the new order

### Flow 4: Sales Rep Dashboard (Scoped View)

1. Sales rep logs in, navigates to `/dashboard`
2. Widget config for `sales_rep` loads: `live_enquiries`, `schedule`, `lead_funnel`, `kpi_stats`, `followups`, `recent_leads`
3. `kpi_stats` calls `GET /api/dashboard` → server detects `role = 'sales_rep'`, queries only leads with `assigned_to = dbUser.id`
4. Conversion rate, tasks, follow-ups — all scoped to this user's leads
5. `lead_funnel` calls `GET /api/dashboard/lead-funnel` → `sales_rep` path: `assigned_to = dbUser.id`
6. `recent_leads` calls `GET /api/dashboard/recent-leads` → same scoping
7. Admin-only widgets (pending_actions, cash_aging, etc.) are not in this role's widget list
