# Pipeline

## Purpose and Business Context

The Pipeline module is the kanban-style sales board for The WorkVilla CRM. It gives the sales and management team a single-glance view of every active lead grouped by stage, and lets them advance a lead to the next stage by dragging the card to the target column. It is the primary visual interface for tracking where prospective coworking customers are in the sales cycle (new enquiry → site tour → proposal → contract).

The Pipeline page sits inside the authenticated dashboard at `/pipeline` and is listed in the sidebar under the **Sales** section alongside Leads, Activities, Tasks, and Proposals. It complements the table-based `/leads` view with a spatial, workflow-oriented layout.

---

## Routes

| Route | File | What it renders |
|-------|------|-----------------|
| `/pipeline` | `src/app/(dashboard)/pipeline/page.tsx` | Full Kanban board — one column per `lead_status` value, all leads (up to 200), drag-to-move |

There are no sub-routes or modals living under `/pipeline`. Clicking a card navigates to `/leads/[id]` (the lead detail page).

---

## Key Source Files

| File | Role |
|------|------|
| `src/app/(dashboard)/pipeline/page.tsx` | Entire Pipeline page — `PipelinePage`, `PipelineColumn`, `LeadCard` components all inline |
| `src/hooks/use-leads.ts` | `useLeads()` hook — wraps `usePaginatedFetch` against `GET /api/leads` |
| `src/app/api/leads/route.ts` | `GET` (list/filter/paginate) and `POST` (create) for the `leads` table |
| `src/app/api/leads/[id]/route.ts` | `GET` (single lead), `PATCH` (update/stage change), `DELETE` (admin hard delete) |
| `src/app/api/leads/[id]/archive/route.ts` | `POST` — soft-disable or re-enable a lead (admin/manager only) |
| `src/app/api/leads/[id]/activities/route.ts` | `GET`/`POST` activities; `POST` triggers `autoUpdateLeadStatus` |
| `src/app/api/leads/[id]/proposals/route.ts` | `GET`/`POST` proposals for a lead |
| `src/app/api/leads/[id]/contacts/route.ts` | `GET`/`POST`/`PATCH`/`DELETE` additional contact people on a lead |
| `src/app/api/leads/[id]/feedbacks/route.ts` | `GET` booking feedback entries tied to this lead |
| `src/app/api/leads/[id]/billing-summary/route.ts` | `GET` revenue KPIs across bookings + contracts for a lead |
| `src/app/api/leads/[id]/id-proof/route.ts` | `POST` — upload identity document to B2 storage |
| `src/app/api/leads/import/route.ts` | `POST` — bulk CSV import (admin/manager only, Zoho-format mapping) |
| `src/lib/auto-status.ts` | `autoUpdateLeadStatus()` — system rules for status progression |
| `src/lib/validations.ts` | `createLeadSchema`, `updateLeadSchema`, `importLeadSchema` (Zod) |
| `src/lib/constants.ts` | `LEAD_STATUSES`, `LEAD_STATUS_LABELS`, `LEAD_STATUS_COLORS`, `LEAD_SOURCES`, `MANUAL_LEAD_STATUSES`, `SYSTEM_LEAD_STATUSES`, `WORKSPACE_TYPES` |
| `src/types/index.ts` | `Lead`, `LeadStatus`, `LeadSource`, `Rating`, `WorkspaceType` TypeScript types |
| `src/components/shared/status-badge.tsx` | `RatingBadge` component used on each kanban card |

---

## Data Model

### `leads` table

Primary table powering the Pipeline. Created in `supabase/migrations/00001_initial_schema.sql`; columns added across many subsequent migrations.

