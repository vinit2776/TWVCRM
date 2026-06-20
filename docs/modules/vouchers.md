# WiFi Vouchers

## Purpose and Business Context

The WiFi Vouchers module manages internet access provisioning for The WorkVilla's coworking space clients. It covers two distinct delivery modes:

1. **Repository mode** — pre-printed WiFi voucher codes uploaded from ISP-generated PDFs and assigned from a pool to contracts (one code per seat) or bookings (one code per N attendees).
2. **UniFi API mode** — real-time voucher generation via the Ubiquiti UniFi cloud API for locations with a UniFi controller. Vouchers have precision durations matching the exact contract or booking window; no batch import needed.

The module sits at the intersection of Operations (bookings, contracts) and IT (WiFi infrastructure). Key business functions:
- Ensure every active contract seat has a valid WiFi code for the duration of the contract.
- Issue temporary codes for day-use bookings.
- Revoke access automatically on contract termination or renewal handover.
- Provide an auditable trail of who got which code and when.

---

## Primary Route

`/vouchers` — "Voucher Repository" page under the Operations menu in the dashboard sidebar. This is a `"use client"` page (no server component wrapper).

---

## Source Files

### Page
- `src/app/(dashboard)/vouchers/page.tsx` — three-tab interface: Inventory, All Vouchers, Live (API). Switches to Live tab automatically when a UniFi-managed location is selected.

### Components
| File | Role |
|------|------|
| `src/components/vouchers/upload-vouchers-dialog.tsx` | PDF upload dialog; sends `multipart/form-data` to `POST /api/vouchers` |
| `src/components/vouchers/voucher-inventory-card.tsx` | Card per (location, validity_days) group with stock-level indicator |
| `src/components/vouchers/low-stock-alert.tsx` | Alert banner when any group is amber or red |
| `src/components/vouchers/reclassify-vouchers-dialog.tsx` | Bulk-assign `validity_days` to unclassified (`validity_days IS NULL`) available vouchers |
| `src/components/vouchers/voucher-issuance-dialog.tsx` | Side-panel detail view for a clicked issued/revoked voucher row |
| `src/components/vouchers/unifi-panel.tsx` | Live UniFi panel: stats bar, paginated voucher table, pending approval queue, ad-hoc issue dialog |
| `src/components/contracts/contract-vouchers-section.tsx` | Contract detail page embedded section; seat-by-seat issuance, per-seat email, replace action |
| `src/components/contracts/voucher-replace-dialog.tsx` | OTP-gated voucher replacement flow (3-step: confirm → OTP → success) |

### API Routes
| Route | Methods | Purpose |
|-------|---------|---------|
| `src/app/api/vouchers/route.ts` | GET, POST | List all vouchers (masked); upload via PDF or JSON |
| `src/app/api/vouchers/[id]/route.ts` | GET, PATCH, DELETE | Single voucher detail, update, delete (available only) |
| `src/app/api/vouchers/[id]/issuance/route.ts` | GET | Fetch voucher + all its issuances (history) |
| `src/app/api/vouchers/inventory/route.ts` | GET | Aggregated inventory grouped by (location, validity_days) with stock levels |
| `src/app/api/vouchers/reclassify/route.ts` | PATCH | Bulk-set `validity_days` on NULL-validity available vouchers |
| `src/app/api/contracts/[id]/vouchers/route.ts` | GET, POST | List/issue vouchers for a contract (repository or UniFi path) |
| `src/app/api/contracts/[id]/vouchers/[issuanceId]/route.ts` | PATCH | Update `seat_occupant_email` on an issuance |
| `src/app/api/contracts/[id]/vouchers/[issuanceId]/replace/route.ts` | POST | OTP-verified voucher replacement |
| `src/app/api/contracts/[id]/vouchers/email/route.ts` | POST | Email voucher(s) to seat occupants (3 modes) |
| `src/app/api/bookings/[id]/vouchers/route.ts` | POST | On-demand voucher issuance for a booking |
| `src/app/api/unifi/vouchers/route.ts` | GET | List live vouchers from UniFi device (paginated, masked) |
| `src/app/api/unifi/vouchers/adhoc/route.ts` | POST | Issue ad-hoc UniFi voucher; approval-gated for non-admin/manager |
| `src/app/api/unifi/vouchers/reveal/route.ts` | POST | Reveal full code for a UniFi voucher (audit-logged) |

