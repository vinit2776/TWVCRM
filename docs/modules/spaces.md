# Spaces

## Purpose and Business Context

The Spaces module covers two related but distinct concepts in The WorkVilla's operations:

1. **Bookable Spaces (Meeting/Conference Rooms)** — discrete rooms that external customers and contract holders can book by the hour or by the day. These rooms have operating hours, facilities, pricing, and a schedule. They form the core of the `/spaces` and `/spaces/[id]` routes.

2. **Space Management (Floor Plan / Seat Occupancy)** — the coworking floor layout: floors, space units (hot desks, cabins, offices), and which units are allocated to which contracts. This is surfaced through the `/spaces/[id]` detail page's analytics tab and through the contract detail page's `ContractSpaceManager` component and `SeatOccupantsPanel`. The floor-canvas editor lives under the location admin pages, not under `/spaces`.

Together, these enable: scheduling meeting rooms, tracking seat occupancy against contracts, COSEC door-access integration, headcount, and space revenue analytics.

---

## Routes

### `/spaces`
**File:** `src/app/(dashboard)/spaces/page.tsx`

- Client component, uses `"use client"`.
- Lists all bookable spaces (meeting rooms / conference rooms).
- Paginated: 25 per page. Filters: location, active/inactive, name search.
- Clicking a row navigates to `/spaces/[id]`.
- "Add Space" and inline "Edit" buttons open `SpaceFormDialog`.
- Fetches from `GET /api/spaces`.
- Displays: name, location, capacity, hourly rate (or daily rate), up to 3 facilities, active badge.

### `/spaces/[id]`
**File:** `src/app/(dashboard)/spaces/[id]/page.tsx`

- Client component, uses `"use client"`.
- Five tabs: **Schedule**, **Details**, **Facilities**, **Charges**, **Access**.
- Header shows name, location, capacity, hourly rate, active badge, Edit button, Activate/Deactivate toggle, "New Booking" link (`/bookings/new?space_id=<id>`).
- **Schedule tab:** date picker renders a 30-minute-slot timeline for the selected day, built from `operating_hours`. Bookings for that date are fetched from `GET /api/bookings?space_id=&date_from=&date_to=&limit=50`. Cancelled bookings are filtered out client-side. Slot cells are colour-coded by booking status (`confirmed`, `checked_in`, `checked_out`, `no_show`). Booking cells show `booking_number` (linked), time range, customer name (from `lead` or `guest_name`), status badge, customer type badge.
- **Details tab:** Room info card + Operating Hours card. Shows capacity, hourly rate, `max_advance_booking_days`, `min_booking_minutes`, description, per-day open/close hours.
- **Facilities tab:** Table of `space_facilities` rows with name, pricing (complimentary or `charge_per_use`), availability.
- **Charges tab:** `SpaceChargesTab` component — the per-space add-on catalogue (`addon_catalog` where `space_id = this space`). See Charges section below.
- **Access tab:** `SpaceAccessTab` — shows linked COSEC device info and door access logs. Only shown when `space.cosec_device_id` is non-null.

---

## Key Source Files

| File | Role |
|------|------|
| `src/app/(dashboard)/spaces/page.tsx` | List page |
| `src/app/(dashboard)/spaces/[id]/page.tsx` | Detail page with tabs |
| `src/components/spaces/space-form-dialog.tsx` | Create/Edit space dialog |
| `src/components/spaces/space-charges-tab.tsx` | Per-space add-on catalogue management |
| `src/components/spaces/space-access-tab.tsx` | COSEC device info + door access logs |
| `src/components/spaces/floor-canvas.tsx` | SVG-like grid canvas for floor-plan editor |
| `src/components/spaces/floor-form-dialog.tsx` | Create/Edit floor dialog |
| `src/components/spaces/space-unit-form-dialog.tsx` | 2-step wizard to add/edit a space unit |
| `src/components/spaces/space-analytics.tsx` | Analytics panel: CUF, occupancy, revenue, idle units |
| `src/components/spaces/space-allocation-selector.tsx` | Unit picker used in contract/proposal forms |
| `src/components/spaces/seat-occupants-panel.tsx` | Per-contract seat occupant list with expand/collapse |
| `src/components/spaces/seat-occupant-form-dialog.tsx` | Add/edit a single seat occupant (2-step wizard) |
| `src/components/spaces/seat-transfer-dialog.tsx` | Transfer occupant to a different unit (2-step wizard) |
| `src/components/contracts/contract-space-manager.tsx` | Allocate/unlink space units to/from a contract |
| `src/app/api/spaces/route.ts` | `GET /api/spaces`, `POST /api/spaces` |
| `src/app/api/spaces/[id]/route.ts` | `GET`, `PATCH`, `DELETE /api/spaces/[id]` |
| `src/app/api/spaces/[id]/availability/route.ts` | `GET /api/spaces/[id]/availability?date=` |
| `src/app/api/spaces/[id]/facilities/route.ts` | `GET`, `POST`, `DELETE /api/spaces/[id]/facilities` |
| `src/app/api/spaces/[id]/addon-catalog/seed-defaults/route.ts` | `POST` — copy global templates to space |
| `src/app/api/locations/[id]/space-units/route.ts` | `GET`, `POST` space units for a location |
| `src/app/api/locations/[id]/space-units/[unitId]/route.ts` | `GET`, `PUT`, `DELETE` a space unit |
| `src/app/api/locations/[id]/space-analytics/route.ts` | `GET` — CUF, occupancy, revenue analytics |
| `src/lib/validations.ts` | `createSpaceSchema`, `updateSpaceSchema` (Zod) |