| Column | Type | Constraints / Notes |
|--------|------|---------------------|
| `id` | UUID | PK, `uuid_generate_v4()` |
| `lead_number` | INTEGER | NOT NULL, UNIQUE, `DEFAULT nextval('leads_number_seq')` — sequence starts at 1001, never reused |
| `first_name` | VARCHAR(255) | NOT NULL |
| `last_name` | VARCHAR(255) | NOT NULL |
| `company` | VARCHAR(255) | optional |
| `aggregator_contact_name` | VARCHAR(255) | optional |
| `email` | VARCHAR(255) | optional (but required by `createLeadSchema` Zod validation) |
| `phone` | VARCHAR(20) | optional |
| `mobile` | VARCHAR(20) | optional (required by `createLeadSchema`) |
| `website` | VARCHAR(500) | optional, must be a valid URL if provided |
| `title` | VARCHAR(255) | optional |
| `secondary_email` | VARCHAR(255) | optional, must be valid email format if provided |
| `status` | `lead_status` ENUM | DEFAULT `'new'` |
| `source` | `lead_source` ENUM | DEFAULT `'other'` |
| `industry` | VARCHAR(255) | optional |
| `no_of_employees` | INTEGER | optional, positive |
| `rating` | `lead_rating` ENUM | DEFAULT `'none'` — values: `none`, `hot`, `warm`, `cold` |
| `score` | INTEGER | DEFAULT 0, CHECK `score >= 0 AND score <= 100`; updated by booking feedback trigger |
| `workspace_type` | `workspace_type` ENUM | optional |
| `seat_capacity` | INTEGER | optional, positive |
| `preferred_location` | VARCHAR(255) | free-text, legacy field |
| `location_id` | UUID | FK → `locations(id) ON DELETE SET NULL`; added in migration 00006 |
| `working_hours` | VARCHAR(255) | optional |
| `budget_per_seat` | DECIMAL(12,2) | optional |
| `pan_number` | VARCHAR(20) | optional; added in migration 00007 |
| `gst_number` | VARCHAR(20) | optional; added in migration 00063; validated by regex `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$` in Zod schema |
| `entity_type` | TEXT | optional, nullable; added in migration 00061; values: `individual`, `proprietorship`, `partnership`, `llp`, `pvt_ltd`, `public_ltd`, `trust`, `society`, `huf`, `other` |
| `street`, `city`, `state`, `zip_code`, `country` | VARCHAR | address fields, all optional |
| `enquiry_form_google` | TEXT | optional, URL |
| `enquiry_form_direct` | TEXT | optional, URL |
| `description` | TEXT | optional |
| `tags` | TEXT[] | DEFAULT `'{}'` — GIN indexed; `null` is coerced to `[]` in API response |
| `assigned_to` | UUID | FK → `users(id) ON DELETE SET NULL` |
| `created_by` | UUID | FK → `users(id) ON DELETE SET NULL` |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() |
| `updated_at` | TIMESTAMPTZ | AUTO-UPDATED via trigger |
| `converted_at` | TIMESTAMPTZ | set when status transitions to `won` |
| `lost_at` | TIMESTAMPTZ | set when status transitions to `lost` |
| `lost_reason` | TEXT | optional |
| `archived_at` | TIMESTAMPTZ | NULL = active; non-NULL = soft-disabled; added in migration 00209 |
| `archived_by` | UUID | FK → `users(id) ON DELETE SET NULL` |
| `archive_reason` | TEXT | optional free text |
| `id_proof_path` | TEXT | B2 storage path; added in migration 00087 |
| `id_proof_uploaded_at` | TIMESTAMPTZ | upload timestamp |
| `search_vector` | TSVECTOR | auto-maintained by `leads_search_vector_update` trigger (indexes: first_name, last_name, email, phone, company, tags) |

### Indexes

| Index | Type | Columns |
|-------|------|---------|
| `idx_leads_status` | B-tree | `status` |
| `idx_leads_source` | B-tree | `source` |
| `idx_leads_assigned_to` | B-tree | `assigned_to` |
| `idx_leads_created_at` | B-tree | `created_at DESC` |
| `idx_leads_search` | GIN | `search_vector` |
| `idx_leads_tags` | GIN | `tags` |
| `idx_leads_location_id` | B-tree | `location_id` |
| `idx_leads_archived_at` | B-tree | `archived_at` |
| `idx_leads_location_created_at` | B-tree | `(location_id, created_at DESC)` |
| `idx_leads_first_name_trgm` | GIN trgm | `first_name` |
| `idx_leads_last_name_trgm` | GIN trgm | `last_name` |
| `idx_leads_company_trgm` | GIN trgm | `company` |

