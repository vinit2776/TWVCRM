# Admin

## Purpose and Business Context

The Admin module is the configuration backbone of TWV CRM. It covers three broad domains:

1. **Team / User Management** (`/team`) — create CRM users, assign roles, reset passwords, activate/deactivate accounts, view per-user audit history.
2. **App Settings** (`/settings`) — Razorpay payment gateway credentials, UPI config, GST invoice mode toggle, Tally sync toggle, procurement approval threshold, dashboard widget layout per role, petty-cash categories, location services, reorder levels, department budgets, and e-invoicing (IRP) config.
3. **Locations** (`/locations`, `/locations/[id]`) — coworking centre master data, floor plans, space unit inventory, electricity billing config, and space occupancy analytics.

Additional admin-only sub-routes under `/admin/` exist for the physical access control system (COSEC), Tally Sync control panel, and live headcount.

---

## All Routes and What Each Renders

| Route | File | Who Can See | Purpose |
|---|---|---|---|
| `/team` | `src/app/(dashboard)/team/page.tsx` | `admin`, `manager`, `sales_rep` | List all CRM users; admin can create/edit/deactivate/reset passwords |
| `/settings` | `src/app/(dashboard)/settings/page.tsx` | All roles (tabs filtered by role) | Profile edit for everyone; admin-only tabs for gateway, procurement, etc. |
| `/locations` | `src/app/(dashboard)/locations/page.tsx` | `admin`, `manager`, `fms`, `floor_manager` | List and create locations |
| `/locations/[id]` | `src/app/(dashboard)/locations/[id]/page.tsx` | Same | Floor/unit management, analytics, electricity config |
| `/admin/tally-sync` | `src/app/(dashboard)/admin/tally-sync/page.tsx` | `admin` only | Tally bridge status, GST invoice mode, ledger mapping, audit log |
| `/admin/employees` | `src/app/(dashboard)/admin/employees/page.tsx` | `admin`, `manager`, `office_admin`, `floor_manager`, `fms` | Physical access staff roster + COSEC provisioning |
| `/admin/employees/[id]` | `src/app/(dashboard)/admin/employees/[id]/page.tsx` | Same | Employee detail + enrollment history |
| `/admin/cosec-devices` | `src/app/(dashboard)/admin/cosec-devices/page.tsx` | `admin`, `manager`, `fms`, `it_manager`, `it_technician` | COSEC door reader hardware list |
| `/admin/cosec-access` | `src/app/(dashboard)/admin/cosec-access/page.tsx` | Same | Access enrollment management across devices |
| `/admin/access-profiles` | `src/app/(dashboard)/admin/access-profiles/page.tsx` | Same | COSEC access profiles |
| `/admin/access-analytics` | `src/app/(dashboard)/admin/access-analytics/page.tsx` | Same | Access event charts |
| `/admin/live-headcount` | `src/app/(dashboard)/admin/live-headcount/page.tsx` | `admin`, `manager`, `fms`, `floor_manager`, `office_admin` | Real-time occupancy counts |
| `/admin/push` | `src/app/(dashboard)/admin/push/page.tsx` | (admin) | Push notification testing |
| `/admin/dept-ids` | `src/app/(dashboard)/admin/dept-ids/page.tsx` | (admin) | Department ID management |
| `/admin/tally-sync` | see above | `admin` | Tally Sync control |
| `/audit-logs` | (separate module) | `admin`, `manager` | Audit trail viewer |

---

## Key Source Files

### Pages
- `src/app/(dashboard)/team/page.tsx` — user management UI (create, edit role, deactivate, password reset, share credentials)
- `src/app/(dashboard)/settings/page.tsx` — settings hub with tab-gated sub-components
- `src/app/(dashboard)/locations/page.tsx` — location list + add dialog
- `src/app/(dashboard)/locations/[id]/page.tsx` — location detail: floors, units, analytics, electricity

### Components
- `src/components/settings/payment-gateway-settings.tsx` — Razorpay keys + UPI QR management
- `src/components/settings/procurement-settings.tsx` — approval threshold + role permission matrix display
- `src/components/settings/dashboard-settings.tsx` — per-role dashboard widget ordering
- `src/components/settings/petty-cash-settings.tsx` — petty cash category CRUD
- `src/components/settings/services-settings.tsx` — per-location services/prices CRUD
- `src/components/settings/reorder-settings.tsx` — procurement reorder levels
- `src/components/settings/procurement-budget-settings.tsx` — department budgets
- `src/components/settings/e-invoice-settings.tsx` — IRP/GST e-invoicing configuration
- `src/components/locations/location-form-dialog.tsx` — add/edit location form
- `src/components/locations/electricity-config-tab.tsx` — location-level electricity billing setup
- `src/components/admin/publish-bridge-card.tsx` — Tally bridge release card in tally-sync page