### Lib Files
| File | Purpose |
|------|---------|
| `src/lib/voucher-pdf-parser.ts` | Parse ISP-generated PDFs; extract XXXXX-XXXXX codes; detect validity; decode PUA font chars |
| `src/lib/unifi.ts` | UniFi cloud API client: `createUnifiVoucher`, `revokeUnifiVoucher`, `getUnifiVoucher`, `getUnifiHotspotSsid`, `cachedUnifiRequest`, `isUnifiLocation`, `calcVoucherMinutes` |
| `src/lib/unifi-share.ts` | `buildShareableMessage`, `fmtDuration` — for WhatsApp-friendly WiFi code sharing |

### Constants (`src/lib/constants.ts`)
```
VOUCHER_STATUSES = ["available", "issued", "expired", "revoked"]
VOUCHER_STATUS_LABELS  — human labels
VOUCHER_STATUS_COLORS  — Tailwind classes
VOUCHER_VALIDITY_OPTIONS = [0.125, 1, 7, 30, 60, 90, 180, 365]  (days; 0.125 = 3 hours)
VOUCHER_VALIDITY_LABELS  — { 0.125: "3 Hours", 1: "1 Day", … }
VOUCHER_LOW_STOCK_THRESHOLD = 10
OTP_EXPIRY_MINUTES = 10
OTP_MAX_ATTEMPTS = 5
```

---

## Data Model

### `voucher_status` (PostgreSQL ENUM)
```sql
CREATE TYPE voucher_status AS ENUM ('available', 'issued', 'expired', 'revoked');
```

### Table: `voucher_repository`
Primary table for pre-uploaded voucher codes.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `voucher_code` | VARCHAR(255) UNIQUE NOT NULL | Conflict target for upsert; deduplication |
| `status` | `voucher_status` DEFAULT `'available'` | |
| `validity_days` | NUMERIC(10,4) | NULL = unclassified; 0.125 = 3 hours; widened from INTEGER in migration 00029 |
| `metadata` | JSONB DEFAULT `'{}'` | Parsed from PDF: `download_speed`, `upload_speed`, `data_limit` |
| `uploaded_by` | UUID → `users.id` ON DELETE SET NULL | |
| `uploaded_at` | TIMESTAMPTZ DEFAULT NOW() | |
| `issued_at` | TIMESTAMPTZ | Set when status → `issued` |
| `expires_at` | TIMESTAMPTZ | Set to `contract.end_date` or booking expiry on issue |
| `location_id` | UUID → `locations.id` | Added in migration 00006; NULL = legacy (no location) |

**Indexes:**
- `idx_voucher_repository_status` on `(status)`
- `idx_voucher_repository_code` on `(voucher_code)`
- `idx_voucher_validity_days` on `(validity_days)`
- `idx_voucher_status_validity` on `(status, validity_days, uploaded_at)`

**RLS:** Enabled. Policy: `authenticated` users can SELECT, INSERT, UPDATE (managed via API routes, not direct client access).

**Unique constraint:** `voucher_code` is unique — upsert with `ignoreDuplicates: true` is used on upload to skip existing codes silently.

### Table: `voucher_issuances`
Tracks which voucher was issued to which seat of which contract or booking.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `contract_id` | UUID → `contracts.id` ON DELETE RESTRICT | Can be NULL for booking-only issuances |
| `voucher_id` | UUID → `voucher_repository.id` ON DELETE RESTRICT | **Nullable** (migration 00212); NULL for UniFi API issuances |
| `booking_id` | UUID → `bookings.id` | Optional; set when issued from booking flow |
| `lead_id` | UUID → `leads.id` ON DELETE RESTRICT | |
| `seat_number` | INTEGER NOT NULL | 1-based; 1 to `contract.seats` |
| `issued_by` | UUID → `users.id` ON DELETE SET NULL | |
| `issued_at` | TIMESTAMPTZ DEFAULT NOW() | |
| `valid_from` | DATE NOT NULL | = `contract.start_date` |
| `valid_until` | DATE NOT NULL | = `contract.end_date` |
| `revoked_at` | TIMESTAMPTZ | |
| `revoke_reason` | TEXT | |
| `seat_occupant_email` | VARCHAR(255) | Per-seat email for individual delivery |
| `emailed_at` | TIMESTAMPTZ | Last time email was sent |
| `is_active` | BOOLEAN NOT NULL DEFAULT true | False = revoked or replaced |
| `replaces_issuance_id` | UUID → `voucher_issuances.id` ON DELETE SET NULL | Back-reference to replaced issuance |
| `unifi_voucher_id` | TEXT | UniFi internal `_id`; set when `wifi_voucher_mode = 'unifi_api'` |