---

## Data Model

### Table: `spaces`

The original bookable-room table (migration `00008_conference_room_bookings.sql`, expanded in `00013`, `00034`, `00117`, `00193`).

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `name` | VARCHAR(255) NOT NULL | |
| `location_id` | UUID NOT NULL → `locations(id)` | |
| `capacity` | INTEGER NOT NULL DEFAULT 1 | Seat count |
| `hourly_rate` | DECIMAL(12,2) NOT NULL | 0 for daily-priced spaces |
| `pricing_model` | ENUM `'hourly' \| 'daily'` DEFAULT `'hourly'` | Added in migration 00117 |
| `daily_rate` | NUMERIC(12,2) nullable | Set only when `pricing_model = 'daily'` |
| `description` | TEXT nullable | |
| `workspace_type` | TEXT nullable | Added in 00034. UI values: `hot_desk`, `dedicated_desk`, `private_office`, `meeting_room`, `conference_room`, `virtual_office` (not a DB enum, just TEXT) |
| `operating_hours` | JSONB | Default: Mon–Fri 09:00–19:00, Sat 09:00–14:00, Sun closed. Structure: `{ "monday": { "open": "HH:MM", "close": "HH:MM", "is_open": boolean }, ... }` |
| `max_advance_booking_days` | INTEGER DEFAULT 30 | |
| `min_booking_minutes` | INTEGER DEFAULT 60 | 0 for daily-priced spaces |
| `cancellation_policy` | TEXT nullable | |
| `no_show_grace_minutes` | INTEGER DEFAULT 15 | Added in 00013 |
| `cosec_device_id` | UUID → `cosec_devices(id)` ON DELETE SET NULL | Added in 00193. Only linkable for `workspace_type IN ('conference_room', 'meeting_room')` |
| `is_active` | BOOLEAN DEFAULT true | |
| `created_by` | UUID → `users(id)` | |
| `created_at`, `updated_at` | TIMESTAMPTZ | `updated_at` managed by trigger |

**RLS:** `auth_read/insert/update/delete` policies require `auth.uid() IS NOT NULL` (any authenticated user). API routes add application-layer role checks.

**Indexes:** `idx_spaces_location` on `location_id`, `idx_spaces_active` on `is_active`.

### Table: `space_facilities`

Junction/child of `spaces`. One row per amenity per space.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `space_id` | UUID NOT NULL → `spaces(id)` ON DELETE CASCADE | |
| `name` | VARCHAR(255) NOT NULL | |
| `is_complimentary` | BOOLEAN DEFAULT true | |
| `charge_per_use` | DECIMAL(12,2) DEFAULT 0 | |
| `is_available` | BOOLEAN DEFAULT true | |
| `created_at` | TIMESTAMPTZ | |

**Constraint:** `UNIQUE(space_id, name)` — duplicate facility name on same space → DB error code `23505`.

**Default facilities** pre-filled on new space creation (from `DEFAULT_FACILITIES` in `constants.ts`): `Projector`, `Whiteboard`, `Video Conferencing`, `Stationery`, `Printer Access`, `Coffee/Tea`, `Water`, `WiFi`.

### Table: `addon_catalog`