### API Routes
- `POST /api/team` — create user (admin only, calls `supabase.auth.admin.createUser`)
- `PATCH /api/team/[id]` — update user: role, is_active, full_name, phone, email, password (admin only)
- `GET /api/users` — list all users enriched with `push_enabled` flag (any authenticated)
- `PATCH /api/users/[id]` — update role/is_active only (admin only; uses `createAdminClient`)
- `GET /api/users/[id]/activity-log` — paginated audit trail for one user (limit 100)
- `GET /api/settings` — all app_settings masked (admin only; secrets show `••••` + last 4 chars)
- `PATCH /api/settings` — upsert `app_settings` rows; masked values (`••••…`) are skipped (admin only)
- `GET /api/settings/public` — non-secret keys for frontend use (any authenticated)
- `POST /api/settings/test-razorpay` — live Razorpay connectivity test (admin only)
- `GET /api/settings/dashboard` — widget config for a role (any auth) or full config (admin only)
- `PATCH /api/settings/dashboard` — update widget list for one role (admin only)
- `GET /api/locations` — list locations with in-charge user joins (any auth; `?is_active=true/false` filter)
- `POST /api/locations` — create location (admin or manager)
- `GET /api/locations/[id]` — single location (any auth)
- `PUT /api/locations/[id]` — update location fields including UniFi config (admin or manager)
- `DELETE /api/locations/[id]` — soft-delete (sets `is_active = false`) (admin only)
- `GET /api/locations/[id]/floors` — list floors ordered by `sort_order` then `floor_number`
- `POST /api/locations/[id]/floors` — create floor (admin or manager)
- `DELETE /api/locations/[id]/floors/[floorId]` — delete floor (admin or manager)
- `GET /api/locations/[id]/space-units` — list units with active contract allocations joined
- `POST /api/locations/[id]/space-units` — create unit (admin or manager)
- `PUT /api/locations/[id]/space-units/[unitId]` — edit unit
- `DELETE /api/locations/[id]/space-units/[unitId]` — delete unit
- `GET /api/locations/[id]/space-analytics` — occupancy/CUF/revenue analytics
- `GET /api/locations/[id]/print-template` — PDF header template
- `PUT /api/locations/[id]/electricity-config` — upsert electricity billing config (admin or manager)

---

## Data Model

### Table: `users`

Created in `00001_initial_schema.sql`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Internal ID used everywhere in CRM |
| `auth_id` | UUID UNIQUE NOT NULL | Foreign key into `auth.users` |
| `email` | VARCHAR(255) | Not editable by user themselves (admin uses `auth.admin.updateUserById`) |
| `full_name` | VARCHAR(255) NOT NULL | Editable in `/settings` profile tab |
| `avatar_url` | TEXT | Optional |
| `phone` | VARCHAR(20) | Editable by the user themselves |
| `role` | `user_role` ENUM | Default `sales_rep` |
| `is_active` | BOOLEAN | Default `true`. Inactive users still exist in auth |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | Auto-updated via trigger |
| `last_login_at` | TIMESTAMPTZ | Nullable |

**RLS**: Table has RLS enabled. Policies are permissive for authenticated users (pattern from initial schema). Role-based enforcement is at the API layer, not DB layer, for the users table.

**`user_role` ENUM evolution** (accumulated across migrations):
- Initial: `'admin'`, `'manager'`, `'sales_rep'`
- `00008`: `'floor_manager'`
- `00058`: `'accounts'`, `'fms'`
- `00093`: `'office_admin'`
- `00115`: `'it_manager'`, `'it_technician'`
- `00118`: `'facility_staff'`
- `00145`: `'it_team'`
- `00178`: `'viewer'`

The TypeScript `UserRole` type in `src/types/index.ts` is: `"admin" | "manager" | "sales_rep" | "floor_manager" | "accounts" | "fms" | "office_admin" | "it_manager" | "it_technician" | "viewer"`.

The `VALID_ROLES` array in `src/app/api/users/[id]/route.ts` includes `"viewer"`. The `POST /api/team` and `PATCH /api/team/[id]` routes use a slightly different allowlist that excludes `it_manager`, `it_technician`, and `viewer` (only: `admin`, `manager`, `sales_rep`, `floor_manager`, `accounts`, `fms`, `office_admin`). Do not try to assign `it_manager` etc. via the team UI — use the `PATCH /api/users/[id]` route directly.