**Unique constraint (partial):**
```sql
CREATE UNIQUE INDEX idx_voucher_issuances_active_seat
  ON voucher_issuances(contract_id, seat_number)
  WHERE is_active = true;
```
Only one active issuance per seat per contract. Multiple rows can exist for the same `(contract_id, seat_number)` if past ones have `is_active = false`.

**Original UNIQUE constraint removed:** `voucher_issuances_contract_id_seat_number_key` was dropped in migration 00005 to allow the replacement history pattern.

**Indexes:**
- `idx_voucher_issuances_contract_id`
- `idx_voucher_issuances_lead_id`
- `idx_voucher_issuances_active` — partial on `(contract_id, is_active) WHERE is_active = true`

### Table: `admin_otp`
Used exclusively for voucher replacement authorization.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `otp_code` | VARCHAR(6) | 6-digit code |
| `purpose` | VARCHAR(50) DEFAULT `'voucher_replacement'` | |
| `reference_id` | UUID NOT NULL | The `voucher_issuances.id` being replaced |
| `requested_by` | UUID → `users.id` ON DELETE CASCADE | |
| `verified_at` | TIMESTAMPTZ | |
| `expires_at` | TIMESTAMPTZ NOT NULL | `OTP_EXPIRY_MINUTES` (10 min) from creation |
| `is_used` | BOOLEAN DEFAULT false | |
| `attempts` | INTEGER DEFAULT 0 | Capped at `OTP_MAX_ATTEMPTS` (5) |

### Locations columns relevant to vouchers
| Column | Type | Notes |
|--------|------|-------|
| `unifi_site_id` | TEXT | UniFi site slug (e.g. `"default"`); NULL = repository mode |
| `unifi_console_id` | TEXT | UniFi cloud console UUID; falls back to `UNIFI_CONSOLE_ID` env var |
| `wifi_voucher_mode` | TEXT NOT NULL DEFAULT `'repository'` CHECK (`repository` or `unifi_api`) | Definitive flag for mode selection |

---

## Voucher Status Lifecycle

### Repository voucher (`voucher_repository.status`)

```
available
    │
    │  POST /api/contracts/[id]/vouchers  (or booking vouchers)
    ▼
  issued
    │
    ├──  Contract terminated / renewal activated
    │    → status = 'revoked'
    │    → voucher_issuances row: is_active = false, revoke_reason set
    │
    └──  OTP-verified replacement
         → old voucher: status = 'revoked'
         → new voucher: status = 'issued' (pulled from available pool)
         → old issuance: is_active = false, revoke_reason set
         → new issuance: is_active = true, replaces_issuance_id = old id
```

**`expired`** status is defined in the enum but is not set automatically by any code path — it is available for manual admin PATCH.

**Deletion:** Only vouchers with `status = 'available'` can be deleted via `DELETE /api/vouchers/[id]`.

### Issuance lifecycle (`voucher_issuances.is_active`)

```
is_active = true   (created on issuance)
    │
    ├──  Normal revocation (contract termination, renewal handover)
    │    is_active = false, revoked_at = now, revoke_reason = "Contract terminated"
    │    or revoke_reason = "Renewal activated"
    │
    └──  Replacement
         is_active = false, revoked_at = now, revoke_reason = user-entered text
         New issuance created with is_active = true, replaces_issuance_id = this.id
```

---

## Business Rules

### Hard rules (must never be bypassed)

1. **Contract must be `active` to issue vouchers** — server enforces: `if (contract.status !== "active") return 400`.
2. **Signed document required before issuance** — server enforces: `if (!contract.signed_document_id) return 400`.
3. **No duplicate active issuance per seat** — enforced by partial unique index `idx_voucher_issuances_active_seat`. Attempting to issue for an already-active seat returns 400.
4. **Voucher replacement requires OTP** — OTP is sent to all admin/manager users; must be verified within 10 minutes; max 5 attempts.
5. **Only admin can upload, PATCH, or DELETE vouchers in the repository** — server checks `currentUser.role !== "admin"` and returns 403.
6. **Only available vouchers can be deleted** — server enforces status check before DELETE.
7. **Contract mode and UniFi mode are mutually exclusive per location** — `isUnifiLocation()` checks `wifi_voucher_mode` first; falls back to presence of `unifi_site_id`.
8. **Ad-hoc UniFi vouchers require approval from non-admin/manager roles** — server creates `approval_requests` row with `entity_type = 'unifi_adhoc_voucher'`; issuance only happens on admin/manager approval.
9. **On contract termination, all active vouchers are automatically revoked** — handled in `PATCH /api/contracts/[id]` when `status → terminated`.
10. **On renewal activation, parent contract's vouchers are revoked** — new issuances attempted automatically; fallback to manual issuance if auto-issuance fails.