Per-space (or global template) add-on items for booking extras. Originally location-scoped (00117); per-space `space_id` column added in 00124.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `space_id` | UUID → `spaces(id)` ON DELETE CASCADE nullable | NULL = global template row |
| `location_id` | UUID → `locations(id)` nullable | Legacy, unused by new per-space flow |
| `addon_type` | ENUM `booking_addon_type` | `extended_time`, `service`, `food_beverage`, `other` |
| `name` | VARCHAR(120) NOT NULL | |
| `description` | TEXT nullable | |
| `unit_price` | NUMERIC(12,2) NOT NULL DEFAULT 0 | Excluding GST |
| `unit_label` | VARCHAR(40) nullable | e.g. "per page", "per cup" |
| `gst_rate` | NUMERIC(5,2) NOT NULL DEFAULT 18 | |
| `is_active` | BOOLEAN NOT NULL DEFAULT true | Controls visibility in booking add-charge dialog |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | |
| `created_by` | UUID → `users(id)` | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**RLS:** SELECT: any authenticated user. Write: `admin` or `manager` only.

**11 global template rows** seeded in migration 00117 with `space_id IS NULL`: Extended hour, Tea, Coffee, Bottled water, Snack box, B&W print, Colour print, Photocopy, Scan, Locker, Day-use printer access.

**Seed-defaults endpoint:** `POST /api/spaces/[id]/addon-catalog/seed-defaults` copies all active templates to the space, skipping duplicates by name (case-insensitive). Admin/Manager only.

### Table: `location_floors`

Floors/levels within a location. Used by the floor-plan canvas (not the bookable-rooms tab).

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `location_id` | UUID NOT NULL → `locations(id)` ON DELETE CASCADE | |
| `name` | VARCHAR(255) NOT NULL | |
| `floor_number` | INTEGER nullable | Convention: -1=basement, 0=ground, 1,2... |
| `total_area_sqft` | NUMERIC(10,2) NOT NULL DEFAULT 0 | |
| `leasable_area_sqft` | NUMERIC(10,2) NOT NULL DEFAULT 0 | |
| `grid_cols` | INTEGER NOT NULL DEFAULT 20 | **CHECK: 10 ≤ grid_cols ≤ 30** |
| `grid_rows` | INTEGER NOT NULL DEFAULT 12 | **CHECK: 8 ≤ grid_rows ≤ 20** |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**RLS:** SELECT: any authenticated user. INSERT/UPDATE/DELETE: `admin` or `manager` only.

**Client-side validation in `FloorFormDialog`:** grid_cols 10–30, grid_rows 8–20, leasable_area ≤ total_area.

### Table: `space_units`

Individual leasable units on a floor (hot desks, cabins, offices). Linked to contracts via `contract_space_allocations`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `location_id` | UUID NOT NULL → `locations(id)` ON DELETE CASCADE | |
| `floor_id` | UUID → `location_floors(id)` ON DELETE SET NULL | Optional |
| `name` | VARCHAR(255) NOT NULL | Display name, e.g. "Cabin 03" |
| `code` | VARCHAR(20) NOT NULL | Short code, e.g. "C-03". Auto-uppercased on write |
| `type` | ENUM `space_unit_type` | `hot_desk`, `dedicated_desk`, `private_cabin`, `managed_office`, `business_centre` |
| `capacity` | INTEGER NOT NULL DEFAULT 1 | Seats |
| `area_sqft` | NUMERIC(10,2) nullable | Optional, for reporting |
| `monthly_rate` | NUMERIC(12,2) nullable | NULL for `business_centre` (hourly-only) |
| `daily_rate` | NUMERIC(12,2) nullable | Optional |
| `hourly_rate` | NUMERIC(10,2) nullable | Primary rate for `business_centre` |
| `amenities` | TEXT[] DEFAULT '{}' | From `AMENITIES_OPTIONS`: AC, Whiteboard, TV / Screen, Phone, Storage, Standing Desk, Natural Light, Soundproofing |
| `is_active` | BOOLEAN NOT NULL DEFAULT true | |
| `notes` | TEXT nullable | |
| `grid_col` | INTEGER NOT NULL DEFAULT 1 | 1-indexed column on the floor canvas |
| `grid_row` | INTEGER NOT NULL DEFAULT 1 | 1-indexed row |
| `grid_col_span` | INTEGER NOT NULL DEFAULT 2 | Width in grid cells |
| `grid_row_span` | INTEGER NOT NULL DEFAULT 2 | Height in grid cells |
| `color` | VARCHAR(20) nullable | Hex colour string; defaults to `COLOR_MAP[type]` if null |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**Unique constraint:** `idx_space_units_location_code_active` — UNIQUE on `(location_id, code)` WHERE `is_active = true`. A soft-deleted unit does NOT block its code from being reused.

**RLS:** SELECT: any authenticated user. INSERT/UPDATE/DELETE: `admin` or `manager` only.