`USER_ROLES` in `src/lib/constants.ts` (used for dashboard widget config validation) does NOT include `it_manager`, `it_technician`, or `viewer` — only the 7 core roles.

### Table: `app_settings`

Created in `00011_payments_gateway.sql`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `key` | VARCHAR(100) UNIQUE NOT NULL | Lookup key |
| `value` | TEXT NOT NULL DEFAULT '' | All values stored as text strings |
| `is_encrypted` | BOOLEAN DEFAULT false | Reserved flag, not enforced by DB |
| `updated_by` | UUID REFERENCES users(id) | Who last changed it |
| `created_at` / `updated_at` | TIMESTAMPTZ | Auto-updated |

**RLS**: `authenticated` role can SELECT, INSERT, and UPDATE. There are NO role-check policies at DB level — enforcement is entirely in the API routes (`role !== 'admin'` check). This means any authenticated user with direct DB access could read or write settings — RLS is permissive here.

**Known keys** (comprehensive list from migrations):

| Key | Purpose | Editable via |
|---|---|---|
| `razorpay_key_id` | Razorpay public key | `/api/settings` |
| `razorpay_key_secret` | Razorpay secret (masked in GET) | `/api/settings` |
| `razorpay_webhook_secret` | Webhook HMAC secret (masked in GET) | `/api/settings` |
| `razorpay_enabled` | `'true'/'false'` toggle | `/api/settings` |
| `upi_id` | Merchant UPI ID | `/api/settings` |
| `upi_qr_code_path` | Storage path to QR image | `/api/settings` |
| `crm_gst_enabled` | `'true'/'false'` — CRM issues GST invoices | `/api/settings` + Tally Sync page |
| `tally_sync_enabled` | `'true'/'false'` — Tally bridge active | `/api/tally/control` |
| `tally_handoff_v2_enabled` | `'true'/'false'` — v2 handoff protocol | `/api/tally/control` |
| `tally_irn_alarm_hours` | Hours after which unresolved IRN triggers alert | `/api/tally/control` |
| `tally_company_gstin` | Locked Tally company GSTIN | `/api/tally/control` |
| `tally_locked_company` | Exact Tally company name guard | `/api/tally/control` |
| `tally_ledger_*` | Various Tally ledger name mappings | Tally Sync page |
| `tally_voucher_series` | Sales series (GST / registered) | Tally Sync page |
| `tally_voucher_series_unreg` | Sales series (non-GST) | Tally Sync page |
| `procurement_approval_threshold` | Amount above which admin approval required | `/api/procurement/settings` |
| `dashboard_role_widgets` | JSON blob: `{role: widgetId[]}` | `/api/settings/dashboard` |
| `digest_recipients` | Email digest recipients | (migration seed) |
| `petty_cash_*` | Petty cash settings | `/api/petty-cash/categories` |
| `e_invoice_config` | JSON blob: full IRP config | `/api/e-invoice/settings` |
| `lease_auto_approve_threshold` | Rent management auto-approve amount | (migration seed) |

**VALID_KEYS enforced in `PATCH /api/settings`**: `razorpay_key_id`, `razorpay_key_secret`, `razorpay_webhook_secret`, `razorpay_enabled`, `upi_id`, `upi_qr_code_path`, `crm_gst_enabled`, `tally_sync_enabled`. Keys outside this list are silently ignored.

**PUBLIC_KEYS exposed via `GET /api/settings/public`** (any authenticated user): `razorpay_enabled`, `razorpay_key_id`, `upi_id`, `upi_qr_code_path`, `crm_gst_enabled`, `tally_sync_enabled`. The endpoint also fetches the QR image from B2 storage and returns it as `upi_qr_code_base64` for PDF embedding.

### Daily Digest (`GET /api/digest`)

Cron-triggered (`vercel.json`, `0 15 * * *` UTC = 8:30 PM IST) email sent to `digest_recipients`. Supports `?date=YYYY-MM-DD` to generate for a specific day, and `?preview=1` to return the rendered HTML directly (`Content-Type: text/html`) instead of sending — use this for local/staging QA so testing against production data never fans out real emails.

The email opens with a **Today's Storyline** section (`buildStoryboardHtml()` in `src/app/api/digest/route.ts`): up to 5 of the day's highest-significance `audit_trail` events as an icon timeline (ranked by entity weight, `create` actions, and ₹ amounts found in the `changes` diff — one event per record, latest touch wins), followed by a single deterministic headline sentence synthesizing the day's biggest facts plus the most urgent open item (`buildStoryHeadline()`). Event labels reuse `summarizeAuditEvent()` from `src/lib/audit-labels.ts`. No LLM call — everything is a rule-based template so the section is free and renders identically every day. It does not duplicate the KPI tiles or "Needs Attention" section further down the same email — it leads into them.