### DB Enums

```sql
CREATE TYPE lead_status AS ENUM (
  'new', 'contacted', 'tour_scheduled', 'tour_completed',
  'proposal_sent', 'negotiating', 'won', 'lost'
  -- 'junk' added later via ALTER TYPE in migration 00233
);

CREATE TYPE lead_source AS ENUM (
  'meta_ads', 'direct_walkin', 'online_form', 'referral',
  'social_media', 'advertisement', 'cold_call', 'event', 'partner', 'other'
  -- 'google_ads' added via migration 00016
);

CREATE TYPE workspace_type AS ENUM (
  'hot_desk', 'dedicated_desk', 'private_office',
  'meeting_room', 'conference_room', 'virtual_office'
);

CREATE TYPE lead_rating AS ENUM ('none', 'hot', 'warm', 'cold');
```

### RLS Policies on `leads`

All authenticated users have read/write access (no per-row restriction):

```sql
CREATE POLICY "auth_read"   ON leads FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON leads FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON leads FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_delete" ON leads FOR DELETE USING (auth.uid() IS NOT NULL);
```

**Note:** Role restrictions (admin-only delete, admin/manager archive) are enforced purely in the API route handlers, not at the DB RLS layer. Anyone with a valid session could call the Supabase client directly and bypass those checks.

### `lead_contacts` table

Additional contact people per lead. Created in migration 00141.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `lead_id` | UUID | NOT NULL, FK → `leads(id) ON DELETE CASCADE` |
| `full_name` | TEXT | NOT NULL |
| `designation` | TEXT | e.g. "CFO", "Office Manager" |
| `email` | TEXT | optional |
| `phone` | TEXT | optional |
| `mobile` | TEXT | optional |
| `contact_role` | TEXT | NOT NULL DEFAULT `'general'`; CHECK constraint: `primary`, `finance`, `occupant`, `signatory`, `escalation`, `it`, `general` |
| `notes` | TEXT | optional |
| `is_active` | BOOLEAN | DEFAULT true |
| `created_by` | UUID | FK → `users(id)` |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

RLS: all authenticated users can SELECT/INSERT/UPDATE/DELETE.

### Related Tables (cascade behavior)

| Table | FK to `leads` | On DELETE |
|-------|--------------|-----------|
| `proposals` | `lead_id` | CASCADE (changed in 00032) |
| `contracts` | `lead_id` | CASCADE (changed in 00032) |
| `billing_statements` | `lead_id` | CASCADE (changed in 00032) |
| `usage_charges` | `lead_id` | CASCADE (changed in 00032) |
| `voucher_issuances` | `lead_id` | CASCADE (changed in 00032) |
| `activities` | `lead_id` | CASCADE (original) |
| `lead_contacts` | `lead_id` | CASCADE |
| `booking_feedbacks` | `lead_id` | CASCADE (migration 00010) |
| `bookings` | `lead_id` | SET NULL |
| `conference_bookings` | `lead_id` | SET NULL |
| `prepaid_packages` | `lead_id` | SET NULL |
| `lead_cautions` | `lead_id` | CASCADE |

**Cascade chain note:** `leads → proposals → contracts` uses SET NULL on `contracts.proposal_id` (migration 00033) so deleting a proposal does not block the contract. `contracts → billing_statements` and `contracts → usage_charges` are both CASCADE.

---

## Status Lifecycle

### Status Values and Display