**API enforces** grid boundary: `grid_col + grid_col_span - 1 ≤ floor.grid_cols` and `grid_row + grid_row_span - 1 ≤ floor.grid_rows`.

### Table: `contract_space_allocations`

Links a contract to one or more space units.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `contract_id` | UUID NOT NULL → `contracts(id)` ON DELETE CASCADE | |
| `space_unit_id` | UUID NOT NULL → `space_units(id)` ON DELETE CASCADE | |
| `allocated_at` | TIMESTAMPTZ DEFAULT NOW() | |
| `start_date` | DATE NOT NULL | |
| `end_date` | DATE nullable | |
| `status` | ENUM `space_allocation_status` DEFAULT `'active'` | `active` or `ended` |
| `notes` | TEXT nullable | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**Constraint:** `UNIQUE(contract_id, space_unit_id)` — one contract cannot allocate the same unit twice.

**RLS:** Any authenticated user can SELECT/INSERT/UPDATE/DELETE (permissive — contract access is enforced at application level).

### Table: `space_seat_occupants`

Tracks individual people (by name) sitting at specific units under a contract.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `space_unit_id` | UUID NOT NULL → `space_units(id)` ON DELETE CASCADE | |
| `contract_id` | UUID NOT NULL → `contracts(id)` ON DELETE CASCADE | |
| `location_id` | UUID NOT NULL → `locations(id)` ON DELETE CASCADE | |
| `seat_label` | TEXT nullable | e.g. "A1", "Desk 3" — sub-unit seat identifier |
| `occupant_name` | TEXT NOT NULL | |
| `occupant_email` | TEXT nullable | |
| `occupant_phone` | TEXT nullable | |
| `start_date` | DATE NOT NULL DEFAULT CURRENT_DATE | |
| `end_date` | DATE nullable | |
| `status` | TEXT NOT NULL DEFAULT `'active'` | CHECK: `active`, `ended`, `transferred` |
| `transferred_to_id` | UUID → `space_seat_occupants(id)` nullable | Points to the successor record when status = 'transferred' |
| `notes` | TEXT nullable | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**RLS:** Any authenticated user can SELECT/INSERT/UPDATE/DELETE.

---

## Status Lifecycles

### Bookable Space (`is_active`)

```
true (Active) ⟷ false (Inactive)
```

- Toggle via `PATCH /api/spaces/[id]` with `{ is_active: !current }`.
- `DELETE /api/spaces/[id]` also sets `is_active = false` (soft delete), but is blocked if any `confirmed` or `checked_in` bookings exist.

### Space Unit (`is_active`)

```
true (Active) → false (Inactive, soft delete via DELETE endpoint)
```

- Soft delete: `PUT /api/locations/[id]/space-units/[unitId]` with `{ is_active: false }` or via the `DELETE` endpoint. Code uniqueness constraint is `WHERE is_active = true` so deactivated codes can be reused.

### Contract Space Allocation (`status`)

```
active → ended
```

- Set to `ended` when the contract completes/terminates or when the unit is manually unlinked.

### Seat Occupant (`status`)

```
active → ended       (manual removal via DELETE endpoint)
active → transferred (system sets old record to 'transferred', creates new active record via transfer endpoint)
```

The `transferred_to_id` column creates an audit chain: old record points to the new occupant record.

---

## Business Rules

1. **Soft-delete only.** Both spaces and space units are never hard-deleted. The API `DELETE` endpoints set `is_active = false`.

2. **Cannot disable a space with active bookings.** `DELETE /api/spaces/[id]` checks for `status IN ('confirmed', 'checked_in')` and returns HTTP 400 if any exist.

3. **Daily-priced spaces.** When `pricing_model = 'daily'`: `hourly_rate` is stored as 0 (never used for calculation); `daily_rate` holds the flat per-booking charge; `min_booking_minutes` is stored as 0. The booking API fills `start_time`/`end_time` from the centre's `operating_hours` for that day.

4. **COSEC device linking.** Only `workspace_type IN ('conference_room', 'meeting_room')` can have a `cosec_device_id` linked. The form clears `cosec_device_id` when the type changes away from these values. Only `device_category = 'business_centre'` COSEC devices are shown in the selector (entry-point readers cannot be linked to rooms).

5. **Space unit code uniqueness.** Code must be unique among ACTIVE units at the same location. Deactivated units do not block code reuse.

6. **Facility name uniqueness.** `space_facilities` has a `UNIQUE(space_id, name)` constraint. Attempting to add a duplicate facility name returns `409 Conflict` (error code `23505`).