### Smart validity matching (repository path, contract issuance)

When issuing for a contract, the system does **not** simply pick any available voucher. It:
1. Computes `targetDays = tenure_months × 30`.
2. Applies a ±20% tolerance: `minAcceptable = floor(targetDays × 0.8)`, `maxAcceptable = ceil(targetDays × 1.2)`.
3. Finds validity groups within tolerance that have enough vouchers for all remaining seats.
4. Picks the group closest to `targetDays`; in case of tie, prefers the larger validity.
5. Returns a `match_warning` string if exact match not available (shown in UI as amber banner).
6. Returns 400 if no compatible group exists, with a descriptive error listing available groups.

This logic runs in both bulk-issuance mode and per-seat mode (`findAndIssueOneVoucher` helper).

### Booking voucher issuance (repository path)

- Short bookings (≤3 hours): preferred `validity_days = 0.125` (3-hour vouchers), fallback to `validity_days = 1`.
- Longer bookings: preferred `validity_days = 1`, no fallback.
- Count defaults to `ceil(num_attendees / 2)`, capped to a range of 1–20.
- Already-issued vouchers are additive — repeated calls issue MORE, not replacements.
- Expiry on repository voucher is set to: `now + validity_days_in_ms`.

### UniFi booking voucher duration

```
durationMinutes = ceil(duration_hours × 60) + 60  // 60-minute buffer
```

### UniFi contract voucher duration

```
durationMinutes = ceil((end_date - now) / 60_000) + 60  // calcVoucherMinutes()
```

Minimum 1 minute enforced.

---

## Validation Rules

### Server-side (API routes)