| Status | Label | Column Color |
|--------|-------|-------------|
| `new` | New | `bg-gray-100 text-gray-800` |
| `contacted` | Contacted | `bg-blue-100 text-blue-800` |
| `tour_scheduled` | Tour Scheduled | `bg-purple-100 text-purple-800` |
| `tour_completed` | Tour Completed | `bg-indigo-100 text-indigo-800` |
| `proposal_sent` | Proposal Sent | `bg-yellow-100 text-yellow-800` |
| `negotiating` | Negotiating | `bg-orange-100 text-orange-800` |
| `won` | Won | `bg-green-100 text-green-800` |
| `lost` | Lost | `bg-red-100 text-red-800` |
| `junk` | Junk | `bg-zinc-100 text-zinc-500` |

### Manual vs System Statuses

`MANUAL_LEAD_STATUSES` (can be set by a sales rep in the edit form):
```
new, contacted, negotiating, lost, junk
```

`SYSTEM_LEAD_STATUSES` (set only by system events, removed from the edit form UI):
```
tour_scheduled, tour_completed, proposal_sent, won
```

These constants enforce UI-level gating only — the API `PATCH /api/leads/[id]` will accept any valid enum value.

### Auto-Status Progression Rules (`src/lib/auto-status.ts`)

The function `autoUpdateLeadStatus(supabase, leadId, trigger, options?)` is **one-way only** — it never downgrades a status. Internal progression order used for comparison:

```
new → contacted → tour_scheduled → tour_completed → proposal_sent → negotiating → won → lost
```

Note: `junk` is not included in the `STATUS_ORDER` array — it is manual-only.

| Trigger | Condition | Target Status |
|---------|-----------|---------------|
| `"activity"` (call/meeting/note/email) | Current status is `new` | `contacted` |
| `"tour"` | `meeting_end_at` is in the past | `tour_completed` (if not already there or beyond) |
| `"tour"` | No `meeting_end_at` or future date | `tour_scheduled` (if not already there or beyond) |
| `"proposal"` | Current status is before `proposal_sent` | `proposal_sent` |
| `"contract"` | Current status is not `won` or `lost` | `won` + sets `converted_at` |

### Timestamp Side Effects on PATCH

When `PATCH /api/leads/[id]` is called with a status change:
- Status → `won` and `converted_at` not in body: sets `converted_at = new Date().toISOString()`
- Status → `lost` and `lost_at` not in body: sets `lost_at = new Date().toISOString()`

These are set in the API handler, not by a DB trigger.

---

## Pipeline Kanban Mechanics

### How Columns Are Built

`PipelinePage` fetches up to **200 leads** via `useLeads({ limit: 200 })`. It distributes them into `leadsByStatus` (a `Record<string, Lead[]>`) keyed by every value in `LEAD_STATUSES` (9 statuses). Leads whose status is not in `LEAD_STATUSES` are silently dropped from the view.

Archived leads (where `archived_at IS NOT NULL`) are excluded from the default fetch — `useLeads` does not pass `include_archived`, which means the API returns only non-archived leads.

### Drag and Drop

Library: `@dnd-kit/core` + `@dnd-kit/sortable`.

Sensor: `PointerSensor` with `activationConstraint: { distance: 8 }` — requires the pointer to move 8px before a drag starts (prevents accidental drags on clicks).

Collision detection: `closestCorners`.

**Drag end logic (critical):** The current implementation determines the target column by finding the lead card the dragged card is dropped *over* (`overLead.status`). It does **not** detect drops on an empty column area. This means:
- Dropping onto an empty column will not trigger a status change (no `overLead` found, `targetStatus` stays `null`).
- Only dropping onto another lead card in the target column will work.

On successful drop: `PATCH /api/leads/[id]` is called with `{ status: targetStatus }`, then `refetch()` is called regardless of the response status.

`DragOverlay` renders a ghost `LeadCard` with `isDragging=true` (opacity 50%) while dragging.

### Card Display

Each `LeadCard` shows:
- `first_name last_name` (truncated)
- `company` (truncated, if present)
- `email` (else `phone`) — one contact line
- `seat_capacity` seats (if `workspace_type` is set)
- `RatingBadge` — shows colored badge for `hot`, `warm`, `cold`; renders nothing for `none`