7. **Addon catalog templates vs space-specific rows.** Rows in `addon_catalog` where `space_id IS NULL` are global templates. Per-space items have `space_id` set. The booking add-charge dialog only shows items for the specific space being checked out. Do NOT rely on the old `location_id` column for the current flow.

8. **Grid bounds.** A space unit must fit within its floor's grid: `(grid_col + grid_col_span - 1) ≤ floor.grid_cols` and `(grid_row + grid_row_span - 1) ≤ floor.grid_rows`. API enforces this; canvas does too with `clamp()`.

9. **business_centre units are hourly-only.** `monthly_rate` should be NULL for `business_centre` type. These are excluded from monthly revenue totals in `SpaceAnalyticsPanel`.

10. **Allocation seat count vs contract commitment.** `ContractSpaceManager` computes `allocatedSeats = sum of space_unit.capacity` across active allocations. Shows a warning banner if `allocatedSeats < contractSeats`. This is a soft warning only — there is no hard block on contract activation based on space allocation.

---

## Validation Rules

### `createSpaceSchema` (Zod, validated server-side in `POST /api/spaces`)

| Field | Rule | Where enforced |
|-------|------|----------------|
| `name` | min(1) — required | Server-side Zod + client form |
| `location_id` | uuid format | Server-side Zod + client form |
| `capacity` | int, positive | Server-side Zod + client `min={1}` |
| `pricing_model` | `"hourly"` or `"daily"` | Server-side Zod |
| `hourly_rate` | `number.min(0)` — can be 0 for daily | Server-side Zod |
| `daily_rate` | `number.min(0)` nullable optional | Server-side Zod |
| `max_advance_booking_days` | int, positive, default 30 | Server-side Zod |
| `min_booking_minutes` | int, min(0), default 60 | Server-side Zod (0 valid for daily) |
| `operating_hours` | record of `{ open: HH:MM, close: HH:MM, is_open: boolean }` | Server-side Zod regex `/^\d{2}:\d{2}$/` |
| `cosec_device_id` | uuid nullable optional | Server-side Zod |

**Client-side only checks in `SpaceFormDialog`:**
- `capacity < 1` → toast error "Capacity must be positive"
- `pricingModel === 'hourly' && hourlyRate <= 0` → toast error "Hourly rate must be positive"
- `pricingModel === 'daily' && dailyRate <= 0` → toast error "Daily rate must be positive"
- Duplicate facility name → toast error "Facility already exists"

### `FloorFormDialog` client-side validation

- Grid columns: 10–30
- Grid rows: 8–20
- `leasable_area_sqft > total_area_sqft` when `total_area_sqft > 0` → blocked

### Space unit creation (server-side in `POST /api/locations/[id]/space-units`)

- `name` must be non-empty string
- `code` must be non-empty string (auto-uppercased)
- `type` must be one of `["hot_desk", "dedicated_desk", "private_cabin", "managed_office", "business_centre"]`
- Grid bounds checked against `location_floors` record
- `monthly_rate` = NULL when `type = 'business_centre'` (hourly-only; enforced by convention in the form, not a DB constraint)

---

## Role Permissions

### Bookable Spaces (`/spaces`, `/spaces/[id]`)

| Action | Allowed Roles |
|--------|--------------|
| Read (list/detail/schedule) | All authenticated users |
| Create space | `admin`, `manager`, `floor_manager`, `sales_rep`, `accounts`, `fms`, `office_admin` |
| Update space (PATCH) | `admin`, `manager`, `floor_manager`, `sales_rep`, `accounts`, `fms`, `office_admin` |
| Delete (soft) space | `admin` only |
| Manage facilities (POST/DELETE `/facilities`) | `admin`, `manager`, `floor_manager`, `sales_rep`, `accounts`, `fms`, `office_admin` |
| Manage addon catalog (seed-defaults, write) | `admin`, `manager` only |

### Space Management (Floor Plan)

| Action | Allowed Roles |
|--------|--------------|
| Read floors, units, analytics | All authenticated users |
| Create/update/delete floors | `admin`, `manager` |
| Create/update/delete space units | `admin`, `manager` |
| Manage space allocations | Any authenticated user (enforced at contract level) |
| Manage seat occupants | Any authenticated user |

---

## API Routes