### Table: `locations`

Created in `00006_multi_location.sql`; columns added across later migrations.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | VARCHAR(255) NOT NULL | |
| `code` | VARCHAR(10) UNIQUE NOT NULL | Auto-uppercased by API. Duplicate → HTTP 409 |
| `address` | TEXT | |
| `city` | VARCHAR(255) | |
| `state` | VARCHAR(255) | |
| `is_active` | BOOLEAN DEFAULT true | "Delete" is a soft-delete (sets to false) |
| `capacity_config` | JSONB | `{open_desk, private_cabin, meeting_room, conference_room}` |
| `requires_headcount` | BOOLEAN DEFAULT false | Whether this centre needs daily headcount entry |
| `latitude` / `longitude` | NUMERIC | Optional geo coords |
| `incharge_user_id_1` / `incharge_user_id_2` | UUID REFERENCES users(id) ON DELETE SET NULL | Up to 2 floor in-charges |
| `unifi_site_id` | TEXT | UniFi controller site (for voucher API mode) |
| `unifi_console_id` | TEXT | UniFi cloud console UUID |
| `wifi_voucher_mode` | TEXT | `'repository'` (default) or `'unifi_api'` |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**DB constraint** (`locations_incharges_distinct`): `incharge_user_id_1 IS NULL OR incharge_user_id_2 IS NULL OR incharge_user_id_1 <> incharge_user_id_2`. The same user cannot occupy both in-charge slots. The API returns HTTP 400 with `"The two floor in-charges must be different users"` before the DB round-trip.

**RLS**: SELECT open to all authenticated. INSERT/UPDATE/DELETE also open to all authenticated (permissive policies). Enforcement at API layer.

**FK join aliases for PostgREST**: The locations API uses named FK aliases:
```
incharge_1:users!locations_incharge_user_id_1_fkey(id, full_name, email, role)
incharge_2:users!locations_incharge_user_id_2_fkey(id, full_name, email, role)
```
These must be used verbatim in any Supabase select that wants in-charge user details.

### Table: `location_floors`

Created in `00112_space_management.sql`.

| Column | Type | Constraint |
|---|---|---|
| `id` | UUID PK | |
| `location_id` | UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE | |
| `name` | VARCHAR(255) NOT NULL | Required; empty string rejected by API |
| `floor_number` | INTEGER | Nullable; -1 = basement, 0 = ground, 1, 2… |
| `total_area_sqft` | NUMERIC(10,2) DEFAULT 0 | |
| `leasable_area_sqft` | NUMERIC(10,2) DEFAULT 0 | Must not exceed `total_area_sqft` when total > 0 (API check) |
| `grid_cols` | INTEGER DEFAULT 20 CHECK (grid_cols BETWEEN 10 AND 30) | |
| `grid_rows` | INTEGER DEFAULT 12 CHECK (grid_rows BETWEEN 8 AND 20) | |
| `sort_order` | INTEGER DEFAULT 0 | Floors sorted by `sort_order` then `floor_number` |

**RLS**: SELECT open; INSERT/UPDATE/DELETE require `role IN ('admin', 'manager') AND is_active = true`.

### Table: `space_units`

Created in `00112_space_management.sql`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `location_id` | UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE | |
| `floor_id` | UUID REFERENCES location_floors(id) ON DELETE SET NULL | Optional |
| `name` | VARCHAR(255) NOT NULL | |
| `code` | VARCHAR(20) NOT NULL | Auto-uppercased; unique among active units per location |
| `type` | `space_unit_type` ENUM | `hot_desk`, `dedicated_desk`, `private_cabin`, `managed_office`, `business_centre` |
| `capacity` | INTEGER DEFAULT 1 | Seat count |
| `area_sqft` | NUMERIC(10,2) | Optional |
| `monthly_rate` | NUMERIC(12,2) | NULL for `business_centre` type (which is hourly-only) |
| `daily_rate` | NUMERIC(12,2) | Optional |
| `hourly_rate` | NUMERIC(10,2) | Primary rate for `business_centre` |
| `amenities` | TEXT[] DEFAULT '{}' | |
| `is_active` | BOOLEAN DEFAULT true | |
| `grid_col`, `grid_row` | INTEGER DEFAULT 1 | 1-indexed position on floor grid |
| `grid_col_span`, `grid_row_span` | INTEGER DEFAULT 2 | Size on grid |
| `color` | VARCHAR(20) | Optional hex/CSS color |
| `sort_order` | INTEGER DEFAULT 0 | |

