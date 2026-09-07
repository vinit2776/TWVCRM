# Facility Management

**Last Updated: 2026-06-28**

## Purpose and Business Context

The Facility Management module is the internal help-desk and asset management layer for The WorkVilla. It covers two interconnected domains:

1. **Issue tracking** — members and staff report problems (WiFi down, AC broken, plumbing leak), technicians resolve them under SLA
2. **Asset lifecycle** — physical equipment is registered, tracked through lifecycle stages, and linked to issues and AMC contracts

Primary use-cases:
- Members or staff report an issue across any scope (IT, HVAC, Electrical, Plumbing, Housekeeping, Security)
- Technicians receive notifications, acknowledge, work on, and resolve issues
- Managers track SLA compliance and technician KPIs for appraisals
- Auto-satisfaction surveys are sent to the reporter after resolution
- FMS/IT teams register assets, log maintenance events, and track lifecycle from procurement to decommission
- Asset event logs link to facility issues for traceability

All seven scopes are fully enabled — the wizard presents scope buttons (IT, HVAC, Electrical, Plumbing, Housekeeping, Security, Other) and non-IT categories have been seeded (migration 00276).

---

## Routes

| Route | Page file | Who sees it | Purpose |
|---|---|---|---|
| `/facility` | `src/app/(dashboard)/facility/page.tsx` | All authenticated | Analytics dashboard: KPI cards, hot spots, SLA compliance, trend chart, recurring issues |
| `/facility/issues` | `src/app/(dashboard)/facility/issues/page.tsx` | All authenticated | List all issues with filter/search; Report Issue button |
| `/facility/issues/[id]` | `src/app/(dashboard)/facility/issues/[id]/page.tsx` | All authenticated | Issue detail: description, photos, timeline, sidebar, status transitions |
| `/facility/assets` | `src/app/(dashboard)/facility/assets/page.tsx` | All authenticated | Equipment inventory grouped by location |
| `/facility/assets/[id]` | `src/app/(dashboard)/facility/assets/[id]/page.tsx` | All authenticated | Asset detail with full issue history |
| `/facility/assets/[id]/print` | `src/app/(dashboard)/facility/assets/[id]/print/page.tsx` | All authenticated | Print QR code sheet — Avery 21-up (63.5×38mm), 9-up cut, or single large label |
| `/asset/[code]` | `src/app/asset/[code]/page.tsx` | **Public (no auth)** | QR scan landing page — shows asset info; if logged-in staff, redirects to dashboard detail; provides issue report and service upload forms |
| `/facility/my-issues` | `src/app/(dashboard)/facility/my-issues/page.tsx` | All authenticated | Technician home — tabs: Open / In Progress / Resolved Today; sticky mobile FAB |
| `/facility/team-kpi` | `src/app/(dashboard)/facility/team-kpi/page.tsx` | All authenticated (primarily managers) | Per-technician performance table with CSV export |

All pages are `"use client"` components that fetch from the API routes below.

---

## Key Source Files

### Pages
- `src/app/(dashboard)/facility/page.tsx` — dashboard
- `src/app/(dashboard)/facility/issues/page.tsx` — issue list
- `src/app/(dashboard)/facility/issues/[id]/page.tsx` — issue detail
- `src/app/(dashboard)/facility/assets/page.tsx` — asset list
- `src/app/(dashboard)/facility/assets/[id]/page.tsx` — asset detail
- `src/app/(dashboard)/facility/assets/[id]/print/page.tsx` — print QR code (Avery/sheet/single layouts; uses `qrcode` npm package)
- `src/app/asset/[code]/page.tsx` — **public** QR scan landing (outside dashboard layout, no auth required)
- `src/app/(dashboard)/facility/my-issues/page.tsx` — technician view
- `src/app/(dashboard)/facility/team-kpi/page.tsx` — KPI table

### Components
- `src/components/facility/report-wizard.tsx` — `FacilityReportWizard` — 3-step issue creation dialog (rewritten v2 — see Wizard section below)
- `src/components/facility/asset-form-dialog.tsx` — `FacilityAssetFormDialog` — add/edit asset dialog; updated to support photo uploads via `facility_asset_photos`
- `src/components/facility/asset-event-dialog.tsx` — `AssetEventDialog` — log maintenance/inspection events on an asset, optionally link to and resolve an open issue
- `src/components/facility/photo-upload.tsx` — `FacilityPhotoUpload` — upload to `facility-issue-photos` bucket
- `src/components/facility/qr-scanner-dialog.tsx` — `QrScannerDialog` — QR code scanner for scanning asset QR codes in the field; quickly pulls up an asset record from a printed QR without navigating manually