### Bookable Spaces

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/spaces` | List spaces. Query: `page`, `limit`, `location_id`, `is_active`, `search`. Returns `{ data, pagination }` |
| POST | `/api/spaces` | Create space. Body: `createSpaceSchema`. Also inserts `space_facilities` rows. Logs audit. |
| GET | `/api/spaces/[id]` | Single space with location and facilities joined |
| PATCH | `/api/spaces/[id]` | Update space fields (partial). Facilities not updated via this endpoint — use `/facilities` separately. Logs audit. |
| DELETE | `/api/spaces/[id]` | Soft-disable. Blocked if active bookings exist. Admin only. |
| GET | `/api/spaces/[id]/availability?date=YYYY-MM-DD` | Returns `is_open`, `operating_hours`, `booked_slots` (confirmed/checked_in), `available_slots` (15-min increments). No auth beyond session. |
| GET | `/api/spaces/[id]/facilities` | List facilities ordered by name |
| POST | `/api/spaces/[id]/facilities` | Add facility. Body: `{ name, is_complimentary?, charge_per_use? }`. Returns 409 on duplicate. |
| DELETE | `/api/spaces/[id]/facilities?facility_id=` | Remove facility |
| POST | `/api/spaces/[id]/addon-catalog/seed-defaults` | Copy global template addon_catalog rows to this space. Idempotent (skips by name). Admin/Manager only. |

### Space Management

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/locations/[id]/space-units` | List units. Query: `floor_id`, `type`, `is_active`. Returns with `floor` and `active_allocations` joined. |
| POST | `/api/locations/[id]/space-units` | Create unit. Validates grid bounds against floor. Logs audit. |
| GET | `/api/locations/[id]/space-units/[unitId]` | Single unit with floor + allocations |
| PUT | `/api/locations/[id]/space-units/[unitId]` | Update unit fields (partial). Grid position updates supported (drag-drop). Code deduplication enforced. |
| DELETE | `/api/locations/[id]/space-units/[unitId]` | Soft-delete (sets `is_active = false`). |
| GET | `/api/locations/[id]/space-analytics` | Returns `SpaceAnalytics`: CUF per floor, occupancy by type, revenue table, idle units list. |
| GET | `/api/contracts/[id]/space-allocations` | List allocations for a contract |
| POST | `/api/contracts/[id]/space-allocations` | Allocate a unit to a contract |
| DELETE | `/api/contracts/[id]/space-allocations?allocation_id=` | Unlink unit from contract |
| GET | `/api/contracts/[id]/seat-occupants?status=active` | List seat occupants |
| POST | `/api/contracts/[id]/seat-occupants` | Add occupant |
| PUT/PATCH | `/api/contracts/[id]/seat-occupants/[occId]` | Edit occupant |
| DELETE | `/api/contracts/[id]/seat-occupants/[occId]` | End assignment (sets `status = 'ended'`) |
| POST | `/api/contracts/[id]/seat-occupants/[occId]/transfer` | Transfer to new unit. Body: `{ new_space_unit_id, transfer_date, seat_label?, notes? }`. Sets old record to `transferred`, creates new `active` record, links via `transferred_to_id`. |

---

## Integration Points

### With Bookings (`/bookings`)

- `Space.id` is FK on `bookings.space_id`.
- The schedule timeline on `/spaces/[id]` fetches bookings via `GET /api/bookings?space_id=&date_from=&date_to=`.
- "New Booking" button deep-links to `/bookings/new?space_id=<id>`.
- Availability API (`/api/spaces/[id]/availability`) excludes `confirmed` and `checked_in` bookings from free slots.
- `booking_addons` references `addon_catalog.id` (FK, nullable, ON DELETE SET NULL).

### With Contracts

- `ContractSpaceManager` (on contract detail page) allocates/unlinks space units.
- `SeatOccupantsPanel` (on contract detail page) manages named seat holders per unit.
- `SpaceAllocationSelector` component is used during contract creation to pick space units.
- `contract_space_allocations` links contracts to units.
- `space_seat_occupants` links individuals to units within a contract.

### With COSEC Access Control

- `spaces.cosec_device_id` → `cosec_devices.id`. Device must be `device_category = 'business_centre'`.
- `SpaceAccessTab` reads `cosec_devices` directly via Supabase client and queries `access_logs` for door events.
- Access logs are annotated as "Scheduled" or "No booking" by matching event timestamps against booking windows (±5 min of `start_time`/`end_time` in IST: `new Date(\`${booking_date}T${start_time}+05:30\`)`).
- When a booking is confirmed, an `access_pin` is written to `bookings.access_pin`.

### With Floor Plan Analytics

- `SpaceAnalyticsPanel` is rendered somewhere in the location admin pages (not the `/spaces` route), consuming `GET /api/locations/[id]/space-analytics`.
- CUF formula: `leasable_area_sqft / total_area_sqft` per floor.
- Occupancy: `contracted_capacity / total_capacity` per type (only units where `contract_space_allocations.status = 'active'` AND `contract.status IN ('active', 'renewed')`).
- Revenue: sums `monthly_rate` for contracted non-hourly units. `business_centre` is excluded (pay-per-use).