Clicking a card navigates to `/leads/[lead.id]`.

---

## API Routes

### `GET /api/leads`

Parameters accepted:

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `page` | int | 1 | Pagination |
| `limit` | int | 25 | Pipeline uses 200 |
| `status` | string | — | Filter by single status |
| `source` | string | — | Filter by source |
| `search` | string | — | `#<id>` for exact ID lookup; otherwise ilike on first_name, last_name, email, phone, company |
| `assigned_to` | UUID | — | |
| `rating` | string | — | |
| `location_id` | UUID | — | |
| `sort_by` | string | `created_at` | Any column name |
| `sort_order` | `asc`/`desc` | `desc` | |
| `include_archived` | `true`/`false` | `false` | When false, `archived_at IS NULL` filter applied |
| `phone_exact` | string | — | Quick lookup — returns `id, first_name, last_name, id_proof_path` only; bypasses all other filters |

**Response:** `{ data: Lead[], pagination: { page, limit, total, totalPages } }`

The response embeds a computed `_followup` field (not a DB column):
```ts
{ overdue: boolean, due_today: boolean, upcoming: boolean } | null
```
This is computed from the embedded `activities` join (filtered to `is_follow_up_done=false`), then the raw `_pending_followups` field is deleted. Leads are then sorted: overdue first → due_today → upcoming → rest.

**Select shape for list:**
```sql
*, assigned_user:users!leads_assigned_to_fkey(*),
   location:locations!leads_location_id_fkey(id, name, code),
   _pending_followups:activities!activities_lead_id_fkey(follow_up_date, is_follow_up_done)
```

### `POST /api/leads`

- Validates with `createLeadSchema` (Zod).
- Sets `created_by` and `assigned_to` (defaults to creating user if not provided).
- Fires `logAudit` (fire-and-forget).
- Fires WhatsApp `internalNewLead` alert to all staff with a phone number (fire-and-forget).

### `GET /api/leads/[id]`

Single lead with `assigned_user` and `location` joins. Coerces `tags: null → []`.

### `PATCH /api/leads/[id]`

- Validates with `updateLeadSchema` (Zod partial of `createLeadSchema`).
- Fetches current state for audit diff.
- Auto-stamps `converted_at` / `lost_at` when status transitions to `won` / `lost`.
- Calls `logAudit`.
- **No role restriction** — any authenticated user can update any lead field including status.

### `DELETE /api/leads/[id]`

- **Admin only** (`role === 'admin'`).
- Hard delete — cascades to all child records.
- Non-admins should use `POST /api/leads/[id]/archive` instead.

### `POST /api/leads/[id]/archive`

- **Admin or manager only.**
- Body: `{ archived?: boolean, reason?: string }` — `archived` defaults to `true`.
- Sets/clears `archived_at`, `archived_by`, `archive_reason`.
- Logs audit action `"disable"` or `"enable"`.

### `GET/POST /api/leads/[id]/activities`

POST auto-advances lead status via `autoUpdateLeadStatus`.

### `GET/POST /api/leads/[id]/proposals`

POST auto-advances lead status to `proposal_sent` via `autoUpdateLeadStatus`.

### `GET/POST/PATCH/DELETE /api/leads/[id]/contacts`

Contact person CRUD on `lead_contacts`. `contact_id` must be passed in body for PATCH and DELETE.

### `POST /api/leads/[id]/id-proof`

Accepts: JPG, PNG, WebP, HEIC, PDF. Stores in B2 `crm-documents` bucket at path `leads/{id}/id_proof_{timestamp}.{ext}`. Uses `adminSupabase` for storage upload.

### `GET /api/leads/[id]/billing-summary`

Params: `period=lifetime` (default) or `fy_current` (Indian FY: April 1 – March 31). Aggregates `booking_payments` (status=`verified`) and `contract_payments` (status=`verified`) for this lead. Returns revenue KPIs and a monthly time series bucketed in IST.