**Unique index**: `idx_space_units_location_code_active` — unique on `(location_id, code) WHERE is_active = true`. Inactive units don't block code reuse. Duplicate active code → HTTP 409.

**Grid bounds validation** (API-enforced, not DB): When `floor_id` is provided, the API checks `col + col_span - 1 <= floor.grid_cols` and `row + row_span - 1 <= floor.grid_rows`.

**RLS**: SELECT open; INSERT/UPDATE/DELETE require `role IN ('admin', 'manager') AND is_active = true`.

### Table: `location_electricity_config`

Upserted (one row per location). Full schema in `src/types/index.ts` `LocationElectricityConfig`. Key Zod validation in `PUT /api/locations/[id]/electricity-config`:
- `landlord_utility_pct + landlord_generator_pct` must equal 100 (within 0.01 tolerance)
- `bill_due_day_of_month` must be integer 1–28

---

## Business Rules

### User Management (Hard Rules)

1. **Only `admin` can create users** — checked in `POST /api/team`.
2. **Only `admin` can change roles or activation status** — checked in `PATCH /api/users/[id]` and `PATCH /api/team/[id]`.
3. **Only `admin` can read or write `app_settings` secret keys** — checked in `GET /api/settings` and `PATCH /api/settings`.
4. **Password minimum length is 6 characters** — enforced in both create and password-change flows.
5. **Email cannot be changed from the profile tab** — the email field is disabled. Only admin can change email via `PATCH /api/team/[id]` which calls `auth.admin.updateUserById`.
6. **Role is read-only in the profile tab** — shown as disabled input. Role changes are admin-only.
7. **Deactivated users remain in Supabase Auth** — `is_active = false` only blocks CRM access (middleware checks); it does not delete the auth record.
8. **Audit trail is mandatory for all role/status changes** — `logAudit()` is called on every user mutation. Secrets logged as `[REDACTED]`.

### Location Management (Hard Rules)

1. **Location `code` must be unique** (DB UNIQUE constraint). Always uppercased by API.
2. **Two in-charges must be different users** (DB CHECK constraint `locations_incharges_distinct`). Validated at API before DB insert.
3. **Location "delete" is always soft-delete** (`is_active = false`). There is no hard-delete path for locations.
4. **`leasable_area_sqft` cannot exceed `total_area_sqft`** (API validation on floor creation/update).
5. **Floor `grid_cols` must be 10–30; `grid_rows` must be 8–20** (DB CHECK constraint).
6. **Unit `code` must be unique among active units per location** (partial unique index). The API returns HTTP 409 on conflict.
7. **`business_centre` units use `hourly_rate`, not `monthly_rate`** — `monthly_rate` is set to NULL for this type; the API enforces this silently.
8. **Electricity landlord split must sum to 100%** — Zod schema `.refine()` in the PUT route; returns 400 if violated.

### Settings (Hard Rules)

1. **Razorpay secret and webhook_secret values that begin with `••••` (masked) are never written back** — the API skips them silently. Sending a masked value will not wipe the real key.
2. **`crm_gst_enabled` and `tally_sync_enabled` are mutually exclusive in intent** — only one GST invoice source should be active. The Tally Sync page UI enforces this with three radio-style buttons. However, the DB does not enforce mutual exclusivity — the application logic must manage it.
3. **Dashboard widget config `key = 'dashboard_role_widgets'`** stores JSON. If the key is missing, the API falls back to `DASHBOARD_ROLE_WIDGETS` defaults from `src/lib/dashboard-config.ts`. New widgets added to code defaults are merged automatically on GET.

---

## Role Permissions

### Settings Page Tabs

| Tab | Roles Allowed |
|---|---|
| Profile | All roles |
| Payment Gateway | `admin` only |
| Spaces (link) | `admin` only |
| Documents (link) | `admin` only |
| Services | `admin`, `manager` |
| Procurement | `admin` only |
| Dashboard | `admin` only |
| Petty Cash | `admin` only |
| Reorder Levels | `admin`, `manager` |
| Budgets | `admin`, `manager` |
| E-Invoicing | `admin` only |

### Team Page

| Action | Who |
|---|---|
| View team list | `admin`, `manager`, `sales_rep` (sidebar), but full roster visible to all who access |
| Create user | `admin` only (enforced at API) |
| Edit role/status/name/phone | `admin` only (enforced at API) |
| Change password | `admin` only (enforced at API) |
| View activity log | `admin` sees all; button available on Team page |

### Locations