---

## Floor Canvas

**File:** `src/components/spaces/floor-canvas.tsx`

- Renders a CSS grid. Cell size: `CELL_SIZE = 44px`.
- Two modes: `"view"` (click-to-select unit) and `"edit"` (drag-to-reposition unit).
- Placement mode (triggered externally when a new unit is being placed): shows ghost block following cursor; click places the unit at that grid position.
- Collision detection on placement and drag-drop using `rectsOverlap()`.
- Escape key cancels placement mode.
- Drag calls `onUnitMove(unit, newCol, newRow)` on `mouseup`, which triggers `PUT /api/locations/[id]/space-units/[unitId]` with `{ grid_col, grid_row }` payload.
- Ghost block shown in red when placement position collides with an existing unit.

**Color constants (shared between `floor-canvas.tsx` and `space-unit-form-dialog.tsx`):**

| Type | Background | Border |
|------|-----------|--------|
| `hot_desk` | `#e0f2fe` | `#7dd3fc` |
| `dedicated_desk` | `#bfdbfe` | `#93c5fd` |
| `private_cabin` | `#ede9fe` | `#c4b5fd` |
| `managed_office` | `#fce7f3` | `#f9a8d4` |
| `business_centre` | `#fef3c7` | `#fcd34d` |

---

## Known Pitfalls and Gotchas

### Dual "spaces" concept — naming confusion
The module has two completely different meanings of "space": the bookable rooms table (`spaces`, `/spaces` route) and the leasable floor units (`space_units`). They are different DB tables, different UIs, and different concepts. A `Space` (meeting room) is booked by the hour/day. A `SpaceUnit` (hot desk, cabin) is allocated to a contract. Never conflate them.

### Day-pass pricing bug history (migration 00117)
Before migration 00117, day-pass spaces stored the day rate in `hourly_rate`. Bookings then multiplied it by `duration_hours`, producing wildly wrong totals (e.g., TWV-B-0030: ₹3186 instead of ₹354 because 9 hours × wrong rate). The fix added `pricing_model`, `daily_rate`, and the `unit_rate`/`quantity` columns. When `pricing_model = 'daily'`, `hourly_rate` is 0 — do not use it for price calculation. Check `pricing_model` first, then use `daily_rate`.

### Legacy `location_id` column on `addon_catalog`
The `addon_catalog` table has both `location_id` (old, unused) and `space_id` (new, per-space flow). The booking add-charge dialog queries by `space_id`. Do not write new code that relies on `location_id` for the addon catalog.

### `space_facilities` vs `addon_catalog`
These are separate tables with overlapping-sounding purposes:
- `space_facilities` = amenities/equipment list shown on the space's Facilities tab (projector, whiteboard, etc.). Displayed in booking confirmation. Items have `charge_per_use` but these are not automatically billed.
- `addon_catalog` = billable extras added at check-out (Tea, Coffee, Print pages, etc.). These map to `booking_addons` rows with GST calculations.

### Facilities tab vs Charges tab on `/spaces/[id]`
"Facilities" = the amenities list from `space_facilities`. "Charges" = the add-on catalogue from `addon_catalog WHERE space_id = ...`. Both tabs exist on the detail page and are easy to confuse.

### COSEC device selector filters by category
`loadCosecDevices` fetches `GET /api/cosec/devices?location_id=&category=business_centre`. Only `device_category = 'business_centre'` devices appear. Entry-point readers (`device_category = 'entry_point'`) cannot be linked to rooms.

### Space unit code uniqueness is partial (active-only)
The unique index is `WHERE is_active = true`. This means: if you soft-delete a unit with code `CB-01` and then create a new one with the same code, it will succeed. However, the application's API POST for space-units returns HTTP 409 on duplicate code regardless, so client code should handle 409.

### `min_booking_minutes = 0` for daily spaces
For daily-priced spaces, the form explicitly sets `min_booking_minutes = 0`. The availability API returns `min_booking_minutes` in its response. Booking creation must skip the minimum-duration check when `min_booking_minutes = 0`.

### Schedule timezone
The schedule tab resolves day-of-week using `new Date(scheduleDate + "T00:00:00")` (local timezone). This is consistent with how `operating_hours` is stored. The access log groups by IST date using `toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })`.

### Seat transfer vs delete
Removing a seat occupant sets `status = 'ended'`. Transferring sets `status = 'transferred'` and creates a new `active` record. The `transferred_to_id` FK links old to new. Do not delete seat occupant records; the transfer chain is needed for audit.