### `POST /api/leads/import`

- **Admin or manager only.**
- CSV file upload (multipart), max 10 MB, `.csv` extension required.
- Uses `transformZohoRow` from `src/lib/zoho-field-mapping.ts` for field name translation.
- Validates each row with `importLeadSchema`.
- Deduplicates by email (case-insensitive) against existing leads.
- Bulk-inserts in batches of 100; falls back to row-by-row on batch failure.
- Returns `{ total, imported, skipped, errors: [...], warnings: [...] }` (errors/warnings capped at 50).

---

## Validation Rules

### `createLeadSchema` (Zod) — enforced server-side on POST

| Field | Rule | Error |
|-------|------|-------|
| `first_name` | `min(1)` | "First name is required" |
| `last_name` | `min(1)` | "Last name is required" |
| `email` | `min(1)` + `.email()` | "Email is required" / "Invalid email address" |
| `mobile` | `min(1)` | "Mobile number is required" |
| `website` | `.url()` or `""` | "Invalid URL" |
| `secondary_email` | `.email()` or `""` | "Invalid email" |
| `gst_number` | regex `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$` or `""` | "Invalid GST number format (e.g. 33AAAAA0000A1Z5)" |
| `enquiry_form_google` | `.url()` or `""` | "Invalid URL" |
| `enquiry_form_direct` | `.url()` or `""` | "Invalid URL" |
| `score` | `int().min(0).max(100)` | range error |
| `no_of_employees` | `int().positive()` | positive integer |
| `seat_capacity` | `int().positive()` | positive integer |
| `budget_per_seat` | `.positive()` | positive number |
| `location_id` | `.uuid()` or `""` (transform `"" → undefined`) | UUID format |

`updateLeadSchema` is `createLeadSchema.partial()` — every field is optional.

### DB-level constraints

- `score CHECK (score >= 0 AND score <= 100)`
- `lead_number UNIQUE`
- `contact_role CHECK (contact_role IN ('primary','finance','occupant','signatory','escalation','it','general'))`
- `status` is an ENUM — invalid values rejected at DB level
- `source` is an ENUM — invalid values rejected at DB level

### Where rules are enforced

| Rule | Client | Server (Zod) | DB |
|------|--------|--------------|-----|
| Required first/last name | Lead form UI | Yes | NOT NULL |
| Email required | Lead form UI | Yes (`min(1)`) | No (column is nullable) |
| Mobile required | Lead form UI | Yes (`min(1)`) | No (column is nullable) |
| GST format | Lead form UI | Yes (regex) | No |
| Valid status | Drag-to-status sends any string | Yes (`z.enum(...)`) | Yes (ENUM) |
| Score 0–100 | — | Yes | Yes (CHECK) |
| Archive role check | — | — | No (API handler only) |
| Delete role check | — | — | No (API handler only) |

**Gotcha:** `email` is `NOT NULL` in the Zod schema but nullable in the DB. The `importLeadSchema` relaxes this — email is optional for imports.

---

## Role Permissions

Pipeline page access (sidebar nav): `admin`, `manager`, `sales_rep`, `floor_manager`, `viewer` (`LEGACY_ROLES`).

| Action | Allowed Roles |
|--------|--------------|
| View pipeline (read all leads) | All authenticated users (RLS: any session) |
| Drag card / `PATCH /api/leads/[id]` (status change) | All authenticated users |
| Create lead (`POST /api/leads`) | All authenticated users |
| Archive lead (`POST /api/leads/[id]/archive`) | `admin`, `manager` |
| Hard-delete lead (`DELETE /api/leads/[id]`) | `admin` only |
| Bulk CSV import (`POST /api/leads/import`) | `admin`, `manager` |

---

## Status Transition Triggers (Integration Points)

The Pipeline status machine is updated from four call sites:

1. **Activity logged** (`POST /api/leads/[id]/activities`):
   - Non-tour type → `new → contacted`
   - Tour type, past end time → `→ tour_completed`
   - Tour type, future/no end time → `→ tour_scheduled`