| Action | Who |
|---|---|
| View list | `admin`, `manager`, `fms`, `floor_manager` (sidebar) |
| Create location | `admin`, `manager` (API check) |
| Edit location | `admin`, `manager` (API check) |
| Delete (soft) location | `admin` only (API check) |
| Add/edit floors | `admin`, `manager` (API + RLS) |
| Add/edit space units | `admin`, `manager` (API + RLS) |
| View electricity config | Any authenticated |
| Edit electricity config | `admin`, `manager` (API check) |

### Admin Sub-Routes (COSEC / Tally)

| Route | Roles |
|---|---|
| `/admin/tally-sync` | `admin` only |
| `/admin/employees` | `admin`, `manager`, `office_admin`, `floor_manager`, `fms` |
| `/admin/cosec-devices` | `admin`, `manager`, `fms`, `it_manager`, `it_technician` |
| `/admin/cosec-access` | Same as above |
| `/admin/access-profiles` | Same as above |
| `/admin/access-analytics` | Same as above |
| `/admin/live-headcount` | `admin`, `manager`, `fms`, `floor_manager`, `office_admin` |

---

## Validation Rules

### User Creation (`POST /api/team`)

| Field | Rule | Where enforced |
|---|---|---|
| `email` | Required, non-empty | Server (API check) |
| `full_name` | Required, non-empty | Server (API check) |
| `password` | Required, ≥ 6 chars | Client + Server |
| `phone` | Required, non-empty (`.trim()` check) | Client + Server |
| `role` | Must be in `["admin", "manager", "sales_rep", "floor_manager", "accounts", "fms", "office_admin"]` | Server; defaults to `sales_rep` if invalid |

### User Update (`PATCH /api/team/[id]`)

| Field | Rule | Where enforced |
|---|---|---|
| `role` | Must be in the same 7-role allowlist | Server |
| `password` | ≥ 6 chars if provided | Client + Server |
| `email` | Lowercased and trimmed | Server |
| `phone` | `trim()` then stored as null if empty | Server |

### Location (`POST /api/locations`, `PUT /api/locations/[id]`)

| Field | Rule | Where enforced |
|---|---|---|
| `name` | Required | Server (400 if missing) |
| `code` | Required; uppercased; unique | Server + DB UNIQUE |
| `incharge_user_id_1` and `incharge_user_id_2` | Must be different users when both non-null | Server + DB CHECK `locations_incharges_distinct` |

### Floor (`POST /api/locations/[id]/floors`)

| Field | Rule | Where enforced |
|---|---|---|
| `name` | Required, non-empty after trim | Server |
| `grid_cols` | 10–30 | Server + DB CHECK |
| `grid_rows` | 8–20 | Server + DB CHECK |
| `leasable_area_sqft` | Must not exceed `total_area_sqft` when total > 0 | Server |

### Space Unit (`POST /api/locations/[id]/space-units`)

| Field | Rule | Where enforced |
|---|---|---|
| `name` | Required, non-empty after trim | Server |
| `code` | Required, non-empty, uppercased | Server + DB partial unique index |
| `type` | Must be one of 5 valid types | Server |
| Grid bounds | `col + col_span - 1 <= floor.grid_cols` etc. | Server (when `floor_id` provided) |

### Electricity Config (`PUT /api/locations/[id]/electricity-config`)

Validated via Zod schema:
- `enabled`: boolean
- `landlord_utility_pct + landlord_generator_pct` must equal exactly 100 (tolerance 0.01)
- `bill_due_day_of_month`: integer 1–28
- `landlord_gst_rate`: number or null
- `tds_section`, `tds_rate`: string/number or null

---

## State Machines / Lifecycles

### Location `is_active`
- Created as `true`
- Can be set to `false` via DELETE endpoint (admin only) — soft-delete
- There is no reactivation path in the UI, but it can be done via `PUT /api/locations/[id]` with `{ is_active: true }`

### User `is_active`
- Created as `true`
- Admin can toggle via `PATCH /api/users/[id]` or `PATCH /api/team/[id]`
- Inactive users keep their auth records; CRM middleware should block login (check `is_active` in session)

### GST Invoice Mode (3-state toggle on Tally Sync page)
- **CRM Active** (`crm_gst_enabled = 'true'`, `tally_sync_enabled = 'false'`): CRM mints invoice number and PDF
- **Standby** (`crm_gst_enabled = 'false'`, `tally_sync_enabled = 'false'`): No GST invoice issued; payments still recorded
- **Tally Sync** (`crm_gst_enabled = 'false'`, `tally_sync_enabled = 'true'`): Tally issues invoice after bridge posts
- Transitions via `PATCH /api/tally/control` with actions `set_crm_gst`, `resume`, `pause`

---