### ContractSpaceManager lock states
`isLocked = ["renewed", "completed", "terminated", "expired"]` — hides add/remove buttons.
`isEditable = ["draft", "sent", "viewed", "accepted", "active", "renewal_in_progress"]` — shows controls.
Space units CAN be changed while a contract is `active` (client is in the space).

---

## Environment / Config Dependencies

- No feature flags or `app_settings` keys specific to the Spaces module.
- COSEC device integration requires COSEC devices to be set up under Admin → COSEC Devices first.
- No environment variables specific to this module. COSEC device IPs/ports are stored in the `cosec_devices` DB table.

---

## Key User Flows

### Add a Bookable Space (Meeting Room)

1. Navigate to `/spaces`, click "Add Space".
2. `SpaceFormDialog` opens. Fill: name, location (required), capacity, pricing model, rate, workspace type, operating hours, booking policies, facilities list.
3. If workspace type is `conference_room` or `meeting_room` and location has `business_centre` COSEC devices, optionally link a device.
4. Submit → `POST /api/spaces` → inserts space row, then bulk-inserts `space_facilities` rows.
5. Dialog closes, list refreshes.

### Edit / Activate / Deactivate a Space

1. From list: click "Edit" → `SpaceFormDialog` opens in edit mode → PATCH.
2. From detail page: click "Edit" or "Activate"/"Deactivate" toggle → `PATCH /api/spaces/[id]` with `{ is_active: bool }`.

### Check Space Availability

1. `GET /api/spaces/[id]/availability?date=YYYY-MM-DD`.
2. Checks `operating_hours` for that day-of-week. Returns `is_open: false` if closed.
3. Fetches `confirmed`/`checked_in` bookings for that date, computes free 15-minute slots.
4. Response includes `booked_slots`, `available_slots`, `min_booking_minutes`.

### Set Up Floor Plan for a Location

1. Go to location admin page, add a floor via `FloorFormDialog` → `POST /api/locations/[id]/floors`.
2. Enter `SpaceUnitFormDialog` (2-step wizard): choose type → fill name/code/capacity/area → click "Add Unit" → `POST /api/locations/[id]/space-units` (unit lands at `grid_col=1, grid_row=1` by default).
3. In edit mode, drag units on `FloorCanvas` to position them → `PUT /api/locations/[id]/space-units/[unitId]` with `{ grid_col, grid_row }`.
4. Click a unit in view mode to open edit dialog.

### Allocate Space Units to a Contract

1. On contract detail page, `ContractSpaceManager` card shows current allocations.
2. Click "Add Unit" → fetches active units at the contract's location, filters out already-allocated ones, groups by floor.
3. Select one or more units (checkbox), click "Allocate" → sequential `POST /api/contracts/[id]/space-allocations` for each.
4. Seat count validation banner appears if allocated seats < contract committed seats.
5. To unlink: click the trash icon on an allocation row.

### Manage Seat Occupants

1. On contract detail page, `SeatOccupantsPanel` shows below the space allocations.
2. "Add Person" → `SeatOccupantFormDialog`: pick unit (if >1), fill name/email/phone/seat label/start date → `POST /api/contracts/[id]/seat-occupants`.
3. Edit occupant → pencil icon → edit dialog → `PATCH`.
4. Transfer → arrows icon → `SeatTransferDialog`: pick target unit → set transfer date/seat label/reason → `POST .../transfer`.
5. End assignment → user-X icon → confirm → `DELETE .../seat-occupants/[id]`.

### Configure Space Add-on Charges

1. On `/spaces/[id]`, Charges tab.
2. If empty: click "Use defaults" → `POST /api/spaces/[id]/addon-catalog/seed-defaults` (copies 11 template items).
3. Or click "Add charge" → inline form → `POST /api/addon-catalog` with `space_id`.
4. Edit existing item inline → `PUT /api/addon-catalog/[id]`.
5. Toggle active/hidden → `PUT /api/addon-catalog/[id]` with `{ is_active: bool }`.
6. Remove → `DELETE /api/addon-catalog/[id]`.

### View Space Schedule

1. On `/spaces/[id]`, Schedule tab.
2. Change date with date input.
3. Day-of-week resolved from `operating_hours`. If `is_open = false`, shows "Closed" card.
4. Time slots: 30-minute increments from `open` to `close`.
5. Slots with bookings are colour-coded; booking details shown only at the start slot.
6. Click `booking_number` link → navigates to `/bookings/[id]`.