2. **Proposal created** (`POST /api/proposals`):
   - → `proposal_sent` if current status is before it in the order

3. **Contract activated** (`PATCH /api/contracts/[id]` with `status=active`):
   - → `won` + sets `converted_at`
   - Also triggers `generateMonthlyStatements` for immediate billing

4. **Manual drag on Pipeline board**:
   - `PATCH /api/leads/[id]` with `{ status: targetStatus }`
   - No validation of "allowed" transitions — any status can be set manually

---

## Integration with Other Modules

| Module | Relationship |
|--------|-------------|
| **Leads list** (`/leads`) | Same data source (`/api/leads`), table view vs. kanban view |
| **Lead detail** (`/leads/[id]`) | Clicking a kanban card navigates here |
| **Proposals** | `proposals.lead_id` FK; creating a proposal auto-advances status to `proposal_sent` |
| **Contracts** | `contracts.lead_id` FK; activating a contract auto-advances status to `won` |
| **Activities** | `activities.lead_id` CASCADE; logging activities drives `contacted`, `tour_scheduled`, `tour_completed` |
| **Billing statements** | `billing_statements.lead_id` CASCADE; billing summary endpoint aggregates payments |
| **Bookings** | `bookings.lead_id` SET NULL; booking feedback updates `leads.score` via DB trigger |
| **WhatsApp (MSG91)** | On `POST /api/leads`: fires `internalNewLead` to all staff phones (fire-and-forget) |
| **Audit log** | All mutations call `logAudit()` from `src/lib/audit.ts` |
| **Dashboard KPIs** | `pipeline` field in dashboard stats counts leads per status |
| **Daily digest** | `/api/digest` reads pipeline counts by status for the email report |

---

## Known Pitfalls and Gotchas

### Drop target detection

Dropping a card on an **empty column** silently does nothing — the drag end handler only detects the target column by finding the lead card you dropped over (`overLead.status`). There is no column droppable zone registered with `@dnd-kit`. Any feature to enable dropping onto empty columns requires adding `useDroppable` for each column or using the column element id as the `over.id`.

### `refetch()` is unconditional

`refetch()` is called after the `PATCH` regardless of whether it succeeded (`if (res.ok)` only shows the toast, not gates the refetch). This means failed moves will still refresh the board — the card will snap back to its original column after refetch.

### 200-lead hard cap