## Integration Points With Other Modules

- **Billing / PDF generation** reads `app_settings` keys `razorpay_enabled`, `razorpay_key_id`, `upi_id`, `upi_qr_code_path`, `crm_gst_enabled` via `GET /api/settings/public`
- **Razorpay webhook** (`src/app/api/payments/webhook/route.ts`) reads `razorpay_webhook_secret` and `razorpay_key_id`/`razorpay_key_secret` directly from `app_settings` using service client
- **Procurement approval** reads `procurement_approval_threshold` from `app_settings` via `/api/procurement/settings`
- **Dashboard** reads widget list for the current role from `GET /api/settings/dashboard?role=<role>`
- **Contracts** reference `location_id` pointing to the `locations` table
- **Space canvas** (`/spaces`) reads `space_units` and `location_floors` for the floor-plan editor
- **Headcount** uses `locations.requires_headcount` flag to determine which centres need daily counts
- **Cleaning alerts and headcount push notifications** use `incharge_user_id_1` / `incharge_user_id_2` to find the right recipients per location
- **WiFi vouchers** read `unifi_site_id`, `unifi_console_id`, `wifi_voucher_mode` from the location record to decide how to provision vouchers
- **Tally Sync** reads `tally_sync_enabled`, ledger settings, and locked company from `app_settings` via `GET /api/tally/control` (admin only)
- **E-invoicing** reads full IRP config from `app_settings` key `e_invoice_config` via `GET /api/e-invoice/settings`

---

## Known Pitfalls and Gotchas

1. **`POST /api/team` vs `PATCH /api/users/[id]`**: There are two partially overlapping role-update paths. The team route (`/api/team/[id]`) handles email + password + profile + role. The users route (`/api/users/[id]`) handles only role + is_active. The team route uses `createAdminClient` for the DB update to guarantee writes. Use `/api/team/[id]` for the full set of user edits from the Team page UI.

2. **Auth user vs DB user**: Creating a user via `supabase.auth.admin.createUser` triggers a DB trigger that inserts into `public.users`. If the trigger fires slowly, the API falls back to a manual insert. Always use `auth_id` (not `id`) to link the two tables.

3. **Role enum vs TypeScript type**: The DB `user_role` enum includes roles added in later migrations (`facility_staff`, `it_team`, `viewer`). The TypeScript `UserRole` type in `src/types/index.ts` includes `it_manager`, `it_technician`, `viewer` but NOT `facility_staff` or `it_team`. The `VALID_ROLES` array in `src/app/api/users/[id]/route.ts` does include `viewer`. The `POST /api/team` `validRoles` does NOT include `viewer`, `it_manager`, `it_technician`. Be careful when adding new roles — you must update the enum, the TypeScript type, and every validRoles array.

4. **`app_settings` RLS is permissive**: Any authenticated user can read/write `app_settings` directly via Supabase client. The admin check is purely at the API route level. If any component accidentally uses `createClient()` directly against `app_settings`, it bypasses the admin gate.

5. **Masked secrets must not be written back**: The `GET /api/settings` response masks `razorpay_key_secret` and `razorpay_webhook_secret` as `••••XXXX`. The `PATCH /api/settings` skips any value starting with `••••`. If you add new secret fields, add them to both `SECRET_KEYS` (GET masking) and the skip-condition (PATCH). Otherwise the mask will overwrite the real key with dots.