### API Routes
- `GET/POST /api/facility/issues` — `src/app/api/facility/issues/route.ts`
- `GET/PUT/DELETE /api/facility/issues/[id]` — `src/app/api/facility/issues/[id]/route.ts`
- `PATCH /api/facility/issues/[id]/status` — `src/app/api/facility/issues/[id]/status/route.ts`
- `POST /api/facility/issues/[id]/assign` — `src/app/api/facility/issues/[id]/assign/route.ts`
- `POST /api/facility/issues/[id]/comment` — `src/app/api/facility/issues/[id]/comment/route.ts`
- `GET/POST/DELETE /api/facility/issues/[id]/collaborators` — `src/app/api/facility/issues/[id]/collaborators/route.ts`
- `GET/POST /api/facility/issues/[id]/time-logs` — `src/app/api/facility/issues/[id]/time-logs/route.ts` (manual worklog; summed into `/facility/team-kpi`'s "Hours Logged" column)
- `POST/DELETE /api/facility/issues/[id]/attachments` — `src/app/api/facility/issues/[id]/attachments/route.ts`
- `GET/POST /api/facility/assets` — `src/app/api/facility/assets/route.ts` (supports `?search=` for asset search)
- `GET/PUT/DELETE /api/facility/assets/[id]` — `src/app/api/facility/assets/[id]/route.ts`
- `GET/POST /api/facility/assets/[id]/events` — `src/app/api/facility/assets/[id]/events/route.ts` (asset event log with issue linking)
- `POST/DELETE /api/facility/assets/[id]/photos` — `src/app/api/facility/assets/[id]/photos/route.ts` (asset photo uploads; bucket: `facility-asset-photos`)
- `GET/POST/DELETE /api/facility/assets/[id]/documents` — `src/app/api/facility/assets/[id]/documents/route.ts` (two-tier document management)
- `GET/POST /api/facility/assets/[id]/amc` — `src/app/api/facility/assets/[id]/amc/route.ts` (AMC summary + service event history for an asset)
- `GET/POST /api/facility/checklist-templates` — `src/app/api/facility/checklist-templates/route.ts` (per-category checklists)
- `GET /api/public/asset/[code]` — `src/app/api/public/asset/[code]/route.ts` (unauthenticated asset lookup by asset code; also checks for active AMC)
- `POST /api/public/asset/[code]/report` — `src/app/api/public/asset/[code]/report/route.ts` (unauthenticated issue report submitted from QR scan page)
- `POST /api/public/asset/[code]/service/upload` — `src/app/api/public/asset/[code]/service/upload/route.ts` (vendor service sheet upload via public QR scan)
- `GET/POST /api/facility/categories` — `src/app/api/facility/categories/route.ts`
- `GET/PUT/PATCH/DELETE /api/facility/categories/[id]` — `src/app/api/facility/categories/[id]/route.ts` (PATCH updates `default_assignee_id` / `backup_assignee_id` only)
- `GET /api/facility/assets/[id]/cost-summary` — `src/app/api/facility/assets/[id]/cost-summary/route.ts` (monthly cost-of-ownership aggregated from approved vendor bills)
- `GET /api/facility/assignees` — `src/app/api/facility/assignees/route.ts`
- `GET /api/cron/facility-sla-check` — `src/app/api/cron/facility-sla-check/route.ts` (every 6h cron; marks breached issues, sends digest per recipient)
- `GET /api/facility/dashboard` — `src/app/api/facility/dashboard/route.ts`
- `GET /api/facility/team-kpi` — `src/app/api/facility/team-kpi/route.ts`
- `GET/POST /api/facility/satisfaction/[token]` — `src/app/api/facility/satisfaction/[token]/route.ts` (PUBLIC — no auth)

### Lib Files
- `src/lib/facility.ts` — server-side: issue number generation, SLA computation, transition guard, timestamp side-effects, `logIssueEvent`, role constants
- `src/lib/facility-ui.ts` — client-side: style maps for priority/status/scope/root-cause/via, `timeAgo`, `timeUntil`, `formatDuration`, `nextStatusOptions`
- `src/lib/facility-notifications.ts` — centralised notification helpers: `notifyIssueAssignee(issue, event)` (category-driven, notifies assigned user + backup assignee + collaborators), `notifyAdminsStaleAssignee(params)` (fires when a category's `default_assignee_id` points to an inactive/missing user), plus helpers for SLA breach alerts and assignment notifications

### Type Definitions
`src/types/index.ts` starting at line 2594

---

## Database Tables

All DB enums and tables are defined in migration `00116_facility_issues.sql`.

### Enums (PostgreSQL types)

| Enum | Values |
|---|---|
| `facility_scope` | `it`, `hvac`, `plumbing`, `electrical`, `housekeeping`, `security`, `other` |
| `facility_issue_priority` | `low`, `medium`, `high`, `critical` |
| `facility_issue_status` | `new`, `acknowledged`, `in_progress`, `resolved`, `closed`, `reopened` |
| `facility_root_cause` | `hardware_failure`, `config_issue`, `isp_outage`, `power_issue`, `user_error`, `scheduled_maintenance`, `wear_and_tear`, `environmental`, `unknown`, `other` |
| `facility_reported_via` | `walk_in`, `phone`, `whatsapp`, `email`, `self_service`, `proactive`, `feedback` |
| `facility_asset_status` | `active`, `maintenance`, `retired` |
| `facility_attachment_phase` | `report`, `progress`, `resolution` |

### `facility_asset_categories`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `scope` | `facility_scope` NOT NULL | |
| `name` | VARCHAR(120) NOT NULL | |
| `slug` | VARCHAR(60) NOT NULL UNIQUE | e.g. `it-wifi-ap` |
| `icon` | VARCHAR(60) | Lucide icon name |
| `description` | TEXT | |
| `default_sla_critical_hrs` | NUMERIC(6,2) DEFAULT 2 | |
| `default_sla_high_hrs` | NUMERIC(6,2) DEFAULT 8 | |
| `default_sla_medium_hrs` | NUMERIC(6,2) DEFAULT 24 | |
| `default_sla_low_hrs` | NUMERIC(6,2) DEFAULT 72 | |
| `default_assignee_id` | UUID FK `users(id) ON DELETE SET NULL` | nullable — user auto-assigned when an issue is created for this category; NULL = unrouted (admins are alerted via `notifyAdminsStaleAssignee`) (migration 00292) |
| `backup_assignee_id` | UUID FK `users(id) ON DELETE SET NULL` | nullable — CC-notified on every new issue for this category; not the primary owner (migration 00292) |
| `sort_order` | INTEGER DEFAULT 0 | |
| `is_active` | BOOLEAN DEFAULT true | |
| `custom_field_schema` | JSONB DEFAULT `[]` | Array of `{key, label, type, required, options?}` defining category-specific fields (migration 00270) |

**Seeded IT categories (on first migration):** UDM/Router, Firewall, WiFi Access Point, Switch, LAN Socket/Cabling, ISP Link/Internet, Server/NAS, CCTV/Surveillance, Printer, Member Workstation, Door Access/Biometric, Other IT.

**SLA defaults by slug (for reference):**
- `it-udm-router`, `it-firewall`, `it-switch`, `it-isp`: Critical 1h, High 4h, Medium 12h, Low 48h
- `it-wifi-ap`: Critical 2h, High 6h, Medium 24h, Low 72h
- `it-isp`: Critical 1h, High 2h, Medium 6h, Low 24h (tightest SLAs)

**RLS:** SELECT — any `authenticated`. ALL (write) — roles `admin`, `manager`, `it_manager`, `fms` (migration 00270).

### `facility_assets`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `location_id` | UUID FK `locations(id) ON DELETE CASCADE` | |
| `floor_id` | UUID FK `location_floors(id) ON DELETE SET NULL` | nullable |
| `space_unit_id` | UUID FK `space_units(id) ON DELETE SET NULL` | nullable |
| `category_id` | UUID FK `facility_asset_categories(id) ON DELETE RESTRICT` | |
| `name` | VARCHAR(255) NOT NULL | e.g. "UDM-Pro Andheri Main" |
| `asset_code` | VARCHAR(40) NOT NULL | e.g. "AND-UDM-001"; **UNIQUE per location** via `UNIQUE(location_id, asset_code)` |
| `make` | VARCHAR(120) | |
| `model` | VARCHAR(120) | |
| `serial_number` | VARCHAR(160) | |
| `mac_address` | VARCHAR(40) | |
| `ip_address` | VARCHAR(40) | |
| `purchase_date` | DATE | |
| `warranty_expiry` | DATE | |
| `vendor` | VARCHAR(160) | |
| `status` | `facility_asset_status` DEFAULT `active` | |
| `lifecycle_stage` | `facility_lifecycle_stage` DEFAULT `operational` | See Asset Lifecycle below |
| `installation_date` | DATE | nullable |
| `commissioned_at` | TIMESTAMPTZ | nullable |
| `commissioned_by` | UUID FK `users(id)` | nullable |
| `custom_field_values` | JSONB DEFAULT `{}` | Key-value pairs matching the category's `custom_field_schema` |
| `procurement_po_id` | UUID | Soft reference to `purchase_orders.id` (no hard FK) |
| `location_notes` | TEXT | e.g. "Server rack, Floor 2" |
| `notes` | TEXT | |
| `sort_order` | INTEGER DEFAULT 0 | |
| `created_by` | UUID FK `users(id)` | |

**Unique constraint:** `(location_id, asset_code)` — duplicate asset code within a location yields error `23505`.

**RLS:** SELECT — any `authenticated`. ALL (write) — roles `admin`, `manager`, `it_manager`, `it_technician`, `fms`, `floor_manager`, `office_admin` (migration 00270; `floor_manager` and `office_admin` added in migration 00300).

**Soft delete:** DELETE API route sets `status = 'retired'` rather than deleting the row.

### `facility_asset_photos`

Multiple photos per asset. Added in migration 00301. Separate from `facility_asset_events.photo_urls` — these are standalone asset photos not tied to a specific event.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `asset_id` | UUID FK `facility_assets(id) ON DELETE CASCADE` | |
| `photo_url` | TEXT NOT NULL | Signed URL stored in `facility-asset-photos` bucket |
| `caption` | TEXT | nullable |
| `uploaded_by` | UUID FK `users(id)` | nullable |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | |

**Storage bucket:** `facility-asset-photos` — private.

**API:**
- `POST /api/facility/assets/[id]/photos` — upload a photo; accepts `multipart/form-data` with `file` + optional `caption`
- `DELETE /api/facility/assets/[id]/photos` — remove a photo by `photo_id`

**Component:** `asset-form-dialog.tsx` supports photo uploads via this table.

### `facility_asset_events`

Append-only event log per asset. Each event records a maintenance action, inspection, or fault observation.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `asset_id` | UUID FK `facility_assets(id) ON DELETE CASCADE` | |
| `event_type` | VARCHAR(60) NOT NULL | See valid types below |
| `note` | TEXT | nullable |
| `photo_urls` | JSONB DEFAULT `[]` | array of signed URLs (stored as JSONB, not TEXT[]) |
| `logged_by` | UUID → `auth.users(id)` | Supabase auth UID of the user who logged the event |
| `issue_id` | UUID FK `facility_issues(id) ON DELETE SET NULL` | nullable — links event to an issue (migration 00278) |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | |

**Valid `event_type` values:** `maintenance`, `inspection`, `fault_observed`, `part_replaced`, `cleaning`, `installation`, `relocation`, `other`.

**Issue linking:** When `issue_id` is set and `resolve_issue: true` is passed in the POST body, the API auto-resolves the linked issue (sets `status = 'resolved'`, `resolved_at`, `resolution_notes`).

**RLS:** SELECT — any `authenticated`. INSERT — any `authenticated`.

### `asset_documents`

Two-tier document storage per asset. Commercial documents (purchase invoices, quotations) are restricted to admin/accounts. Operational documents (installation photos, manuals) are visible to FMS/IT.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `asset_id` | UUID FK `facility_assets(id) ON DELETE CASCADE` | |
| `tier` | `asset_document_tier` (`commercial` / `operational`) | controls RLS visibility |
| `label` | TEXT NOT NULL | e.g. "Purchase Invoice", "Installation Photo" |
| `file_url` | TEXT NOT NULL | |
| `file_name` | TEXT | nullable |
| `file_size` | INTEGER | bytes, nullable |
| `mime_type` | TEXT | nullable |
| `notes` | TEXT | nullable |
| `uploaded_by` | UUID FK `users(id)` | nullable |

**RLS:**
- `operational` SELECT: `admin`, `manager`, `fms`, `it_manager`, `it_technician`
- `commercial` SELECT: `admin`, `manager`, `accounts`, `office_admin`
- INSERT: `admin`, `manager`, `fms`, `accounts`, `office_admin`, `it_manager`
- DELETE: `admin`, `manager` only

### `facility_checklist_templates`

Per-category checklist items that are copied into service events. Optionally scoped to a specific event type.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `category_id` | UUID FK `facility_asset_categories(id) ON DELETE CASCADE` | |
| `event_type` | TEXT | nullable — null means applies to all event types |
| `label` | TEXT NOT NULL | |
| `sort_order` | INTEGER DEFAULT 0 | |
| `is_active` | BOOLEAN DEFAULT true | |

### `facility_issues`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `issue_number` | VARCHAR(40) NOT NULL UNIQUE | Format: `{PREFIX}-{YYYY}-{NNNNN}`, e.g. `IT-2026-00042` |
| `scope` | `facility_scope` DEFAULT `it` | |
| `category_id` | UUID FK `facility_asset_categories(id) ON DELETE RESTRICT` | **nullable** (migration 00279) — reporters pick scope, triage assigns category |
| `location_id` | UUID FK `locations(id) ON DELETE CASCADE` | |
| `floor_id` | UUID FK `location_floors(id) ON DELETE SET NULL` | nullable |
| `space_unit_id` | UUID FK `space_units(id) ON DELETE SET NULL` | nullable |
| `asset_id` | UUID FK `facility_assets(id) ON DELETE SET NULL` | nullable |
| `title` | VARCHAR(255) NOT NULL | |
| `description` | TEXT | nullable |
| `priority` | `facility_issue_priority` DEFAULT `medium` | |
| `status` | `facility_issue_status` DEFAULT `new` | |
| `reported_by` | UUID FK `users(id)` | nullable (reporter may be a non-user member) |
| `reporter_name` | VARCHAR(160) | nullable; for external/member reporters |
| `reporter_email` | VARCHAR(255) | nullable |
| `reporter_phone` | VARCHAR(40) | nullable |
| `reported_via` | `facility_reported_via` DEFAULT `walk_in` | |
| `linked_feedback_id` | UUID | nullable soft FK to feedback table |
| `assigned_to` | UUID FK `users(id)` | nullable |
| `assigned_at` | TIMESTAMPTZ | nullable |
| `assigned_by` | UUID FK `users(id)` | nullable |
| `reported_at` | TIMESTAMPTZ DEFAULT NOW() | |
| `acknowledged_at` | TIMESTAMPTZ | nullable |
| `started_at` | TIMESTAMPTZ | nullable |
| `resolved_at` | TIMESTAMPTZ | nullable |
| `closed_at` | TIMESTAMPTZ | nullable |
| `sla_target_at` | TIMESTAMPTZ | deadline computed from priority + category SLA hours at report time |
| `sla_breached` | BOOLEAN DEFAULT false | set to true at resolve time if resolved_at > sla_target_at; also set by the `facility-sla-check` cron for still-open issues past `sla_target_at` |
| `sla_breach_last_notified_at` | TIMESTAMPTZ | nullable — last time `facility-sla-check` included this issue in an SLA-breach alert; throttles the daily re-nag on old breaches (migration 00544) |
| `resolution_root_cause` | `facility_root_cause` | nullable |
| `resolution_notes` | TEXT | nullable |
| `resolution_time_minutes` | INTEGER | `acknowledged_at` → `resolved_at` in minutes |
| `parts_cost` | NUMERIC(12,2) DEFAULT 0 | |
| `parts_notes` | TEXT | nullable |
| `satisfaction_rating` | INTEGER | CHECK: 1–5; nullable |
| `satisfaction_comment` | TEXT | nullable |
| `satisfaction_token` | UUID DEFAULT `gen_random_uuid()` | unique per issue; used in public satisfaction URL |
| `satisfaction_requested_at` | TIMESTAMPTZ | set when status → `resolved` |
| `satisfaction_received_at` | TIMESTAMPTZ | set when reporter submits rating |
| `reopen_count` | INTEGER DEFAULT 0 | incremented on each reopen |
| `claimed_by` | UUID FK `users(id)` | nullable — floor manager who claimed the issue (migration 00305) |
| `claimed_at` | TIMESTAMPTZ | nullable — when the claim was made (migration 00305) |

**DB constraint:** `satisfaction_rating BETWEEN 1 AND 5`.

**RLS (final state after migrations 00199):**
- SELECT: any `authenticated`
- INSERT: any `authenticated`
- UPDATE: roles `admin`, `manager`, `it_manager`, `it_technician`, `it_team`, `fms`, `office_admin`, `floor_manager`
- DELETE: roles `admin`, `it_manager`, `it_team`

### `facility_issue_attachments`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `issue_id` | UUID FK `facility_issues(id) ON DELETE CASCADE` | |
| `file_url` | TEXT NOT NULL | Signed URL (1 year) or bucket path |
| `file_path` | TEXT NOT NULL | Storage path in `facility-issue-photos` bucket |
| `file_type` | VARCHAR(20) DEFAULT `image` | `image` or `document` |
| `caption` | TEXT | nullable |
| `phase` | `facility_attachment_phase` DEFAULT `report` | `report`, `progress`, `resolution` |
| `uploaded_by` | UUID FK `users(id)` | nullable |
| `uploaded_at` | TIMESTAMPTZ DEFAULT NOW() | |

**RLS:** SELECT — any `authenticated`. ALL (write) — any `authenticated`.

### `facility_issue_events`

Activity timeline per issue. Append-only.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `issue_id` | UUID FK `facility_issues(id) ON DELETE CASCADE` | |
| `event_type` | VARCHAR(60) NOT NULL | See valid values below |
| `actor_id` | UUID FK `users(id)` | nullable (system events have no actor_id) |
| `actor_label` | VARCHAR(160) | name snapshot at event time |
| `message` | TEXT | human-readable summary |
| `payload` | JSONB DEFAULT `{}` | structured details |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | |

**Valid `event_type` values:** `created`, `status_changed`, `assigned`, `comment`, `photo_added`, `resolved`, `reopened`, `sla_breached`, `satisfaction`, `priority_changed`.

**RLS:** SELECT — any `authenticated`. INSERT — any `authenticated`.

### `facility_issue_time_logs`

Manual worklog per issue (migration 00552). Append-only — no update/delete, same as `facility_issue_events` — so a report can sum entries over an arbitrary date range per user.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `issue_id` | UUID FK `facility_issues(id) ON DELETE CASCADE` | |
| `logged_by` | UUID FK `users(id)` NOT NULL | who logged the entry |
| `minutes` | INTEGER NOT NULL, CHECK > 0 | |
| `note` | TEXT | nullable, free text |
| `logged_at` | TIMESTAMPTZ DEFAULT NOW() | when the work happened — defaults to now, not backdateable via the current UI |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | |

**RLS:** SELECT — any `authenticated`. INSERT — any `authenticated` (role gating happens in the API route, same pattern as `facility_issue_events`).

`GET/POST /api/facility/issues/[id]/time-logs` — GET returns `{ data: entries[], total_minutes }` newest-first; POST requires `FACILITY_ROLES.workOnIssues` (same gate as `PUT /api/facility/issues/[id]`, not narrowed to the current assignee — a past assignee or collaborator can log time for work they already did) and body `{ minutes: number, note?: string, logged_at?: string }`.

`parseDuration()` / `formatDuration()` in `src/lib/facility-ui.ts` are the input parser and display formatter — `parseDuration` accepts free text ("1h 30m", "45m", "3d", "1.5h", "0:30" as H:MM, or a bare number as minutes) and returns whole minutes or `null` if unparseable; the `/facility/issues/[id]` page's "Log time" dialog shows an inline error rather than submitting when parsing fails.

Surfaced in two places: the issue detail page's "Time spent" section (running total + entry list, gated behind the same `canAct` check as the page's other mutating UI), and as an "Hours Logged" column on `/facility/team-kpi` (`GET /api/facility/team-kpi`), summed by `logged_at` within the report's date range — independent of which date range the underlying tickets were created in, so hours logged this week count even against a ticket opened last month.

### `facility_issue_collaborators`

Junction table for secondary assignees.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `issue_id` | UUID FK `facility_issues(id) ON DELETE CASCADE` | |
| `user_id` | UUID FK `users(id) ON DELETE CASCADE` | |
| `added_by` | UUID FK `users(id)` NOT NULL | |
| `added_at` | TIMESTAMPTZ DEFAULT NOW() | |

**Unique constraint:** `(issue_id, user_id)`.

**RLS (migrations 00146 + 00176):** SELECT, INSERT, DELETE open to `authenticated`. UPDATE policy added in 00176 (needed for upsert ON CONFLICT).

### Storage Bucket

Bucket name: `facility-issue-photos` — **private** (not public).
- Max file size: 10 MB
- Allowed MIME types: `image/jpeg`, `image/jpg`, `image/png`, `image/webp`, `application/pdf`
- Signed URLs (1-year TTL) are created at upload time and stored in `facility_issue_attachments.file_url`

---

## Status Machine / Ticket Lifecycle

### Status Values and Display Labels

| DB value | Display label | Badge color |
|---|---|---|
| `new` | New | Blue |
| `acknowledged` | Acknowledged | Indigo |
| `claimed` | Claimed | Orange | 
| `in_progress` | In Progress | Purple |
| `resolved` | Resolved | Emerald |
| `closed` | Closed | Slate |
| `reopened` | Reopened | Rose |

**Claim model (migration 00305):** A floor manager can "claim" an open issue before formal assignment, preventing duplicate work. Claiming sets `claimed_by` and `claimed_at` on the issue row and transitions status to `claimed`. The claim is an intermediate state between `new` and `acknowledged`/`in_progress`. Claiming does not constitute formal assignment — an admin/manager can still re-assign.

### Allowed Transitions

Defined authoritatively in `src/lib/facility.ts` — `ALLOWED_TRANSITIONS`:

```
new          → acknowledged, in_progress, resolved, closed
acknowledged → in_progress, resolved, closed
in_progress  → resolved, acknowledged, closed
resolved     → closed, reopened
closed       → reopened
reopened     → acknowledged, in_progress, resolved, closed
```

**Key rule:** A status cannot transition to itself (`from === to` is always rejected).

The UI surfaces a restricted subset via `nextStatusOptions()` in `src/lib/facility-ui.ts` (does not expose `closed` from every state — it is intentionally narrower to guide the expected flow):

```
new          → acknowledged, in_progress, resolved
acknowledged → in_progress, resolved
in_progress  → resolved
resolved     → closed, reopened
closed       → reopened
reopened     → acknowledged, in_progress, resolved
```

The server enforces `ALLOWED_TRANSITIONS` (broader) — the UI uses `nextStatusOptions` (narrower). When building new flows, use the server's `canTransition()` as truth.

### Timestamp Side-Effects on Status Change

Computed in `timestampsForStatus()` in `src/lib/facility.ts`:

| Status → | acknowledged_at | started_at | resolved_at | closed_at |
|---|---|---|---|---|
| `acknowledged` | set if not already set | — | — | — |
| `in_progress` | set if not already set | set if not already set | — | — |
| `resolved` | set if not already set | set if not already set | always set | — |
| `closed` | — | — | set if not already set | always set |
| `reopened` | — | — | set to NULL | set to NULL |

Timestamps are **never cleared backward** except on `reopened` (which nulls `resolved_at` and `closed_at`).

### SLA Computation

1. At issue creation: `sla_target_at = reported_at + category.default_sla_{priority}_hrs hours`. If no `category_id` is set, `computeSlaTarget()` uses fallback defaults: critical=2h, high=8h, medium=24h, low=72h
2. If priority is changed via PUT: `sla_target_at` is recomputed from `reported_at` (the original report time, not the time of change). `sla_breached` is reset to `false`.
3. At resolution: `sla_breached = resolved_at > sla_target_at`. This is set once and not changed on later updates.
4. If resolution happens with no `sla_target_at`, `sla_breached` is left as-is (no update).
5. `resolution_time_minutes = resolved_at - acknowledged_at` in minutes. If `acknowledged_at` is null at resolve time, it is set first (so resolution_time_minutes will be near 0, reflecting an instant acknowledgment).

**Issue number format:** `{SCOPE_PREFIX}-{YYYY}-{NNNNN}` (zero-padded 5 digits). On concurrent insert collision (`23505`), the API returns HTTP 409; callers should retry.

Scope prefixes:
- `it` → `IT`
- `hvac` → `HV`
- `plumbing` → `PL`
- `electrical` → `EL`
- `housekeeping` → `HK`
- `security` → `SC`
- `other` → `OT`

---

## Auto-Satisfaction Survey

When a ticket is resolved (`status → resolved`):
- `satisfaction_requested_at` is set on the issue row
- `satisfaction_token` is a UUID that was generated at row creation (`DEFAULT gen_random_uuid()`)
- The public endpoint `GET/POST /api/facility/satisfaction/[token]` is unauthenticated — uses `createAdminClient()` and token-based lookup

**Auto-reopen rule:** If reporter submits a rating of ≤ 2 and the issue is still in `resolved` status, the system automatically transitions the issue to `reopened`. Specifically:
- `status` → `reopened`
- `resolved_at` and `closed_at` → NULL
- `reopen_count` incremented
- A `reopened` event is logged with `actor_label: "System"` and `reason: "low_rating"`

---

## Business Rules

1. **Every issue requires `location_id`.** `category_id` is now **optional** (migration 00279) — reporters pick a scope (IT, HVAC, etc.) and the category is assigned during triage. When `category_id` is null, SLA computation uses built-in fallback defaults (2h/8h/24h/72h via `computeSlaTarget()`).

2. **Title must be a non-empty string.** The API checks `title.trim() === ""` and rejects with 400. The wizard additionally requires `title.trim().length >= 3` before allowing Next.

3. **Priority must be one of the four valid values.** Server validates against `["low", "medium", "high", "critical"]`. Same for `reported_via` against its enum.

4. **SLA target is computed at creation from the category's default SLA hours.** It is not user-editable. It is recomputed if priority changes.

5. **`sla_breached` is set to `false` when priority is changed** (issue gets a fresh SLA window). Be careful: this means downgrading priority on a near-breach ticket resets the SLA clock.

6. **`asset_code` must be unique per location.** Attempting to create or update an asset with a duplicate code within the same location yields a 409 with message "An asset with this code already exists at this location".

7. **Auto-assignment (category-driven):** When an issue is created and its `category_id` has a non-null `default_assignee_id`, the issue is automatically assigned to that user (if they are active). If the user is inactive, `notifyAdminsStaleAssignee()` fires and the issue is left unassigned. The backup assignee (`backup_assignee_id`) is CC-notified but not set as the owner. This applies to all scopes — the previous IT-only hardcoded behaviour has been replaced by per-category configuration. Configure assignees via `PATCH /api/facility/categories/[id]`.

8. **Satisfaction token is static** — it is generated once at row creation. If a token is leaked, it can only be rotated via a direct `UPDATE` on the row. There is no API to rotate it.

9. **Inactive assignees are rejected.** `POST /api/facility/issues/[id]/assign` checks `is_active === false` and returns 400.

---

## Validation Rules

| Field | Where enforced | Rule |
|---|---|---|
| `title` | Server (`issues/route.ts`) | Must exist and `trim()` not empty |
| `title` length | Client (wizard) | Must be >= 3 chars before Next is enabled |
| `location_id` | Server | Must be present; 400 if missing |
| `category_id` | Server | Optional (nullable since 00279); if provided, must exist in DB; 404 if not found |
| `priority` | Server | Must be in `["low", "medium", "high", "critical"]`; 400 otherwise |
| `reported_via` | Server | Must be in valid enum list; 400 otherwise |
| `resolution_root_cause` | Server (`status/route.ts`) | Must be in `VALID_ROOT` list; silently ignored if not valid (not rejected) |
| `satisfaction_rating` | DB CHECK constraint | `BETWEEN 1 AND 5`; also validated server-side at the public satisfaction endpoint |
| `asset_code` | DB UNIQUE constraint | Unique per `location_id`; 23505 → 409 from API |
| `slug` (category) | DB UNIQUE constraint | Globally unique; 23505 → 409 from API |
| Status transition | Server (`canTransition()`) | Uses `ALLOWED_TRANSITIONS` map; from === to always rejected |
| Assignee active | Server (`assign/route.ts`) | Checks `is_active` on the user row; 400 if inactive |
| Attachment `phase` | Server | Must be in `["report", "progress", "resolution"]`; 400 otherwise |
| `satisfaction_rating` | Server (`satisfaction/route.ts`) | `Number.isInteger(rating) && rating >= 1 && rating <= 5` |

---

## Role Permissions

Defined in `src/lib/facility.ts`:

```typescript
FACILITY_ROLES = {
  manage: ["admin", "it_manager", "it_team"],
  workOnIssues: ["admin", "manager", "it_manager", "it_technician", "it_team", "fms", "office_admin", "floor_manager"],
  // Anyone authenticated can report (no role check on POST /api/facility/issues)
}
```

| Action | Roles |
|---|---|
| Report an issue (create) | Any authenticated user |
| Add a comment | Any authenticated user |
| Add an attachment | Any authenticated user |
| View issues / assets | Any authenticated user |
| Change status, assign, add collaborators | `workOnIssues` roles (see above) |
| Edit issue fields via PUT | `workOnIssues` roles |
| Create/edit assets | `workOnIssues` roles (note: the RLS on `facility_assets` is narrower: `admin`, `manager`, `it_manager`, `it_technician` only) |
| Create categories | `manage` roles: `admin`, `it_manager`, `it_team` |
| Delete an issue | `manage` roles: `admin`, `it_manager`, `it_team` |
| Delete an asset (retire) | `manage` roles |
| Satisfaction endpoint | No auth (public token-based) |

**Gotcha — RLS vs TypeScript mismatch fixed in 00199:** The DB `fac_issues_update` policy originally omitted `it_team`, causing any `it_team` user to pass the TypeScript check but have their DB UPDATE silently blocked. Migration 00199 fixed this. If you add a new role to `FACILITY_ROLES`, you MUST also update the RLS policy in a migration.

---

## Notification System

Notifications fire on: `created`, `status_changed`, `assigned`, `comment`.

### Recipients (category-driven)

For each event, `notifyIssueAssignee(issue, event)` in `src/lib/facility-notifications.ts` builds the recipient list:

1. **Primary assignee** — `issue.assigned_to` (looked up from `users` table)
2. **Backup assignee** — the `backup_assignee_id` of the issue's category (if set and active)
3. **Collaborators** — all rows in `facility_issue_collaborators` for the issue

If the final recipient list is empty (unassigned, no backup, no collaborators), all admins are notified as a fallback.

### Channels

Three channels fire in parallel via `Promise.allSettled` (failures are silently absorbed):
1. **Push notification** — `sendPushToUsers` from `src/lib/push`
2. **Email** — via Resend (`resend.emails.send`), HTML template inline in `facility-notifications.ts`
3. **In-app notification** — persisted via `createNotificationsForUsers` from `src/lib/in-app-notifications`

The notification function uses `createAdminClient()` (synchronous, no `await`) internally because it runs in a server-side route handler without a user cookie.

### Stale Assignee Alert

`notifyAdminsStaleAssignee({ categoryId, issueNumber, issueTitle })` fires when:
- A category has `default_assignee_id` set (non-null)
- But that user either no longer exists or has `is_active = false`

It notifies all active admins so they can update the category routing.

### SLA Breach Digest (Cron)

`GET /api/cron/facility-sla-check` runs every 6h (UTC: `0 */6 * * *`). It:
1. Queries all open issues with `sla_breached = false AND sla_target_at < now()` (newly breached) **and** open issues with `sla_breached = true` whose `sla_breach_last_notified_at` is null or more than 24h old (still-open re-nags)
2. Bulk-sets `sla_breached = true` on the newly-breached set, and stamps `sla_breach_last_notified_at = now()` on every issue in either set
3. Groups matched issues by assignee
4. Sends **one digest email + push per recipient** (not per issue) to avoid spam
5. Unassigned breaches are routed to all active admins

An issue that breaches and is never resolved keeps appearing in this alert once a day (not once ever) until it's resolved or reopened — `sla_breach_last_notified_at` is the throttle, `sla_breached` alone is not. Protected by `Authorization: Bearer ${CRON_SECRET}`.

---

## API Route Reference

### `GET /api/facility/issues`

Query params:
- `scope` — filter by scope
- `status` — can be repeated for OR filter (e.g. `?status=new&status=acknowledged`)
- `priority` — single value
- `location_id`
- `assigned_to` — `"me"` (resolves to current user's DB id), `"unassigned"`, or a UUID
- `reported_by` — UUID
- `category_id`
- `sla_breached` — `"true"`
- `date_from`, `date_to` — filter by `created_at`
- `only_open` — `"true"` expands to `status IN (new, acknowledged, in_progress, reopened)`
- `search` — ilike across `title`, `issue_number`, `description`
- `limit` — default 100, max 500

Returns: `{ data: FacilityIssue[] }` with joined `location`, `floor`, `space_unit`, `asset`, `category`, `reporter`, `assignee`.

### `POST /api/facility/issues`

Required body fields: `title`, `location_id`.
Optional: `scope` (default `it`), `category_id` (nullable — triage assigns later), `floor_id`, `space_unit_id`, `asset_id`, `description`, `priority` (default `medium`), `reported_via` (default `walk_in`), `reporter_name`, `reporter_email`, `reporter_phone`, `linked_feedback_id`, `attachments[]`.

Side effects: generates issue number, computes SLA target, auto-assigns to primary IT contact (IT scope only), logs `created` event, sends notifications.

Returns 409 on duplicate `issue_number` race condition (caller should retry).

### `PATCH /api/facility/issues/[id]/status`

Body: `{ status: FacilityIssueStatus, resolution_notes?, resolution_root_cause?, parts_cost?, parts_notes? }`.

Validates transition via `canTransition()`. Sets lifecycle timestamps. At `resolved`: sets `resolution_time_minutes`, `sla_breached`, `satisfaction_requested_at`. At `reopened`: increments `reopen_count`, resets `sla_breached = false`, and recomputes `sla_target_at` from the category's current SLA defaults (so the issue gets a fresh SLA window after a reopen).

### `PATCH /api/facility/categories/[id]`

Body: `{ default_assignee_id: string | null, backup_assignee_id: string | null }`.

Updates only the assignee routing fields on a category. Validated with Zod (UUID format or null). Logs an audit trail. Used by `/facility/settings` to save routing configuration. Requires `manage` role (`admin`, `it_manager`).

`/facility/settings` also uses `PUT /api/facility/categories/[id]` from the same row to rename a category and to toggle `is_active` (Deactivate/Reactivate button) — deactivating is a soft-delete: it hides the category from pickers for new assets/issues (`GET` filters `is_active = true` by default) without touching existing rows that already reference it, since `DELETE` on this endpoint is itself just `is_active = false` under the hood.

### `GET /api/facility/assets/[id]/cost-summary`

Returns monthly cost-of-ownership for an asset from approved vendor bills. Follows the chain: `facility_issues → purchase_requests (issue_id) → purchase_orders (pr_id) → vendor_bills (po_id)`. Only bills with `approval_status = 'approved'` are included. Costs aggregated by `invoice_date` month.

Response: `{ data: [{ month: "2025-03", cost: 12500 }, ...] }` sorted ascending by month.

### `PUT /api/facility/issues/[id]`

Editable fields: `title`, `description`, `priority`, `category_id`, `location_id`, `floor_id`, `space_unit_id`, `asset_id`, `reporter_name`, `reporter_email`, `reporter_phone`, `parts_cost`, `parts_notes`, `resolution_notes`, `resolution_root_cause`.

Note: `location_id` is editable on issues but not on assets.

### `GET /api/facility/dashboard`

Query params: `date_from`, `date_to` (ISO), `scope`, `location_id`.

Returns:
```typescript
{
  summary: FacilityDashboardSummary,    // KPI counts + SLA %
  hot_spots: FacilityHotSpot[],         // top 10 locations by issue count
  by_category: FacilityCategoryBreakdownRow[],
  trend: FacilityTrendPoint[],          // weekly buckets
  recurring: FacilityRecurringIssue[],  // asset/category seen 3+ times
  idle_or_breached: FacilityIssue[],    // open + sla_breached, oldest first, top 20
  period: { from, to }
}
```

Open issue counts are fetched with a separate `count: exact` query (not limited to 500) so headline KPIs are always accurate even if the list is capped.

Recurring issues: detected when the same asset (or same location+category combination) appears 3 or more times across current + previous period.

### `GET /api/facility/team-kpi`

Query params: `date_from`, `date_to`, `scope`, `format=csv`.

Includes any active user who was an assignee in range, or who logged time in range — not restricted to a fixed IT role list (assignable roles were generalized beyond IT; a role-filtered pre-fetch of all active users doesn't scale once "assignable" isn't a small fixed set).

KPI definitions:
- **avg_ack_minutes** = mean of (`acknowledged_at` - `reported_at`) per assigned issue
- **avg_resolution_minutes** = mean of (`resolved_at` - `acknowledged_at`) for resolved issues
- **sla_compliance_pct** = resolved issues with `sla_target_at` that were NOT `sla_breached` / total eligible resolved × 100 (issues without `sla_target_at` excluded from denominator)
- **reopen_rate_pct** = issues where `reopen_count > 0` / total assigned × 100
- **minutes_logged** = sum of `facility_issue_time_logs.minutes` where `logged_by` = this user and `logged_at` falls in `[date_from, date_to]` — filtered by when the work was logged, independent of when the underlying ticket was created
- **avg_satisfaction** = mean `satisfaction_rating` of resolved issues (null if none)

SLA compliance thresholds in UI: ≥95% → green, 80–94% → amber, <80% → red.

### `GET/POST /api/facility/satisfaction/[token]`

Public — no authentication. Uses `createAdminClient()`.

GET: returns `{ issue_number, title, status, resolved_at, location_name, already_rated, current_rating }`.

POST body: `{ rating: 1-5, comment?: string (max 2000 chars) }`.

Auto-reopens the issue if `rating <= 2` and `status === "resolved"`.

### `GET /api/facility/assignees`

Returns active users with roles `fms`, `admin`, `floor_manager` and `is_active = true`. These are the users eligible to be assigned to facility issues or set as `default_assignee_id` / `backup_assignee_id` on a category. Used by the issue assign dialog and the category routing settings. No longer hardcodes IT email addresses.

---

## Integration Points with Other Modules

### `linked_feedback_id`

The `facility_issues` table has a `linked_feedback_id` UUID column — a soft FK to the feedback table. This allows issues to be auto-created from the `/feedback` or `/facility-feedback` public forms. The column is nullable and has no hard FK constraint (schema comment: "Phase 2").

### Locations (`locations` table)

Issues and assets are always scoped to a location. Dashboard fetches active locations via `GET /api/locations?is_active=true`. The `locations.code` field is used in the issue list and asset code suggestions.

### Space Units and Floors

Issues and assets can optionally be pinned to `space_units` (seat/desk units) and `location_floors`. The wizard shows space unit chips filtered by selected floor.

### Users

- `assigned_to`, `assigned_by`, `reported_by` all reference `public.users(id)` (the internal users table, not Supabase auth UUIDs)
- `facility_issue_collaborators.user_id` and `added_by` also reference `users(id)`
- Role check in routes uses `supabase.from("users").select("id, role").eq("auth_id", user.id)` to map the Supabase auth UID to the internal user row

### In-App Notifications

`createNotificationsForUsers` from `src/lib/in-app-notifications` is called on every facility event (created, status_changed, assigned, comment). The `entityType` sent is `"facility_issue"` and `url` is `/facility/issues/{id}`.

---

## Known Pitfalls and Gotchas

### RLS/TypeScript Role Drift (Fixed — Must Not Recur)

Migration 00199 exists because `it_team` was added to `FACILITY_ROLES` in TypeScript without updating the DB RLS policy. The symptom was a silent update failure (PostgREST returned 0 rows for `.update().select().single()`). **Rule:** any time you add a role to `FACILITY_ROLES.workOnIssues` or `FACILITY_ROLES.manage`, immediately write a migration that adds that role to `fac_issues_update` and `fac_issues_delete`.

### `facility_issue_collaborators` Upsert Needs UPDATE Policy

Migration 00176 added the UPDATE RLS policy on `facility_issue_collaborators` because `upsert` with `ON CONFLICT DO UPDATE` silently failed without it. The initial migration (00146) only created SELECT, INSERT, DELETE policies. If you ever see upsert silently failing on a junction table, check for a missing UPDATE policy.

### `asset_code` Is Auto-Uppercased

The API calls `.trim().toUpperCase()` on `asset_code` before insert/update. The dialog does the same in `onChange`. Do not rely on lowercase asset codes — they will be stored uppercase.

### SLA Is Reset on Priority Change and on Reopen

Two events reset the SLA clock:
1. **Priority change (PUT)** — resets `sla_target_at` computed from original `reported_at` (not from now) and sets `sla_breached = false`. Downgrading a near-breach high-priority issue to medium gives it a fresh 24h window.
2. **Reopen (PATCH /status)** — also resets `sla_breached = false` and recomputes `sla_target_at` from the category's current SLA defaults at the time of reopen. This gives the technician a clean SLA window for the second attempt.

In both cases, `sla_target_at` uses the category's SLA hours — if the category's SLA was updated between issue creation and reopen, the new SLA hours apply.

### Satisfaction Token — No Rotation API

`satisfaction_token` is a UUID stored on the row, generated at issue creation. There is no API endpoint to rotate it. If it needs to be changed (e.g. token leaked), it requires a direct DB UPDATE.

### Signed URLs Expire

`FacilityPhotoUpload` creates 1-year signed URLs at upload time. These are stored verbatim in `facility_issue_attachments.file_url`. After 1 year they will expire. No refresh mechanism exists yet.

### Storage Cleanup on Attachment Delete

`DELETE /api/facility/issues/[id]/attachments` only removes the DB row. The storage object in `facility-issue-photos` is NOT deleted. Cleanup would need a cron/lifecycle policy (noted in the route comment).

### Issue Number Race Condition

`generateIssueNumber()` in `src/lib/facility.ts` uses an optimistic strategy (look up highest existing number + 1) rather than a sequence. On concurrent inserts in the same scope/year, the second insert will hit a `UNIQUE` constraint violation (`23505`) and the API returns HTTP 409. The caller is expected to retry. This is documented but there is currently no retry logic on the client.

### Asset Event `logged_by` References `auth.users`, Not `public.users`

The `facility_asset_events.logged_by` column stores the Supabase auth UID (`auth.users.id`), not the internal `public.users.id`. When displaying logger names, the GET endpoint does a separate lookup against `public.users` via `auth_id` — it cannot use a Supabase FK join because `auth.users` does not expose `full_name`. If you add new tables that reference auth UIDs and need user names, use this same pattern.

### `nextStatusOptions` (UI) vs `ALLOWED_TRANSITIONS` (Server)

The UI's `nextStatusOptions()` is intentionally narrower than the server's `ALLOWED_TRANSITIONS`. For example, `new → closed` is allowed server-side but the UI only shows `acknowledged`, `in_progress`, `resolved` from `new`. Direct API calls can use any valid server transition. Do not rely on UI button presence to determine what is "allowed" — always use `canTransition()` for logic.

### `/api/facility/issues/[id]/assign` with `null` Unassigns

Pass `{ "assignee_id": null }` to unassign. Omitting `assignee_id` also unassigns (it defaults to `body.assignee_id ?? null`).

### Reporter vs Assignee

Two different user concepts on an issue:
- `reported_by` — the internal user who created the ticket (always set at creation if logged in)
- `reporter_name/email/phone` — contact info for the member/external person who complained (may differ from the staff member who entered the ticket)

Both can be populated simultaneously. The satisfaction survey is sent to `reporter_email` (external), not necessarily to the `reported_by` user.

---

## Environment / Config Dependencies

No module-specific env vars or feature flags beyond the standard app ones (`NEXT_PUBLIC_APP_URL` is used to build issue links in notification emails in `src/lib/facility-notifications.ts`).

There are no hardcoded IT email addresses in this module. Assignee routing is fully database-driven via `facility_asset_categories.default_assignee_id` and `backup_assignee_id`.

No `app_settings` table keys are used by this module.

---

## Key User Flows

### Flow 1: Report a New Issue (Simplified Wizard v2)

The wizard was rewritten to be scope-first (not category-first). Reporters pick a scope like "Electrical" or "IT" — the granular category (e.g. "WiFi Access Point") is assigned during triage.

1. Staff navigates to `/facility/issues` or `/facility/my-issues`
2. Clicks "Report Issue" — opens `FacilityReportWizard` (3-step dialog)
3. **Step 1 — Where:** Two paths:
   - **Asset search** (top of step): type to search assets by name/code/serial/MAC via `GET /api/facility/assets?search=&status=active`. Selecting an asset auto-fills location, floor, space unit, and scope from the asset's category.
   - **Manual location** (below divider): pick location → optionally floor → space unit
   - Validation: `locationId` must be set to proceed
4. **Step 2 — What:** 7 scope buttons (IT, HVAC, Electrical, Plumbing, Housekeeping, Security, Other) with icons → priority picker → title (required, min 3 chars) + description + photo upload
   - If an asset was selected in Step 1, scope is pre-filled from the asset's category
   - Validation: `scope` + `title.trim().length >= 3`
5. **Step 3 — Who:** Reported-via chips → reporter contact fields → summary panel
6. Clicks Submit → `POST /api/facility/issues` (sends `scope` directly, `category_id` is null)
7. Server: generates scoped issue number (e.g. `EL-2026-00001`), computes SLA from fallback defaults, auto-assigns IT-scoped issues to primary IT contact, logs `created` event, sends notifications
8. On success: redirects to `/facility/issues/{id}`

**Prefilled mode:** Callers can pass `defaults.location_id` + `defaults.scope` to skip Step 1 and pre-fill Step 2.

### Flow 2: Technician Works an Issue

1. Technician opens `/facility/my-issues` (shows only their assigned tickets)
2. Clicks into an issue → `/facility/issues/{id}`
3. If `new`: clicks "Acknowledge" → `PATCH /status { status: "acknowledged" }` — sets `acknowledged_at`
4. Clicks "Start Work" → `PATCH /status { status: "in_progress" }` — sets `started_at`
5. Adds photos via `FacilityPhotoUpload` (phase: `progress`) and comments throughout
6. Clicks "Resolve" → opens `ResolveDialog` — enters root cause, resolution notes, parts cost
7. Submits → `PATCH /status { status: "resolved", resolution_root_cause, resolution_notes, parts_cost, parts_notes }`
8. Server sets `resolved_at`, computes `resolution_time_minutes`, evaluates `sla_breached`, sets `satisfaction_requested_at`
9. Notifications sent to IT team + collaborators

### Flow 3: Satisfaction Survey

1. After resolution, a satisfaction link can be sent to the reporter (the mechanism to trigger sending is not in the module — `satisfaction_requested_at` is set but the actual email send is external to this module's code as reviewed; the public endpoint exists for when such a link is followed)
2. Reporter visits `/facility/satisfaction/{token}` (public page, separate from the dashboard)
3. Submits rating 1–5 and optional comment → `POST /api/facility/satisfaction/[token]`
4. If rating ≤ 2 and issue is still `resolved`: auto-reopened, `reopen_count++`

### Flow 4: Manager Reviews SLA

1. Opens `/facility` dashboard
2. Selects time period (7d / 30d / 90d)
3. Views KPI cards: open count, SLA compliance %, avg resolution, resolved count
4. Hot spots section shows which locations generate most issues
5. SLA-breached open issues section shows issues that need immediate attention (links to issue detail)
6. Opens `/facility/team-kpi` for per-technician breakdown, optionally downloads CSV

### Flow 5: Add an Asset

1. Navigate to `/facility/assets`
2. Click "Add Asset" → `FacilityAssetFormDialog`
3. Select location, category, enter name and asset code (auto-suggested as `{LOCPREFIX}-{CATPREFIX}-001`)
4. Asset code is forced uppercase
5. Fill optional fields: make, model, serial number, MAC address, lifecycle stage, installation date, custom fields (per-category schema)
6. Submit → `POST /api/facility/assets`
7. Asset appears in list grouped by location
8. When reporting issues, the asset can be searched in Step 1 of the wizard to link the issue to the device

### Flow 6: Log an Asset Event (with Issue Linking)

1. Navigate to `/facility/assets/{id}` (asset detail page)
2. Scroll to "Event Log" section — shows chronological history of maintenance, inspections, faults
3. Click "Log Event" → opens `AssetEventDialog`
4. Select event type (maintenance, inspection, fault_observed, part_replaced, cleaning, installation, relocation, other)
5. Enter note (optional) and attach photos
6. **Issue linking (optional):** If the asset has open issues, they appear as clickable items. Selecting one:
   - Links the event to the issue via `issue_id`
   - Shows "Mark issue as resolved" checkbox (defaults to on)
7. Submit → `POST /api/facility/assets/{id}/events`
8. If `issue_id` + `resolve_issue: true`: the linked issue is auto-resolved (status → `resolved`, `resolved_at` set, audit logged)
9. Event appears in the log with the linked issue shown as a clickable link to `/facility/issues/{id}`

### Flow 7: Upload Asset Documents

1. On the asset detail page, click "Documents" tab
2. Upload documents with a tier selection:
   - **Operational**: installation photos, manuals, wiring diagrams — visible to FMS/IT
   - **Commercial**: purchase invoices, quotations, warranty certificates — visible to admin/accounts only
3. Submit → `POST /api/facility/assets/{id}/documents`

---

## Issue Lifecycle

The complete lifecycle of a facility issue from report to closure:

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                   ISSUE LIFECYCLE                        │
                    └──────────────────────────────────────────────────────────┘

  ┌─────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────┐     ┌────────┐
  │   NEW   │────▶│ ACKNOWLEDGED │────▶│ IN_PROGRESS │────▶│ RESOLVED │────▶│ CLOSED │
  └─────────┘     └──────────────┘     └─────────────┘     └──────────┘     └────────┘
       │                                      │                  │               │
       │          (can skip acknowledge)      │                  │               │
       └──────────────────────────────────────┘                  │               │
       │                                                         │               │
       │          (can skip straight to resolve)                 ▼               │
       └────────────────────────────────────────────────▶ ┌──────────┐          │
                                                          │ RESOLVED │          │
                                                          └──────────┘          │
                                                               │               │
                                                    ┌──────────┼───────────────┘
                                                    │          │
                                                    ▼          ▼
                                              ┌──────────┐
                                              │ REOPENED │
                                              └──────────┘
                                                    │
                                          ┌─────────┼──────────┐
                                          ▼         ▼          ▼
                                   acknowledged  in_progress  resolved
```

### Phase 1: Report (NEW)
- Reporter creates issue via the wizard (scope-first, category optional)
- System generates scoped issue number (e.g. `IT-2026-00042`, `EL-2026-00001`)
- SLA target computed from category SLA hours (or fallback defaults: 2h/8h/24h/72h)
- If the category has `default_assignee_id` set → issue auto-assigned to that user. If the user is inactive → admins notified via `notifyAdminsStaleAssignee()`, issue left unassigned
- Notifications sent to assignee + category backup assignee (if set)

### Phase 2: Triage (NEW → ACKNOWLEDGED)
- First responder acknowledges receipt → sets `acknowledged_at`
- Triage assigns `category_id` (if not set at creation) and refines priority
- Can assign/reassign to a specific technician
- Can add collaborators for complex issues

### Phase 3: Work (ACKNOWLEDGED → IN_PROGRESS)
- Technician starts work → sets `started_at`
- Progress documented via comments and photo uploads (phase: `progress`)
- Can be de-escalated back to `acknowledged` if blocked

### Phase 4: Resolution (IN_PROGRESS → RESOLVED)
- Technician resolves with root cause, resolution notes, parts cost
- Sets `resolved_at`, computes `resolution_time_minutes` (from `acknowledged_at`)
- Evaluates `sla_breached = resolved_at > sla_target_at`
- Sets `satisfaction_requested_at` for survey
- **Alternative resolution path:** Issue can be auto-resolved from an asset event log (see Flow 6)

### Phase 5: Verification (RESOLVED → CLOSED or REOPENED)
- Manager or reporter reviews resolution
- `closed` → sets `closed_at`, issue is complete
- `reopened` → nulls `resolved_at` and `closed_at`, increments `reopen_count`
- **Auto-reopen:** satisfaction rating ≤ 2 auto-reopens the issue

### Phase 6: Reopen Cycle (REOPENED)
- Reopened issues re-enter the triage/work cycle
- Can transition to `acknowledged`, `in_progress`, or `resolved`
- `reopen_count` tracks how many times the issue has been reopened

---

## Asset Lifecycle

Assets progress through lifecycle stages from procurement to decommission. The `lifecycle_stage` column tracks where each asset is in its journey.

```
  ┌──────────┐     ┌───────────┐     ┌──────────────────────┐     ┌─────────────┐
  │ PROCURED │────▶│ INSTALLED │────▶│ TESTING_COMMISSIONING│────▶│ OPERATIONAL │
  └──────────┘     └───────────┘     └──────────────────────┘     └─────────────┘
                                                                        │
                                                                   ┌────┴────┐
                                                                   ▼         ▼
                                                            ┌───────────┐ ┌────────────────┐
                                                            │ UNDER_AMC │ │ DECOMMISSIONED │
                                                            └───────────┘ └────────────────┘
                                                                   │
                                                                   ▼
                                                            ┌────────────────┐
                                                            │ DECOMMISSIONED │
                                                            └────────────────┘
```

### Lifecycle Stages

| Stage | Description | Typical Actions |
|---|---|---|
| `procured` | PO placed, asset received but not yet installed | Attach purchase invoice (commercial tier), record vendor/serial/model |
| `installed` | Physically placed at location | Set `installation_date`, assign floor/space unit, update `location_notes` |
| `testing_commissioning` | T&C in progress | Set `commissioned_by`, run validation checklist, log inspection events |
| `operational` | Running, in daily service | Log maintenance events, link to issues, track SLA performance |
| `under_amc` | Covered by an AMC contract | Linked via `amc_asset_bridge` table, service visits logged against AMC events |
| `decommissioned` | Retired / removed from service | Asset `status` also set to `retired`, no longer appears in active searches |

### Asset Status vs Lifecycle Stage

Two separate concepts:

- **`status`** (`active` / `maintenance` / `retired`): Operational availability. Controls whether the asset appears in searches and can be linked to issues.
- **`lifecycle_stage`**: Where the asset is in its overall journey. An `operational` asset can temporarily be in `maintenance` status (e.g., during a repair) without changing lifecycle stage.

### Asset Event Log

Every significant action on an asset is recorded in `facility_asset_events`. This provides a chronological audit trail visible on the asset detail page.

**Event types and their purpose:**
| Event Type | When Used |
|---|---|
| `installation` | Asset physically installed at location |
| `inspection` | Routine inspection or audit |
| `maintenance` | Preventive or scheduled maintenance |
| `fault_observed` | Problem discovered during inspection or use |
| `part_replaced` | Component replacement (record part details in note) |
| `cleaning` | Cleaning or servicing |
| `relocation` | Asset moved to a different location/floor/unit |
| `other` | Any event not covered above |

### Issue ↔ Asset Linkage

Assets and issues are connected in two ways:

1. **Issue creation**: When reporting an issue, the reporter can search for and select an asset. The `asset_id` is stored on the issue. The wizard auto-fills location and scope from the asset.

2. **Event-driven resolution**: When logging an asset event, the technician can link it to an open issue on that asset. If "Mark issue as resolved" is checked, the issue is auto-resolved with the event note as resolution notes. This creates a traceable chain: `asset → event → issue resolved`.

### Custom Fields (Per-Category)

Each `facility_asset_categories` row has a `custom_field_schema` JSONB column defining category-specific fields. For example, the AC category defines fields like `ac_type`, `capacity_tons`, `refrigerant_type`. These are stored as key-value pairs in the asset's `custom_field_values` JSONB column.

Schema format:
```json
[
  {"key": "ac_type", "label": "AC Type", "type": "select", "required": true, "options": ["Split", "Cassette", "VRF"]},
  {"key": "capacity_tons", "label": "Capacity (tons)", "type": "number", "required": true}
]
```

### Cost of Ownership

An asset's maintenance cost is tracked through the procurement chain:

```
facility_issues (asset_id) → purchase_requests (issue_id) → purchase_orders (pr_id) → vendor_bills (po_id)
```

`GET /api/facility/assets/[id]/cost-summary` aggregates `vendor_bills.total_amount` by `invoice_date` month for all approved bills on that chain. This gives a per-asset monthly cost bar chart useful for lifecycle decisions (repair vs replace).

The `purchase_requests.issue_id` FK was added in migration 00293. Existing MRs that predate this migration have `issue_id = NULL` and do not appear in cost summaries. New MRs generated from an issue (via the "Generate MR" button on the issue detail page) will carry `issue_id` automatically.

### Document Management (Two-Tier)

Assets support document uploads with access tiers:
- **Commercial** (purchase invoices, quotations, warranty certificates): visible to `admin`, `manager`, `accounts`, `office_admin`
- **Operational** (installation photos, manuals, diagrams): visible to `admin`, `manager`, `fms`, `it_manager`, `it_technician`

---

## QR Code & Public Asset Access

Each asset has a unique `asset_code` (e.g. `AND-UDM-001`). A QR code encoding `https://twv-crm.vercel.app/asset/{code}` can be printed and affixed to the physical device.

### Print QR Page (`/facility/assets/[id]/print`)

- **Access:** Any authenticated user; opened by clicking "Print QR Code" on the asset detail page
- **URL generated:** `${window.location.origin}/asset/${asset.asset_code}` — uses `qrcode` npm package client-side
- **Layout options** (selectable before printing):
  - **Avery 21-up** (63.5×38mm labels — fits standard Avery L7160 / equivalent sheets)
  - **9-up cut sheet** (3×3 grid, A4/letter, cut with scissors)
  - **Single large** (full-page single label for server racks / panels)
- Print CSS hides the controls bar; only labels render on paper.

### Public QR Scan Landing (`/asset/[code]`)

Outside the `(dashboard)` layout — no authentication required. Served at `/asset/[code]`.

**Auth behaviour:**
- If the scanning user is logged in as a staff member → redirect immediately to `/facility/assets/{id}` (the full dashboard detail)
- If unauthenticated → show the public card

**Public card shows:**
- Asset name, code, location, floor, category, status badge
- Two action cards (conditionally shown):
  - **Service Upload** (shown only if `has_active_amc: true`): vendor uploads a service sheet after a visit → `POST /api/public/asset/[code]/service/upload`
  - **Report an Issue**: anyone can submit a fault report → `POST /api/public/asset/[code]/report` (creates a `facility_issue` with `reported_via: "self_service"`)

**API used by the public page:**
- `GET /api/public/asset/[code]` — returns `{ id, name, asset_code, status, location_name, floor_name, category_name, category_scope, has_active_amc }`. Uses `createAdminClient()` (no auth cookie needed). AMC check: queries `purchase_orders` where `linked_asset_id = asset.id AND po_type = 'service' AND amc_status IN ('active', 'expiring')`.
- `POST /api/public/asset/[code]/report` — creates a facility issue. Required body: `title`. Optional: `description`, `reporter_name`, `reporter_email`, `reporter_phone`. Uses `createAdminClient()`. Auto-assigns to `category.default_assignee_id` (if active); if the assignee is inactive, `notifyAdminsStaleAssignee()` fires.
- `POST /api/public/asset/[code]/service/upload` — uploads a service document for a vendor visit. Stores in `amc_event_attachments` with `uploaded_by_vendor: true`. Accepts `multipart/form-data`. Body: `file` (required), `vendor_name` (optional), `notes` (optional). Uses `createAdminClient()`.

**Gotcha — these are unauthenticated endpoints.** They use `createAdminClient()` and bypass RLS. They are intentionally open for QR scan use-cases (no login friction for vendors or members). Do not expand their scope beyond the specific operations listed above.

---

## Non-IT Category Seeding (Migration 00276)

All seven scopes now have seeded categories with scope-specific SLA defaults:

| Scope | Categories | SLA Range (Critical → Low) |
|---|---|---|
| IT | 12 categories (original seed) | 1h–72h |
| HVAC | AC, Exhaust Fan, Water Heater | 2h–96h |
| Plumbing | Water Supply, Drainage, Toilet, Water Tank | 2h–72h |
| Electrical | Lighting, Power Socket, MCB/Panel, UPS, Generator, Earthing | 1h–96h |
| Housekeeping | Furniture, Flooring, Glass/Windows, Pantry, Signage | 4h–120h |
| Security | CCTV (exists under IT), Door Access, Fire Safety, Visitor Mgmt | 1h–72h |
| Other | General Maintenance | 4h–96h |

---

## Migrations Reference (Recent)

| Migration | Description |
|---|---|
| `00270_facility_assets_lifecycle.sql` | Lifecycle stage enum, custom fields, AC category seed, FMS role in RLS |
| `00271_amc_asset_bridge.sql` | Bridge table linking assets to AMC contracts |
| `00272_asset_documents.sql` | Two-tier document storage for assets (`asset_documents` table) |
| `00273_checklists_visit_quality.sql` | Checklist templates and per-visit checklist items |
| `00274_amc_service_tokens.sql` | `amc_service_tokens` table (time-limited vendor QR links); `amc_event_attachments` table; `vendor_notes`/`vendor_submitted_at`/`service_token_id` added to `amc_service_events` |
| `00275_amc_attachments_nullable_event.sql` | Allow `amc_event_attachments.event_id` to be NULL (vendor uploads via QR before event is created); add `notes` column |
| `00276_seed_non_it_categories.sql` | Seed categories for all non-IT scopes (HVAC, Plumbing, Electrical, Housekeeping, Security, Other) |
| `00277_facility_asset_events.sql` | Create `facility_asset_events` table — append-only event log per asset |
| `00278_asset_events_add_issue_id.sql` | Add `issue_id` FK to asset events for issue linking |
| `00279_facility_issues_category_nullable.sql` | Make `category_id` nullable on `facility_issues` — scope-first reporting |
| `00292_facility_category_assignees.sql` | Add `default_assignee_id` and `backup_assignee_id` to `facility_asset_categories` — enables per-category issue routing |
| `00293_purchase_requests_issue_link.sql` | Add `issue_id` FK to `purchase_requests` — links a material request to the facility issue that triggered it; drives asset cost-of-ownership reporting |
| `00294_facility_asset_events_issue_link.sql` | Safe no-op — `issue_id` already existed from migration 00278 |
| `00300_facility_assets_rls_floor_manager.sql` | Extend `facility_assets` RLS write policy to include `floor_manager` and `office_admin` roles |
| `00301_facility_asset_photos.sql` | Add `facility_asset_photos` table — multiple photos per asset stored in `facility-asset-photos` bucket (id, asset_id, photo_url, caption, uploaded_by, created_at) |
| `00305_facility_issues_claim_model.sql` | Add claim model to `facility_issues`: `claimed_by uuid REFERENCES users(id)`, `claimed_at timestamptz`; introduces `claimed` intermediate status for floor manager pre-assignment |

---

## Changelog

### 2026-06-28

**Asset Photos (migrations 00300, 00301)**
- `facility_assets` RLS write policy extended to include `floor_manager` and `office_admin` roles (migration 00300).
- New `facility_asset_photos` table added (migration 00301): stores multiple standalone photos per asset, separate from event-linked photos. Bucket: `facility-asset-photos`. Columns: `id`, `asset_id`, `photo_url`, `caption`, `uploaded_by`, `created_at`.
- API: `POST /api/facility/assets/[id]/photos` to upload; `DELETE` to remove.
- `asset-form-dialog.tsx` updated to support photo uploads via this new table.

**QR Scanner Dialog**
- New `src/components/facility/qr-scanner-dialog.tsx` (`QrScannerDialog`): in-app QR scanner for reading printed asset QR codes in the field. Quickly navigates to the asset detail page without manual search.

**Facility SLA Check Cron**
- New `src/app/api/cron/facility-sla-check/route.ts`: runs every 6 hours (`0 */6 * * *` in `vercel.json`). Finds open issues past their SLA deadline, marks `sla_breached = true`, and sends a digest alert to FMS + admin. Protected by `Authorization: Bearer CRON_SECRET`. (Previously documented above was already up-to-date; entry here for changelog completeness.)

**Claim Model (migration 00305)**
- `facility_issues` gains `claimed_by uuid` and `claimed_at timestamptz` columns.
- A floor manager can claim an open issue before formal assignment, preventing duplicate work.
- `claimed` is now an intermediate status value between `new` and `acknowledged`/`in_progress`.

**Assignees API**
- `GET /api/facility/assignees` — returns users with roles `fms`, `admin`, `floor_manager` eligible to be assigned issues or configured as category routing targets.

**Facility Notifications**
- `src/lib/facility-notifications.ts` extended with centralised helpers for issue status changes, SLA breach alerts, and assignment notifications.