The pipeline fetches exactly 200 leads. Any lead beyond rank 200 (sorted by the API's follow-up priority then `created_at DESC`) will not appear on the board. There is no pagination or "load more" in the kanban view. For businesses with many leads this is a silent data omission.

### `junk` not in auto-status order

`SYSTEM_LEAD_STATUSES` and `STATUS_ORDER` in `auto-status.ts` do not include `junk`. Auto-status transitions will never set a lead to `junk`. Manual drag or direct `PATCH` is the only way. Be careful not to add `junk` to `STATUS_ORDER` — it would mean `autoUpdateLeadStatus` could advance leads through `junk`.

### Empty string vs null on optional URL fields

`website`, `enquiry_form_google`, `enquiry_form_direct` accept `""` as a valid value in the Zod schema (via `.or(z.literal(""))`) and the `importLeadSchema` saves these as-is. The POST handler explicitly converts empty strings to `null` only for `email`, `website`, `secondary_email`, `enquiry_form_google`, `enquiry_form_direct` during import. The regular create flow does not do this — passing `""` for `website` in a regular `POST /api/leads` body will store `""` in the DB (the `.url()` validator is skipped for empty strings because of `.or(z.literal(""))`).

### `tags` null coercion

The `GET /api/leads/[id]` handler coerces `data.tags = data.tags ?? []`. The list endpoint does not do this — `tags` on list rows could technically be `null` if a row has `tags = NULL` (DB default is `'{}'` but old imports may differ). Client code should always guard with `lead.tags ?? []`.

### Score updated by feedback trigger, not API

`leads.score` is set by a DB trigger on `booking_feedbacks` insert (migration 00010): `score = LEAST(100, GREATEST(0, ROUND((avg_rating - 1) * 25)))`. Do not try to update score directly via the leads API in feedback-related features.

### Hard delete cascades everything

`DELETE /api/leads/[id]` is a hard delete that cascades to proposals, contracts, billing statements, usage charges, vouchers, activities, and contacts. The comment in the route says "Hard delete cascades to proposals/contracts/billing." Non-admins must use the archive endpoint. Migration 00032 and 00033 document the cascade chain history.

### Search by `#id`

The `search` parameter starting with `#` is treated as an exact lead UUID lookup (`query.eq("id", search.slice(1))`). This is a hidden shortcut in the list API; the pipeline page does not expose a search box so this only matters for the `/leads` table.

---

## Environment / Config Dependencies

The Pipeline module has no dedicated feature flags or `app_settings` table keys.

Standard requirements:
- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` — client-side Supabase
- `SUPABASE_SERVICE_ROLE_KEY` — used by `createAdminClient()` in archive and import routes
- B2 storage env vars (`B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT`) — for ID proof upload
- `MSG91_AUTH_KEY` + `MSG91_WHATSAPP_SENDER` — for the new-lead WhatsApp alert (fire-and-forget, failure doesn't block lead creation)

---

## Key User Flows

### Moving a Lead to a New Stage (Drag and Drop)

1. User visits `/pipeline`.
2. `PipelinePage` calls `useLeads({ limit: 200 })` → `GET /api/leads?limit=200` (excludes archived).
3. Board renders 9 columns for each `LEAD_STATUSES` value.
4. User picks up a card (pointer must move ≥8px).
5. `DragOverlay` renders ghost card.
6. User drops on a card in the target column.
7. `handleDragEnd` finds `overLead`, computes `targetStatus = overLead.status`.
8. If `targetStatus !== draggedLead.status`: `PATCH /api/leads/[id]` `{ status: targetStatus }`.
9. API stamps `converted_at` (if won) or `lost_at` (if lost), runs `logAudit`, responds.
10. `toast.success("Lead moved to <label>")` shown.
11. `refetch()` called — board re-renders with updated positions.

### Creating a Lead (from Leads page, not Pipeline)

1. User opens `/leads`, clicks New Lead.
2. Form submits `POST /api/leads` with validated body.
3. API inserts with `status='new'`, fires WhatsApp alert to all staff.
4. New card appears in the "New" column on next pipeline load.

### Auto-Advancing Status via Tour Activity

1. User opens lead detail page, logs a tour activity with a past `meeting_end_at`.
2. `POST /api/leads/[id]/activities`.
3. API inserts activity, then calls `autoUpdateLeadStatus(supabase, id, "tour", { meetingEndAt })`.
4. Since `meetingEndAt` is past: status advances to `tour_completed` if currently before it.
5. Pipeline board on next fetch shows card in "Tour Completed" column.

### Archiving a Lead

1. Admin or manager visits lead detail, clicks Disable.
2. `POST /api/leads/[id]/archive` `{ archived: true, reason: "..." }`.
3. Sets `archived_at`, `archived_by`, `archive_reason`.
4. Lead disappears from Pipeline on next refetch (API excludes `archived_at IS NOT NULL` by default).
5. Lead can be re-enabled via same endpoint with `{ archived: false }`.

### Bulk CSV Import

1. Admin or manager goes to `/leads`, clicks Import.
2. Uploads a CSV file (≤10 MB, `.csv` extension, Zoho export format supported).
3. `POST /api/leads/import` parses with PapaParse, maps fields via `transformZohoRow`.
4. Each row validated against `importLeadSchema`.
5. Existing emails (case-insensitive) are skipped.
6. New leads inserted in batches of 100; row-by-row fallback on batch failure.
7. Response shows `{ total, imported, skipped, errors, warnings }`.
8. Audit log entry created for the bulk import action.