6. **`upi_qr_code_path` is excluded from the settings save** in `PaymentGatewaySettings`: the `handleSave` loop explicitly omits `upi_qr_code_path` (it's saved separately via the upload endpoint). Do not include it in the PATCH payload from this component or it will be treated as a normal text field.

7. **Location soft-delete does not cascade to contracts**: Deactivating a location does not touch contracts, proposals, or leads that reference it. Those records still show the location name (joined from the now-inactive location).

8. **In-charge slots are individual FKs, not a junction table**: You must use the PostgREST disambiguation aliases `incharge_1:users!locations_incharge_user_id_1_fkey(...)` and `incharge_2:users!locations_incharge_user_id_2_fkey(...)` in every query that needs to join in-charge user details. Using just `users(...)` will be ambiguous and PostgREST will error.

9. **`business_centre` type has no `monthly_rate`**: The API sets `monthly_rate = null` when `type === 'business_centre'`. The unit detail page shows `hourly_rate` for this type. Do not try to set `monthly_rate` for a business centre unit — it will be silently nulled.

10. **`USER_ROLES` constant in `constants.ts` has only 7 roles** (excludes `it_manager`, `it_technician`, `viewer`). This constant is used to validate role param in the dashboard settings route and to render tabs in `DashboardSettings`. Adding new roles to the system requires updating this constant.

11. **Dashboard widget config is stored as JSON blob** under a single `app_settings` row with key `dashboard_role_widgets`. The GET endpoint merges newly-added code defaults with saved DB values. If you add a new widget to `WIDGET_REGISTRY`, it will automatically appear for roles without a saved config once they next load the dashboard — no migration needed.

12. **Electricity config `landlord_utility_pct + landlord_generator_pct = 100` is only a Zod check**: There is no DB constraint. If data is inserted directly via SQL without going through the API, the invariant can be violated silently.

---

## Environment / Config Dependencies

| Key | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Env | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Env | Anon key for client-side Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | Server env | Used in `createAdminClient()` for admin operations |
| `razorpay_key_id` | `app_settings` DB | Public Razorpay key |
| `razorpay_key_secret` | `app_settings` DB | Secret Razorpay key |
| `razorpay_webhook_secret` | `app_settings` DB | HMAC verification for webhook |
| `razorpay_enabled` | `app_settings` DB | `'true'/'false'` feature flag |
| `upi_id` | `app_settings` DB | UPI merchant ID |
| `upi_qr_code_path` | `app_settings` DB | B2 storage path to QR image |
| `crm_gst_enabled` | `app_settings` DB | `'true'/'false'` toggle for CRM-issued GST invoices |
| `tally_sync_enabled` | `app_settings` DB | `'true'/'false'` toggle for Tally bridge |
| `procurement_approval_threshold` | `app_settings` DB | Default `'25000'` (₹) |
| `dashboard_role_widgets` | `app_settings` DB | JSON widget config per role |

---

## Key User Flows

### Create a New CRM User
1. Admin navigates to `/team`
2. Clicks "Add Team Member" → dialog opens
3. Fills: full name (required), email (required), phone (required), password (required, ≥6 chars), role
4. Submit calls `POST /api/team`
5. API creates auth user with `email_confirm: true` (no email verification needed)
6. DB trigger auto-inserts `public.users` row with default role; API then updates role + phone
7. On success, dialog switches to credential display view where admin copies login details
8. Audit event logged with `action: "create"` on entity type `"user"`

### Change a User's Role or Deactivate
1. Admin opens `/team`, clicks "..." menu on a team member
2. Opens edit dialog → changes role or toggles "Active" switch
3. Submit calls `PATCH /api/team/[id]` with `{ role, is_active }`
4. API uses `createAdminClient` to bypass RLS; computes diff; logs audit
5. Role badge and status badge update in the list

### Add a Location
1. Admin navigates to `/locations`
2. Clicks "Add Location"
3. `LocationFormDialog` opens: name (required), code (required, auto-uppercased), city, state, address, in-charge 1 and 2 (must be different), lat/lng, `requires_headcount` toggle
4. Submit calls `POST /api/locations`
5. API validates same-user constraint, calls DB insert
6. On 23505 (duplicate code) → returns HTTP 409 with friendly error

### Configure a Floor Plan
1. Admin opens `/locations/[id]` → "Spaces" tab
2. Clicks "Add Floor" → `FloorFormDialog`: name, floor_number, grid_cols (10–30), grid_rows (8–20), areas
3. Floor pill appears at top; admin selects it
4. Clicks "Add Unit" → `SpaceUnitFormDialog`: name, code, type, capacity, rates, grid position
5. Unit appears in the floor unit table with "Vacant" status until a contract allocates it

### Update Razorpay Configuration
1. Admin navigates to `/settings` → "Payment Gateway" tab
2. `PaymentGatewaySettings` loads current settings from `GET /api/settings` (secrets masked)
3. Admin enters new Key ID / Key Secret / Webhook Secret
4. Clicks "Test Connection" → saves first (PATCH), then calls `POST /api/settings/test-razorpay`
5. API fetches unmasked keys from DB, calls `GET /api/payments?count=1` on Razorpay
6. Success/failure displayed inline; audit event logged for each changed key

### Toggle GST Invoice Mode (Tally Sync Page)
1. Admin navigates to `/admin/tally-sync`
2. Three-way selector: "CRM GST", "Standby", "Tally Sync"
3. Click "CRM GST" → `PATCH /api/tally/control` with `{ action: "set_crm_gst", enabled: true }` → sets `crm_gst_enabled = 'true'` and disables tally sync
4. Click "Tally Sync" → `{ action: "resume" }` → sets `tally_sync_enabled = 'true'`; CRM GST mode is deactivated in the same call
5. UI shows company guard: if Tally has wrong company open, a red banner appears and invoices are blocked until the correct company is open or the lock is updated