| Rule | Location | Exact check |
|------|----------|-------------|
| Auth required | All routes | `supabase.auth.getUser()` → 401 if null |
| Admin-only upload | `POST /api/vouchers` | `currentUser.role !== "admin"` → 403 |
| PDF only | `POST /api/vouchers` (PDF path) | `!file.name.toLowerCase().endsWith(".pdf")` → 400 |
| Non-empty vouchers array | `POST /api/vouchers` (JSON path) | `!Array.isArray(vouchers) \|\| vouchers.length === 0` → 400 |
| Contract must be active | `POST /api/contracts/[id]/vouchers` | `contract.status !== "active"` → 400 |
| Signed doc required | `POST /api/contracts/[id]/vouchers` | `!contract.signed_document_id` → 400 |
| Seat number in range | Per-seat mode | `seatNumber < 1 \|\| seatNumber > totalSeats` → 400 |
| Seat not already active | Per-seat mode | query `voucher_issuances` for existing active row → 400 |
| Reclassify: validity required | `PATCH /api/vouchers/reclassify` | `validity_days == null \|\| typeof validity_days !== "number"` → 400 |
| OTP required for replace | `POST /api/contracts/[id]/vouchers/[id]/replace` | `!otp_id \|\| !otp_code` → 400 |
| Revoke reason required | Same | `!revoke_reason` → 400 |
| OTP reference_id must match issuanceId | Same | `otpResult.reference_id !== issuanceId` → 400 |
| Booking must be confirmed/checked_in | `POST /api/bookings/[id]/vouchers` | `!["confirmed","checked_in"].includes(bk.status)` → 400 |
| Ad-hoc: reason required (non-admin) | `POST /api/unifi/vouchers/adhoc` | `!body.reason?.trim()` → 400 for non admin/manager |
| Ad-hoc: duration range | `POST /api/unifi/vouchers/adhoc` | Zod: `z.number().int().min(1).max(1_000_000)` |
| Ad-hoc: note non-empty | Same | Zod: `z.string().min(1).max(200)` |
| Ad-hoc: quota range | Same | Zod: `z.number().int().min(1).max(100)` |
| UniFi location required | `GET /api/unifi/vouchers`, adhoc | `!location?.unifi_site_id` → 400 |
| Replace: voucher must have validity | `POST …/replace` | `!validityDays` → 400 (can't determine replacement type) |

### Client-side

- Per-seat issuance in `ContractVouchersSection`: email must be non-empty before "Issue" button is enabled.
- Replace dialog: reason required before OTP request; OTP must be exactly 6 digits before submit.
- Upload dialog: only `.pdf` files accepted (file input `accept=".pdf"` + drop zone validation).
- Ad-hoc UniFi issue: duration must be ≥1 min; note must be non-empty; reason required for non-admin/manager (shown as amber warning banner).

### Database constraints

- `voucher_code` UNIQUE on `voucher_repository` — duplicate upload is silently ignored via `ignoreDuplicates: true` upsert.
- Partial unique index `idx_voucher_issuances_active_seat` — prevents double-issuance for same seat.
- `wifi_voucher_mode CHECK (wifi_voucher_mode IN ('repository', 'unifi_api'))` on `locations`.

---

## Role Permissions

| Action | Allowed Roles |
|--------|--------------|
| View `/vouchers` page (any tab) | All authenticated roles |
| View live UniFi panel | `admin`, `manager`, `sales_rep`, `floor_manager`, `office_admin`, `it_manager` |
| Upload vouchers (POST /api/vouchers) | `admin` only |
| PATCH single voucher | `admin` only |
| DELETE voucher | `admin` only |
| Reclassify vouchers | `admin` only |
| Issue vouchers for contract | Any authenticated user (via contract page) |
| Issue vouchers for booking | Any authenticated user |
| Send voucher email | Any authenticated user |
| Replace voucher (OTP flow) | Any authenticated user triggers OTP; OTP is sent to admins/managers |
| Issue ad-hoc UniFi voucher directly | `admin`, `manager` |
| Request ad-hoc UniFi voucher (approval-gated) | All other roles (any authenticated) |
| Approve/reject ad-hoc voucher requests | `admin`, `manager` |
| Reveal full UniFi voucher code | Any authenticated user (audit-logged) |

---

## Integration Points

### Contracts module
- Contract activation (`PATCH /api/contracts/[id]` with `status → active`):
  - UniFi locations: `createUnifiVoucher()` called automatically (non-fatal); `contracts.unifi_voucher_id` updated.
  - Repository locations: vouchers are **not** auto-issued on activation; staff must use `ContractVouchersSection`.
- Renewal activation:
  - Parent contract's active issuances: `is_active → false`, `revoke_reason = "Renewal activated"`, parent vouchers → `revoked`.
  - Parent contract's `unifi_voucher_id` revoked via `revokeUnifiVoucher()`.
  - IT team emailed with list of revoked codes.
  - Auto-issuance attempted for the new renewal contract (only if `signed_document_id` present).
- Contract termination (`status → terminated`):
  - `contracts.unifi_voucher_id` revoked via `revokeUnifiVoucher()`.
  - All active `voucher_issuances` rows: `is_active → false`, `revoked_at`, `revoke_reason = "Contract terminated"`.
  - Bulk-updates matching `voucher_repository` rows: `status = 'revoked'`.
  - Per-seat `unifi_voucher_id`s revoked individually (fire-and-forget).
  - Repository vouchers → `status = 'revoked'`.
  - IT/TechSupport emailed with seat-by-seat revocation list.
- `ContractVouchersSection` embedded in contract detail page shows seat grid with per-seat email, issuance, replace, and email-send actions.

### Bookings module
- `POST /api/bookings/[id]/vouchers` — staff-triggered from booking detail.
- Count = `ceil(num_attendees / 2)` by default; overridable in request body (1–20).
- `is_active` set on the first guest email (`booking.guest_email`) for the first seat if not already assigned.

### Approval Requests module
- UniFi ad-hoc requests use `approval_requests` table with `entity_type = 'unifi_adhoc_voucher'`.
- On approval: `createUnifiVoucher()` is called, code stored back in `approval_requests.metadata.issued_code`.
- `UnifiPanel` polls `/api/unifi/requests?status=pending` every 30 seconds to show the queue.
- `ApprovalBell` in the dashboard header also surfaces pending voucher requests.

### Email (Resend)
Three email modes for `POST /api/contracts/[id]/vouchers/email`:
1. **Per-seat individual** (body has `issuance_id`): sends to `seat_occupant_email` or supplied email. Updates `emailed_at` and `seat_occupant_email`.
2. **Bulk per-seat** (body has `per_seat: true`): sends individual emails to all active issuances with email addresses, in parallel. Batch-updates `emailed_at` for successful sends.
3. **Legacy bulk** (body has `recipients` array): sends all codes in one table email to the provided list. Optional `terms_and_conditions` text appended.

Subject lines:
- Per-seat: `"Your WiFi Access Code — The WorkVilla"`
- Legacy bulk: `"Internet Access Vouchers - Contract {contract_number}"`

### Audit trail
All create/update/delete actions call `logAudit()`. Reveal of a UniFi voucher code is logged with `action: "view"` and `entityType: "unifi_voucher"`.

---

## UniFi API Integration Details

### Environment variables
| Var | Purpose |
|-----|---------|
| `UNIFI_API_KEY` | Bearer key for the UniFi cloud API |
| `UNIFI_CONSOLE_ID` | Default console UUID (used if `locations.unifi_console_id` is null) |
| `UNIFI_SITE_NAME` | Default site slug, e.g. `"default"` |

### API base URL
```
https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/network/api/s/{siteName}
```

### Key operations
- `POST /cmd/hotspot` — create voucher (returns `create_time`)
- `GET /stat/voucher?create_time={ts}` — fetch newly created voucher by timestamp
- `DELETE /stat/voucher/{_id}` — revoke a voucher
- `GET /stat/voucher` — list all vouchers (can be ~19 MB; cached 60s via `unstable_cache`)
- `GET /list/wlanconf` — fetch SSID (used for shareable message)

### Caching
`cachedUnifiRequest` wraps `unifiRequest` with Next.js `unstable_cache`. TTL 60 seconds for the full voucher list. **Do not use for mutations** (create/delete).

### Code masking
- Repository codes: `maskVoucherCode()` in `src/lib/utils.ts` — format `"81346-46018"` → `"813**-****8"` (show first 3 of left half, last 1 of right half).
- UniFi codes in `GET /api/unifi/vouchers`: last 5 chars visible, rest replaced with `•`. Full code requires explicit `POST /api/unifi/vouchers/reveal`.

### `isUnifiLocation()` logic
```ts
if (location.wifi_voucher_mode) return location.wifi_voucher_mode === "unifi_api";
return Boolean(location.unifi_site_id);
```
`wifi_voucher_mode` is the authoritative check; `unifi_site_id` presence is the fallback for rows predating the column.

---

## PDF Parser Details (`src/lib/voucher-pdf-parser.ts`)

Uses `unpdf` (serverless-compatible PDF.js). Extraction strategies, in order:

1. **Primary pattern**: regex `/\b(\d{5}-\d{5})\b/g` for `XXXXX-XXXXX` format.
2. **Line-based fallback**:
   - 10-digit lines: split at position 5 → `XXXXX-XXXXX`.
   - 5–9 digit standalone lines: stored as-is.

**PUA font normalization** applied before parsing:
- `U+E088` → `"-"` (dash between halves)
- `U+E06B` → `"0"` (digit zero)

**Validity detection** (in priority order):
1. `"valid for X days"` or `"valid for Xd"` — integer days.
2. `"X day(s)"` — integer days.
3. `"valid for X hr/hrs/hour/hours"` or `"X hrs validity"` — converts to fractional days: `hrs / 24`.
4. Standalone `"Xhr"/"Xhrs"` — same conversion.

Metadata extracted: `download_speed`, `upload_speed`, `data_limit` from labelled lines.

A `validity_override` from the upload form overrides the detected value. When auto-detect yields null and no override is provided, `validity_days = null` (unclassified).

---

## Inventory Computation

`GET /api/vouchers/inventory` paginates through all vouchers in batches of 1000 (to avoid Supabase default limit). Groups by compound key `"{location_id}::{validity_days}"`. Each group tracks `available`, `issued`, and `total` counts.

Stock level thresholds:
- `red` — `available === 0`
- `amber` — `available < 10` (`VOUCHER_LOW_STOCK_THRESHOLD`)
- `green` — `available >= 10`

Sort order: location name ascending (NULL sinks to end), then validity ascending (NULL sinks to end).

Response includes:
- `data` — full group array
- `low_stock_alerts` — subset where `stock_level === "red"` or `"amber"`
- `unclassified` — first group with `validity_days === null` (or null if none)

---

## Key User Flows

### Flow 1: Upload repository vouchers
1. Admin opens `/vouchers` and clicks "Upload Vouchers".
2. Drag-and-drop or select a PDF.
3. Optionally select location and validity override.
4. Dialog `POST /api/vouchers` with `multipart/form-data`.
5. Server calls `parseVoucherPDF()`, upserts rows with `ignoreDuplicates: true`.
6. Dialog shows count, detected/applied validity, skipped duplicates, and any parse warnings.
7. Inventory tab refreshes.

### Flow 2: Issue vouchers for a contract (repository mode)
1. Staff opens contract detail page → Vouchers section.
2. Section runs `GET /api/vouchers/inventory` to check compatibility with `tenure_months`.
3. For each unissued seat row, staff enters `seat_occupant_email` and clicks "Issue", OR clicks "Issue All Remaining".
4. `POST /api/contracts/[id]/vouchers` with optional `{ seat_number, seat_occupant_email }`.
5. Server applies smart validity matching (±20% tolerance), picks FIFO from the `available` pool ordered by `uploaded_at ASC`.
6. Updates `voucher_repository.status → 'issued'`, `issued_at`, `expires_at`.
7. Inserts `voucher_issuances` row with `is_active = true`.
8. Section refreshes; shows `match_warning` if exact validity wasn't available.
9. Staff clicks Send (envelope icon) per seat to email the code.

### Flow 3: Replace a voucher (device change)
1. Staff clicks Replace (refresh icon) on an issued seat row in `ContractVouchersSection`.
2. `VoucherReplaceDialog` opens at step "confirm"; staff enters reason.
3. Click "Request OTP" → `POST /api/admin/otp` with `{ reference_id: issuanceId, purpose: "voucher_replacement" }`.
4. OTP is emailed to all admin/manager users. Dialog advances to OTP step.
5. Staff enters 6-digit OTP → `POST /api/contracts/[id]/vouchers/[issuanceId]/replace`.
6. Server verifies OTP, fetches replacement from pool matching same `validity_days` and `location_id`.
7. Old issuance: `is_active → false`, `revoked_at`, `revoke_reason`.
8. Old voucher repository row: `status → 'revoked'`.
9. New voucher repository row: `status → 'issued'`.
10. New issuance created with `replaces_issuance_id` back-reference.
11. Dialog shows old code (struck through) and new code.

### Flow 4: Issue ad-hoc UniFi voucher (non-admin)
1. Staff selects a UniFi location → Live tab activates.
2. Clicks "Issue Ad-hoc" → dialog shows approval warning.
3. Staff fills duration, note, devices, and a required reason.
4. `POST /api/unifi/vouchers/adhoc` → server creates `approval_requests` row.
5. Admin/manager sees request in "Pending Voucher Requests" collapsible in the UniFi panel (polled every 30s) and in the Approval Bell.
6. Admin clicks "Approve & Issue" → `PATCH /api/approval-requests/[id]` with `{ action: "approve" }`.
7. Server calls `createUnifiVoucher()`, stores code in `approval_requests.metadata`.
8. Panel shows issued voucher with shareable message; admin copies it to send to staff/guest.

### Flow 5: Contract termination revocation
1. Contract status set to `terminated` via PATCH.
2. Server (in the same request handler):
   a. Calls `revokeUnifiVoucher(contract.unifi_voucher_id)` if set (fire-and-forget).
   b. Fetches all `voucher_issuances WHERE contract_id = id AND is_active = true`.
   c. Bulk-updates: `is_active = false`, `revoked_at`, `revoke_reason = "Contract terminated"`.
   d. Bulk-updates matching `voucher_repository` rows: `status = 'revoked'`.
   e. Revokes per-seat `unifi_voucher_id`s individually (fire-and-forget).
   f. Emails `it@theworkvilla.com` and `techsupport@theworkvilla.com` with seat-by-seat revocation table.

---

## Known Pitfalls and Gotchas

1. **`validity_days` is NUMERIC(10,4) not INTEGER** — comparing with integer values works in PostgreSQL due to implicit cast, but TypeScript code must not assume integer type. Always use `parseFloat()` when reading from query params.

2. **`voucher_id` is nullable on `voucher_issuances`** — introduced in migration 00212 for UniFi API issuances. Never assume `voucher_id` is set. The join `voucher:voucher_repository!voucher_issuances_voucher_id_fkey(...)` will return `null` for UniFi-mode rows.

3. **UniFi voucher revocation is fire-and-forget** — `revokeUnifiVoucher()` swallows errors with a `console.warn`. It does not throw. If the UniFi device is offline, the voucher is NOT revoked and there is no retry. Check logs.

4. **Inventory endpoint paginates 1000 at a time from Supabase** — it loops until all rows are fetched. On large repos this could be slow. The endpoint does not respect Supabase's count-efficient `HEAD` request.

5. **The UNIQUE constraint on `voucher_code` is the deduplication gate** — the upsert `ignoreDuplicates: true` means the count returned (`data.length`) will be less than the input array length when duplicates exist. The `inserted_count` vs `skipped_duplicates` distinction is computed from this.

6. **Masked codes on the All Vouchers tab** — `available` vouchers have their codes masked server-side in `GET /api/vouchers`. This is intentional security. The detail panel via `GET /api/vouchers/[id]/issuance` returns the raw code for issued/revoked vouchers. There is NO reveal endpoint for repository vouchers — once issued, the code is visible.

7. **`valid_from` / `valid_until` on `voucher_issuances` are DATE not TIMESTAMPTZ** — they are copied from `contract.start_date`/`contract.end_date`. The email formatter uses `new Date(issuance.valid_from).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })` which is safe for dates but could shift by a day if the raw value is interpreted as midnight UTC.

8. **UniFi panel auto-activates when a UniFi location is selected** — the `useEffect` on `isUnifiLocation` switches `activeTab` to `"unifi_live"`. The Inventory and All Vouchers tabs are hidden entirely for UniFi locations.

9. **Upload button hidden for UniFi locations** — the Upload Vouchers button does not render when `isUnifiLocation` is true. Don't expect to batch-import into a UniFi location.

10. **Reclassify only affects `available` vouchers** — `PATCH /api/vouchers/reclassify` filters to `status = 'available' AND validity_days IS NULL`. Issued/revoked unclassified vouchers are not touched.

11. **Renewal auto-issuance requires `signed_document_id` on the renewal contract** — if the signed doc hasn't been uploaded yet when the renewal is activated, auto-issuance is skipped with a log message. Staff must issue manually after uploading.

12. **Contract-level `unifi_voucher_id` vs issuance-level `unifi_voucher_id`** — contracts have a single `unifi_voucher_id` column (set on activation, used for bulk revocation). Individual `voucher_issuances` rows also have `unifi_voucher_id` for per-seat UniFi codes. On termination, BOTH are revoked (contract-level first, then per-seat loop).

13. **OTP is tied to `reference_id = issuanceId`** — the server checks `otpResult.reference_id !== issuanceId` and rejects mismatches. An OTP generated for one seat cannot be used to replace a different seat's voucher.

14. **Booking voucher validity selection (repository path)** — short bookings (≤3 hours) prefer `validity_days = 0.125` with fallback to `1`. There is no smart tolerance-matching here (unlike the contract path); it's a simple exact equality check on `validity_days`. If no 3-hour or 1-day vouchers exist for the location, the route returns 422.

15. **Seat email in per-seat issuance is mandatory from the UI** — `ContractVouchersSection` requires `email.trim().length > 0` before enabling the Issue button per seat. The API does not require it server-side (it accepts `null`), but the UI will not allow issuance without an email.

---

## Environment and Config Dependencies

| Dependency | Type | Notes |
|------------|------|-------|
| `UNIFI_API_KEY` | Env var | Required for any UniFi API operation |
| `UNIFI_CONSOLE_ID` | Env var | Default console; overridden by `locations.unifi_console_id` |
| `UNIFI_SITE_NAME` | Env var | Default site slug; overridden by `locations.unifi_site_id` |
| `RESEND_API_KEY` | Env var | Required for voucher email delivery |
| `locations.wifi_voucher_mode` | DB column | `'repository'` or `'unifi_api'` per location |
| `locations.unifi_site_id` | DB column | Site slug; NULL = repository mode |
| `locations.unifi_console_id` | DB column | Console UUID; NULL = use env var |
| `VOUCHER_LOW_STOCK_THRESHOLD = 10` | Code constant | Amber stock level threshold |
| `OTP_EXPIRY_MINUTES = 10` | Code constant | OTP lifetime |
| `OTP_MAX_ATTEMPTS = 5` | Code constant | Max OTP verification attempts |
