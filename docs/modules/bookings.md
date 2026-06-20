# Bookings

## Purpose and Business Context

The Bookings module manages meeting room and day-pass seat reservations at The WorkVilla coworking spaces. It handles:

- **Hourly bookings**: conference rooms, meeting rooms, cabins booked by the hour
- **Day-pass bookings**: hot-desk spaces where capacity is measured in seats (1 seat = 1 day-pass)
- Full lifecycle from booking creation → check-in → check-out, plus cancellation, no-show, recurring series, and waitlist
- Payment collection: cash, UPI, card, Razorpay link, or posted to monthly invoice (contract holders)
- Integration with WiFi vouchers (Unifi/voucher_repository), COSEC physical access control, Razorpay gateway, and MSG91/Resend for notifications

The module powers the "Operations" area of the CRM and is one of the highest-traffic sections — staff use it daily to manage who is in the building.

---

## Routes

| Route | File | Purpose |
|-------|------|---------|
| `/bookings` | `src/app/(dashboard)/bookings/page.tsx` | Dashboard view: today's bookings (upcoming, active, completed), future bookings, all-history section with full filters, calendar view, analytics tab |
| `/bookings/new` | `src/app/(dashboard)/bookings/new/page.tsx` | Multi-step booking creation form with context provider architecture |
| `/bookings/[id]` | `src/app/(dashboard)/bookings/[id]/page.tsx` | Booking detail page with all lifecycle actions |

### List Page Tabs
- **List View**: three grouped tables (Today Upcoming/Active, Today Completed, Future Bookings) plus collapsible "All Bookings" with pagination
- **Calendar View**: `CalendarView` component, clicking a slot deep-links to `/bookings/new?space_id=...&date=...&time=...`
- **Analytics Tab**: `UtilizationDashboard`, `RevenueReport`, `CustomerSegments` (lazy-loaded with `next/dynamic`, `ssr: false`)

---

## Key Source Files

### Pages
- `src/app/(dashboard)/bookings/page.tsx` — client component, all state inline
- `src/app/(dashboard)/bookings/new/page.tsx` — `NewBookingForm` wrapped in `<Suspense>` (needed for `useSearchParams`)
- `src/app/(dashboard)/bookings/[id]/page.tsx` — 2650-line client component, all dialogs dynamic-imported

### Context (New Booking)
- `src/components/bookings/new-booking/booking-form-context.tsx` — `BookingFormProvider` + `useBookingForm` hook; all state and computed values from the page flow down here
- `src/components/bookings/new-booking/index.ts` — re-exports all section components

### Section Components (New Booking)
All are `React.memo`'d and consume context via `useBookingForm`:
- `room-selection-section.tsx` — location, space picker, date, custom rate
- `time-selection-section.tsx` — start/end time dropdowns derived from availability slots
- `customer-details-section.tsx` — phone search, customer type, contract/lead/guest fields, ID proof upload
- `facilities-section.tsx` — add-on facility checkboxes from `space.facilities`
- `payment-section.tsx` — payment mode, reference, advance payment, recurring toggle
- `outstanding-charges-section.tsx` — pending usage charges to settle
- `booking-summary-section.tsx` — cost breakdown, submit button

### Dialog Components (Detail Page)
All dynamic-imported (`ssr: false`):
- `collect-payment-dialog.tsx` — at-counter payment
- `no-show-refund-dialog.tsx` — refund exception request
- `checkout-feedback-dialog.tsx` — staff rating of customer
- `reschedule-dialog.tsx` — change date/time
- `extend-booking-dialog.tsx` — extend end time for checked-in booking
- `defer-booking-dialog.tsx` — early checkout + credit carry-forward
- `share-payment-link-dialog.tsx` — multi-channel payment link delivery
- `cancel-booking-dialog.tsx` — rich cancel with reason, optional caution, optional refund request
- `mark-complimentary-dialog.tsx` — zero out total (admin/manager only)
- `get-payment-chooser.tsx` — chooser dialog: "At counter" vs "Send link"

### API Routes

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/bookings` | GET | List bookings with filters + pagination |
| `/api/bookings` | POST | Create booking |
| `/api/bookings/[id]` | GET | Fetch single booking with vouchers, feedbacks, actor names, quota info |
| `/api/bookings/[id]` | PATCH | Status transitions, reschedule, extend, notes update, pricing update |
| `/api/bookings/[id]/cancel` | POST | Rich cancellation with reason, optional caution + refund request |
| `/api/bookings/[id]/mark-complimentary` | PATCH | Zero the total, set waived (admin/manager only) |
| `/api/bookings/[id]/comp-request` | GET/POST | Floor manager comp approval flow |
| `/api/bookings/[id]/defer` | POST | Early checkout + booking credit issuance |
| `/api/bookings/[id]/email` | POST | Send confirmation, check-in alert, cleaning alert, feedback link |
| `/api/bookings/[id]/receipt` | GET | Receipt data for client-side PDF generation |
| `/api/bookings/[id]/vouchers` | POST | Issue WiFi vouchers on demand |
| `/api/bookings/[id]/addons` | GET/POST | Add-ons on a booking |
| `/api/bookings/[id]/addons/[addonId]` | PATCH/DELETE | Edit/remove a specific add-on |
| `/api/bookings/[id]/import-old-dues` | POST | Import outstanding usage charges as addons |
| `/api/bookings/[id]/convert-from-bill` | POST | Convert contract booking from monthly invoice to direct collection |
| `/api/bookings/[id]/rebook-data` | GET | Fetch prefill data for "Book Again" |
| `/api/bookings/[id]/waiver-request` | POST | Request overtime charge waiver |
| `/api/bookings/[id]/feedback` | POST | Submit staff feedback |
| `/api/bookings/[id]/clear-gst-invoice-required` | POST | Clear the `gst_invoice_required` flag |
| `/api/bookings/search-customer` | GET | Typeahead search for customers (leads + contracts) |
| `/api/bookings/customer-history` | GET | Booking history for a phone number |
| `/api/bookings/bulk` | POST | Bulk status actions |
| `/api/bookings/calendar` | GET | Calendar-view data |
| `/api/bookings/recurring` | GET/POST | Recurring series |
| `/api/bookings/recurring/[id]` | GET/PATCH/DELETE | Manage a recurring series |
| `/api/bookings/waitlist` | GET/POST | Waitlist management |
| `/api/bookings/waitlist/[id]` | PATCH/DELETE | Waitlist entry actions |
| `/api/bookings/detect-no-shows` | POST | Cron-triggered no-show detection |
| `/api/bookings/analytics/revenue` | GET | Revenue report data |
| `/api/bookings/analytics/utilization` | GET | Utilization dashboard data |
| `/api/bookings/analytics/segments` | GET | Customer segment analytics |
| `/api/booking-payments` | GET/POST | Payment records for bookings |
| `/api/booking-payments/[id]` | PATCH | Verify/reject a payment record |
| `/api/booking-payments/[id]/screenshot` | POST | Upload payment screenshot |
| `/api/booking-credits` | GET/POST | Booking credits (defer carry-forward) |
| `/api/booking-credits/[id]` | PATCH | Update/revoke a credit |

### Lib Files
- `src/lib/booking-cancel.ts` — `executeBookingCancellationSideEffects()`: shared logic for voucher revocation, usage charge waiver, waitlist auto-offer. Used by both PATCH cancel and POST /cancel
- `src/lib/provision-booking-access.ts` — `provisionBookingAccess()`: COSEC door PIN provisioning, called on every booking creation
- `src/lib/validations.ts` — `createBookingSchema` (Zod)

---

## Data Model

### `bookings` table (migration `00008_conference_room_bookings.sql`)

Key columns:

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `booking_number` | VARCHAR(50) UNIQUE | Auto-generated trigger: `TWV-B-NNNN` (zero-padded 4 digits, increments from current max) |
| `space_id` | UUID NOT NULL | FK → spaces |
| `location_id` | UUID NOT NULL | FK → locations |
| `booking_date` | DATE NOT NULL | |
| `start_time` | TIME NOT NULL | Stored as HH:MM:SS. Day-pass bookings: set from operating_hours |
| `end_time` | TIME NOT NULL | |
| `duration_hours` | DECIMAL(4,1) | For day-pass: always stored as `1` (legacy marker); display as "Day Pass (full day)" |
| `pricing_model` | ENUM (`hourly`, `daily`) | Added in migration 00117 |
| `unit_rate` | NUMERIC(12,2) | Per-unit rate snapshot (per-hour or per-day) |
| `quantity` | NUMERIC | Hours for hourly; number of seats for daily |
| `customer_type` | ENUM | `contract_holder`, `walk_in`, `guest` |
| `contract_id` | UUID | FK → contracts (ON DELETE SET NULL) |
| `lead_id` | UUID | FK → leads (ON DELETE SET NULL) |
| `booker_phone` | VARCHAR | Mandatory for all bookings |
| `guest_name`, `guest_email`, `guest_phone`, `guest_company` | VARCHAR | For walk-in/guest customer type |
| `hourly_rate` | DECIMAL(12,2) NOT NULL | Legacy column; for daily spaces, holds the day rate |
| `total_amount` | DECIMAL(12,2) NOT NULL | Ex-GST subtotal |
| `gst_rate` | INTEGER | Fixed at 18 |
| `gst_amount` | DECIMAL(12,2) | 18% of total_amount |
| `total_amount_with_gst` | DECIMAL(12,2) | total_amount + gst_amount + add-on total_with_gst |
| `payment_status` | ENUM | `pending`, `paid`, `waived`, `posted_to_bill`, `prepaid` |
| `payment_mode` | VARCHAR | `cash`, `upi`, `card`, `razorpay` |
| `payment_reference` | VARCHAR | Manual reference string |
| `status` | ENUM | `confirmed`, `checked_in`, `checked_out`, `cancelled`, `no_show` |
| `check_in_at`, `check_out_at` | TIMESTAMPTZ | |
| `checked_in_by`, `checked_out_by` | UUID | FK → users |
| `cancelled_by`, `cancelled_at` | UUID, TIMESTAMPTZ | |
| `cancellation_reason` | VARCHAR | Picklist value |
| `cancellation_details` | TEXT | Free text for "other" reason |
| `usage_charge_id` | UUID | FK → usage_charges (linked for contract/guest bookings) |
| `prepaid_purchase_id` | UUID | FK → prepaid_purchases |
| `prepaid_credits_used` | NUMERIC | Credits deducted |
| `prepaid_topup_amount` | NUMERIC | Cash top-up when prepaid ran short |
| `credit_redeemed_id` | UUID | FK → booking_credits |
| `series_id` | UUID | FK → recurring_booking_series |
| `rescheduled_from_id` | UUID | FK → bookings |
| `reschedule_count` | INTEGER | How many times rescheduled |
| `original_booking_date`, `original_start_time`, `original_end_time` | — | Snapshot of first schedule |
| `feedback_token` | UUID | For public `/feedback/[token]` URL |
| `payment_token` | UUID | For public `/pay/[token]` URL |
| `razorpay_payment_link_id`, `razorpay_payment_link_url` | VARCHAR | Razorpay link |
| `no_show_detected_at` | TIMESTAMPTZ | Cron-set |
| `complimentary_reason` | VARCHAR | Picklist: `manager_goodwill`, `aggregator_demo`, `staff_use`, `event_partnership`, `other` |
| `complimentary_details` | TEXT | Required when reason = `other` |
| `gst_invoice_required` | BOOLEAN | Set on cancellation/no-show when payment retained |
| `aggregator_booking_id` | VARCHAR | External booking reference |
| `num_attendees` | INTEGER | Drives WiFi voucher count (1 per 2 attendees) |
| `access_pin` | VARCHAR | COSEC door PIN |
| `notes` | TEXT | Staff-editable freetext |
| `billing_statement_id` | UUID | Set when billing statement finalised |

**RLS**: permissive — all authenticated users can SELECT, INSERT, UPDATE, DELETE.

### `booking_facilities` table

| Column | Type |
|--------|------|
| `id` | UUID PK |
| `booking_id` | UUID NOT NULL → bookings (CASCADE DELETE) |
| `facility_name` | VARCHAR NOT NULL |
| `is_complimentary` | BOOLEAN |
| `charge` | DECIMAL(12,2) |

### `booking_addons` table (migration `00117_daypass_pricing_addons.sql`)

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `booking_id` | UUID NOT NULL → bookings (CASCADE) | |
| `addon_catalog_id` | UUID → addon_catalog | Nullable: ad-hoc items have no catalog row |
| `addon_type` | ENUM | `extended_time`, `service`, `food_beverage`, `other` |
| `description` | VARCHAR(255) NOT NULL | |
| `unit_label` | VARCHAR(40) | e.g. "per page", "per cup" |
| `quantity` | NUMERIC(8,3) NOT NULL | |
| `unit_price` | NUMERIC(12,2) NOT NULL | Excluding GST |
| `amount` | NUMERIC(12,2) | `quantity × unit_price` |
| `gst_rate` | NUMERIC(5,2) | Default 18 |
| `gst_amount` | NUMERIC(12,2) | |
| `total_with_gst` | NUMERIC(12,2) | |
| `notes` | TEXT | |
| `added_by` | UUID → users | |

**Addon totals are included in `bookings.total_amount_with_gst`**. When the booking rate or schedule changes, `computeBookingTotalsWithAddons()` in `[id]/route.ts` re-fetches add-on totals and folds them in.

### `addon_catalog` table

Pre-seeded global items (location_id = NULL means available everywhere):
- Extended hour: ₹100/hr (18% GST)
- Tea: ₹20/cup, Coffee: ₹30/cup, Bottled water: ₹20, Snack box: ₹100 (5% GST)
- B&W print: ₹5/page, Colour print: ₹20/page, Photocopy: ₹5, Scan: ₹10, Locker: ₹50/day, Day-use printer: ₹150/day

### `booking_payments` table (migration `00011_payments_gateway.sql`)

Multi-payment records per booking.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `booking_id` | UUID NOT NULL → bookings | |
| `amount` | DECIMAL NOT NULL | |
| `payment_mode` | VARCHAR | `cash`, `upi`, `card`, `razorpay` |
| `payment_reference` | VARCHAR | |
| `screenshot_path` | VARCHAR | B2 path for UPI screenshot |
| `status` | VARCHAR | `pending`, `verified`, `rejected` |
| `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature` | VARCHAR | |
| `cash_handover_status` | VARCHAR | `pending_handover`, `handed_over` |
| `collected_by`, `collected_at` | UUID, TIMESTAMPTZ | |
| `handed_over_to`, `handed_over_at` | UUID, TIMESTAMPTZ | |

### `booking_credits` table (migration `00129_booking_credits.sql`)

Carry-forward credits issued from the "Defer" (early checkout) flow.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `phone` | VARCHAR NOT NULL | Anchored to customer's phone number |
| `location_id` | UUID NOT NULL | Credits are location-scoped — not transferable |
| `lead_id` | UUID | |
| `hours_total` | INTEGER NOT NULL | Whole hours only |
| `hours_used` | INTEGER NOT NULL DEFAULT 0 | |
| `hourly_rate_snapshot` | NUMERIC NOT NULL | Rate locked at time of issue |
| `issued_from_booking_id` | UUID | |
| `issued_at` | TIMESTAMPTZ | |
| `expires_at` | TIMESTAMPTZ NOT NULL | Default 30 days from issue |
| `status` | VARCHAR | `active`, `exhausted`, `expired`, `revoked` |
| `notes` | VARCHAR | |
| `issued_by`, `revoked_by`, `revoked_at` | UUID/TIMESTAMPTZ | |

**DB CHECK constraint**: `booking_credits_used_within_total` — `hours_used <= hours_total`

**Index**: `idx_booking_credits_phone_loc_active` — partial on (phone, location_id) WHERE status = 'active'

### `spaces` table (key columns for booking logic)

| Column | Notes |
|--------|-------|
| `pricing_model` | `hourly` or `daily` |
| `hourly_rate` | Used for hourly spaces |
| `daily_rate` | Used for day-pass spaces |
| `capacity` | Max concurrent bookings (day-pass spaces) |
| `operating_hours` | JSONB: `{ monday: { open: "09:00", close: "19:00", is_open: true }, ... }` |
| `max_advance_booking_days` | Default 30 |
| `min_booking_minutes` | Default 60 |
| `is_active` | Booking API rejects inactive spaces |

### `recurring_booking_series` table (migration `00013`)

| Column | Notes |
|--------|-------|
| `id` | UUID PK |
| `space_id`, `location_id` | |
| `customer_type` | |
| `contract_id`, `lead_id` | |
| `start_time`, `end_time` | Weekly recurring time |
| `day_of_week` | 0–6 |
| `start_date`, `end_date` | Series bounds |
| `is_active` | |
| `bookings` | Array join when fetched with `?` |

### `booking_waitlist` table

| Column | Notes |
|--------|-------|
| `space_id` | |
| `booking_date`, `start_time`, `end_time` | Requested slot |
| `customer_type`, `contract_id`, `lead_id` | |
| `booker_phone` | |
| `status` | `waiting`, `offered`, `booked`, `expired`, `cancelled` |
| `notified_at`, `expires_at` | Offer expires 2 hours after notification |

---

## Status Machines

### Booking Status (`bookings.status`)

Valid values: `confirmed` | `checked_in` | `checked_out` | `cancelled` | `no_show`

Valid transitions (server-enforced in `PATCH /api/bookings/[id]` and `POST /cancel`):

```
confirmed → checked_in   (via PATCH status=checked_in)
confirmed → cancelled    (via PATCH status=cancelled OR POST /cancel)
confirmed → no_show      (via PATCH status=no_show)
checked_in → checked_out (via PATCH status=checked_out)
checked_in → checked_out (via POST /defer — early checkout with credit)
```

**Invalid (server will 400/403)**:
- Cannot check in a non-confirmed booking
- Cannot check out a non-checked-in booking
- Cannot cancel a checked-in or checked-out booking
- Cannot no-show a non-confirmed booking

### Payment Status (`bookings.payment_status`)

Valid values: `pending` | `paid` | `waived` | `posted_to_bill` | `prepaid`

Set on booking creation:
- `walk_in`: `pending` (or `prepaid` if prepaid purchase applied, or `waived` if total = 0)
- `contract_holder` / `guest`: `posted_to_bill` (or `prepaid` if applicable)
- Zero-total bookings always become `waived` (required: `complimentary_reason`)

**Payment status transitions are managed by the payment recording workflow** — direct PATCH to `payment_status` is blocked server-side.

### Booking Payment Record Status (`booking_payments.status`)

`pending` → `verified` (after staff verification or Razorpay webhook)
`pending` → `rejected` (if rejected)

---

## Business Rules (Hard — Never Bypass)

1. **Walk-in check-in gate**: `PATCH status=checked_in` returns HTTP 402 if `sum(verified booking_payments.amount) < total_amount_with_gst`. Staff must collect full payment before check-in.

2. **Day-pass check-in hours**: Check-in for `pricing_model=daily` spaces must occur during the centre's operating hours for that day (server enforces via IST time comparison using `Intl.DateTimeFormat`).

3. **Duration must be multiples of 15 minutes** (server-enforced for hourly spaces).

4. **Minimum booking**: server checks `duration_minutes >= space.min_booking_minutes` (default 60 min).

5. **Advance booking limit**: server checks `booking_date - today <= space.max_advance_booking_days` (default 30).

6. **Operating hours boundary**: hourly booking start/end must be within the day's operating window.

7. **Zero-total requires complimentary reason**: server returns 400 if `total_amount_with_gst <= 0` and `complimentary_reason` is absent or not in the valid picklist.

8. **Complimentary reason "other" requires details**: both server (400) and client (toast error) enforce this.

9. **Conflict detection**: hourly — strict time overlap query. Day-pass — any existing booking on that date counts; conflict only if `existing_count >= space.capacity`.

10. **Pricing lock**: pricing (rate, total) cannot be changed once: booking is in terminal status (`cancelled`, `checked_out`, `no_show`), OR `payment_status = 'paid'`, OR any `booking_payments` row has `status = 'verified'`.

11. **Mark Complimentary blocked if payment collected**: `PATCH /mark-complimentary` returns 400 if any verified `booking_payments` exist.

12. **Comp request (floor manager) blocked if payment collected** or booking already waived/cancelled.

13. **No-show only by managers**: `PATCH status=no_show` requires role in `["admin", "manager", "floor_manager", "sales_rep", "accounts", "fms", "office_admin"]` — effectively all staff roles.

14. **Defer (early checkout credit) requires**: booking is `checked_in`, caller is `floor_manager/manager/admin`, `hours_to_carry` is a whole number ≥ 1, `hours_to_carry <= booked_duration`, booking has a phone number.

15. **Credit redemption**: credit must be `active`, not expired, same `location_id` as booking's space. `hours_to_redeem` must be a whole number ≥ 1, capped at `min(credit_remaining, floor(booking_duration_hours))`.

16. **ID proof mandatory** for `walk_in` and `guest` customers unless `leadHasIdProof` is true (checked against the lead record). Upload is done after booking creation to `POST /api/leads/[id]/id-proof`.

17. **Contract must be active** for `contract_holder` and `guest` customer types.

18. **GST always 18%** — computed at booking creation time, never recalculated dynamically post-booking.

---

## Pricing Logic

### Hourly spaces
```
room_cost = hourly_rate × duration_hours
facility_cost = sum(non-complimentary facility charges)
total_amount = room_cost + facility_cost - credit_discount
gst_amount = total_amount × 0.18
total_amount_with_gst = total_amount + gst_amount + sum(addon.total_with_gst)
```

### Day-pass (daily) spaces
```
room_cost = daily_rate × num_seats (default 1)
total_amount = room_cost  (no time-based duration math)
gst_amount = total_amount × 0.18
```

### Custom rate
The form allows overriding `hourly_rate` (called `customRate` in UI). Passed as `hourly_rate` in the POST body. Server accepts `input.hourly_rate` if `>= 0`.

### Prepaid credits
- `credit_type=hours`: deduct `min(durationHours, remaining)` credits; top-up amount = (duration - deducted) × rate
- `credit_type=days` or `credit_type=bookings`: deduct 1 credit per booking; topup = 0

Atomic redemption via `redeem_prepaid_credits` RPC (prevents double-spend).

### Booking credits (defer carry-forward)
- Discount = `hours_to_redeem × credit.hourly_rate_snapshot`
- Applied to ex-GST subtotal (GST collected only on cash portion)
- Atomic via `redeem_booking_credit` RPC

---

## Validation Rules

| Rule | Client | Server (API) | DB constraint |
|------|--------|--------------|---------------|
| `booker_phone` not empty | toast.error | Zod: `min(1)` | — |
| `space_id`, `booking_date` required | toast.error | Zod: `uuid` | NOT NULL |
| `start_time`/`end_time` required for hourly | toast.error | returns 400 if missing | NOT NULL |
| Minimum duration | toast.error | `duration_minutes >= min_booking_minutes` | — |
| Duration multiples of 15 min | — | `durationMinutes % 15 !== 0` → 400 | — |
| Operating hours boundary | — | startMin >= openMin AND endMin <= closeMin | — |
| Max advance booking | — | diffDays > max_advance_booking_days → 400 | — |
| Conflict check | `slotConflict` state (visual only) | DB query + 409 | — |
| Zero total requires comp reason | toast.error | `!reason \|\| !VALID_COMP_REASONS.has(reason)` → 400 | — |
| `other` reason requires details | toast.error | 400 if missing | — |
| Contract holder needs `contract_id` | toast.error | Zod refine | — |
| Walk-in needs `lead_id` or `guest_name` | toast.error | Zod refine | — |
| Guest needs `contract_id` | toast.error | Zod refine | — |
| ID proof mandatory for walk-in/guest | toast.error | — | — |
| GST number format | `/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/` | same regex | — |
| Walk-in check-in: payment required | HTTP 402 response | booking_payments sum check | — |
| Credit hours_used <= hours_total | — | — | DB CHECK `booking_credits_used_within_total` |
| Cancel only from `confirmed` | — | `booking.status !== 'confirmed'` → 400 | — |
| Cancel reason required | CancelBookingDialog | `!reason || !VALID_REASONS.has(reason)` → 400 | — |

---

## Customer Types and Their Behaviour

### `walk_in`
- Customer searched by phone or entered as guest
- `findOrCreateLeadForBooking()` auto-creates a lead if none found by phone
- `payment_status = 'pending'` at creation
- Payment gate enforced at check-in
- ID proof mandatory unless lead already has `id_proof_path` set

### `contract_holder`
- Requires a valid active `contract_id`
- Creates a `usage_charges` row (quota-aware: checks monthly hours used vs `contract_facilities.free_quota`)
- `payment_status = 'posted_to_bill'` at creation
- No payment gate at check-in (monthly invoice settles it)
- "Collect Now Anyway" button available to convert from bill to direct collection

### `guest`
- A visitor of a contract holder
- Requires `contract_id` (host contract)
- Also `findOrCreateLeadForBooking()` for the guest person
- Usage charge linked to the contract (same as contract_holder)
- `payment_status = 'posted_to_bill'` at creation
- ID proof mandatory

---

## Contract Quota Logic

For `contract_holder` and `guest` hourly bookings:
1. Server fetches `contract_facilities` with unit in `["hr", "hrs", "hour", "hours", "h"]`
2. Fetches existing bookings for the same contract in the same calendar month (status in `confirmed`, `checked_in`, `checked_out`)
3. Computes `hoursUsedSoFar`, `freeRemaining = max(0, freeQuota - hoursUsedSoFar)`, `overageHours = max(0, durationHours - freeRemaining)`
4. If `overageHours > 0`: creates a `pending` usage_charge for `overageHours × cost_per_unit`
5. If within quota: creates a `waived` usage_charge for `0` (for audit trail)
6. Day-pass bookings bypass quota logic entirely

The `ContractQuotaBanner` component on the new-booking page shows real-time quota status.

---

## Post-Booking Side Effects (Parallel)

After `INSERT INTO bookings`, the following run in `Promise.all`:
1. Insert `booking_facilities` rows
2. Patch `usage_charges.booking_id` (for finance traceability)
3. Atomic credit redemption: `supabase.rpc('redeem_booking_credit', ...)`
4. Atomic prepaid redemption: `supabase.rpc('redeem_prepaid_credits', ...)`
5. Advance payment insert (walk-in only, if provided)
6. Lead `activities` insert
7. Audit log

After the parallel batch:
- COSEC PIN provisioning: `provisionBookingAccess(booking.id)` (non-blocking, fire-and-forget)
- WhatsApp/SMS confirmation via MSG91 (fire-and-forget)

---

## Post-Checkout Side Effects

On `PATCH status=checked_out`:
1. Sets `status`, `check_out_at`, `checked_out_by`
2. Overtime detection (IST-aware using `Intl.DateTimeFormat` — critical: Vercel runs UTC)
3. Voucher revocation via `executeBookingCancellationSideEffects()` (with `skipWaitlistOffer: true`)
4. Returns `overtime` payload in response if `overtimeMinutes > 15 && !body.skip_overtime`
5. Client fires cleaning alert email/WhatsApp: `POST /api/bookings/[id]/email { type: "cleaning" }`
6. Client opens feedback dialog

**Day-pass overtime**: opens the addon dialog pre-filled with "Extended hour" catalog item (default ₹100/hr). Never multiply day rate by hours.
**Hourly overtime**: opens CollectPaymentDialog with the overtime charge pre-filled. Waiver request available.

---

## Cancellation Side Effects

`executeBookingCancellationSideEffects()` runs on cancel, no-show, and checkout:
1. Revoke `voucher_issuances` rows (set `is_active=false`, `revoked_at`, `revoke_reason`)
2. Revoke `voucher_repository` entries (set `status='revoked'`)
3. Call `revokeUnifiVoucher()` for live Unifi API vouchers (fire-and-forget)
4. Waive linked `usage_charges` (set `status='waived'`) — skipped on checkout
5. Auto-offer waitlist slot to first matching entry (skipped for no-show and checkout)

Rich cancel endpoint (`POST /api/bookings/[id]/cancel`) additionally:
- Sets `gst_invoice_required = true` when payment was retained (no refund)
- Creates `lead_cautions` row (auto-`danger` severity for `suspected_fake_booking` reason)
- Creates `refund_requests` row in `pending_approval` state

---

## Role Permissions

| Action | Allowed Roles |
|--------|--------------|
| Create booking | All authenticated roles |
| Check in | All authenticated roles |
| Check out | All authenticated roles |
| Cancel booking (own) | Any role (own bookings only) |
| Cancel booking (any) | `admin`, `manager` |
| Mark no-show | `admin`, `manager`, `floor_manager`, `sales_rep`, `accounts`, `fms`, `office_admin` |
| Mark complimentary | `admin`, `manager` |
| Request comp approval | `floor_manager` only |
| Approve comp request | `admin`, `manager` |
| Defer (issue credit) | `admin`, `manager`, `floor_manager` |
| Extend booking | All authenticated roles (server: same PATCH route) |
| Reschedule | `confirmed` bookings only; no role gate at server level |
| Waive outstanding charge | `admin`, `manager` |
| Convert from bill | Any role (button visible to all) |

---

## Integration Points

### Leads module
- Walk-in/guest bookings auto-create leads via `findOrCreateLeadForBooking()` (lookup by `phone` or `mobile`)
- Booking activity logged to `activities` table for the lead timeline
- GST number updates propagate to `leads.gst_number`
- `LeadCautionsBanner` component shown on new-booking form; `danger` severity cautions block submission until acknowledged
- Cancellation with `suspected_fake_booking` reason auto-creates a `danger` caution on the lead

### Contracts module
- Contract holder bookings linked via `contract_id`
- Monthly quota checked against `contract_facilities`
- Usage charges created and linked to billing statements
- "Convert from bill" flow removes charge from monthly statement

### Billing module
- `usage_charges` rows created for contract/guest bookings
- `booking_id` patched onto the charge post-insert
- `billing_statement_id` set on booking when included in a statement

### Prepaid Packages (`prepaid_purchases`)
- Auto-detected on new-booking form when `lead_id`/`guest_company` + `space_id` are set
- Checked via `POST /api/prepaid-purchases/check`
- Atomic redemption via `redeem_prepaid_credits` RPC

### WiFi Vouchers
- NOT auto-issued at booking creation (removed to save time + prevent waste)
- Issued on demand via `POST /api/bookings/[id]/vouchers`
- `num_attendees` drives count (1 voucher per 2 attendees)
- Revoked on cancel, no-show, and checkout

### COSEC (Physical Access Control)
- `provisionBookingAccess(booking.id)` called on every booking creation
- Provisions door PIN delivered via WhatsApp/SMS/email
- PIN shown on booking detail; "Resend PIN" button available
- Access logs visible on detail page (entries/exits)
- Cleanup cron: `GET /api/cron/cosec-booking-cleanup`

### Razorpay
- Payment links created via `POST /api/payments/create-payment-link { booking_id }`
- Webhook at `POST /api/payments/webhook` handles `payment.captured` — flips booking to `paid`
- Booking detail page polls every 10 seconds when a Razorpay link is active and payment is pending
- Config: `razorpay_enabled`, `razorpay_key_id`, `razorpay_key_secret` from `app_settings` table

### MSG91 / Resend
- Confirmation: WhatsApp + SMS on booking creation
- Check-in/checkout: WhatsApp notifications to customer
- Cleaning alert: on checkout to floor manager
- Feedback link email: auto-sent on checkout if customer has email

---

## New Booking Page Architecture

The new-booking form (`/bookings/new`) follows the controller pattern described in `CLAUDE.md`:

### State Management
All state lives in `NewBookingForm` (the page component). State flows down through `BookingFormProvider`. Section components never own state; they only read from context and call handlers.

### Key Search Params (prefill from URL)
| Param | Used for |
|-------|---------|
| `space_id` | Pre-selects space (from Calendar slot click or "Book Again") |
| `customer_type` | Pre-sets customer type |
| `lead_id` | Pre-selects lead |
| `booker_phone` | Pre-fills phone |
| `contract_id` | Pre-selects contract |
| `date`, `time` | Pre-fills booking date/start time |

### Customer Search
- Triggered after 3+ characters, 300ms debounce
- Endpoint: `GET /api/bookings/search-customer?q=...`
- Returns leads + contracts matching phone/name
- Selecting a "contract" type auto-sets `customerType = 'contract_holder'` and fills `contractId`/`leadId`
- Selecting a "lead" type auto-sets `customerType = 'walk_in'` and fills `leadId` + guest fields

### Computed Values (all `useMemo`)
- `durationHours`: `(endMin - startMin) / 60`
- `effectiveRate`: `customRate` if valid, else `space.hourly_rate` or `space.daily_rate`
- `roomCost`: `isDayPass ? effectiveRate * numSeats : durationHours * effectiveRate`
- `facilityCost`: sum of non-complimentary selected facilities
- `totalAmount`: `roomCost + facilityCost`
- `gstAmount`: `totalAmount * 0.18`
- `totalAmountWithGst`: `totalAmount + gstAmount`
- `timeOptions`: de-duped set from `availableSlots`
- `endTimeOptions`: `timeOptions` filtered to `>= startTime + minBookingMinutes`
- `availabilityWindows`: merged contiguous slots (for conflict detection)

### Availability
- Fetched from `GET /api/spaces/[id]/availability?date=YYYY-MM-DD`
- For day-pass: slots not fetched; capacity check done via `GET /api/bookings?space_id=...&date_from=...`
- `slotConflict` computed by checking if `startTime..endTime` is within any `availabilityWindows`

---

## Key User Flows

### New Walk-in Booking
1. Select location → space loads
2. Select date → availability loads
3. Select start time → end time options filtered by `minBookingMinutes`
4. Enter phone number (3+ chars to search) → select customer or enter guest details
5. Upload ID proof (mandatory unless lead already has it)
6. Optionally select facilities
7. Choose payment mode and reference
8. Optionally settle outstanding charges from past visits
9. Submit → API creates booking, auto-provisions COSEC PIN, fires WhatsApp/SMS

### Contract Holder Booking
1. Search by phone or name → select customer with "contract" result → `customerType='contract_holder'`, `contractId` pre-filled
2. Select room, date, time
3. `ContractQuotaBanner` shows remaining monthly hours
4. No payment collection needed — posts to monthly invoice
5. Check-in does NOT require payment gate

### Check In (Walk-in)
1. Click "Check In" on list or detail page
2. Server checks `sum(verified payments) >= total_amount_with_gst`
3. If underpaid → HTTP 402 → `CollectPaymentDialog` opens automatically
4. Once payment verified → check-in proceeds
5. WhatsApp/SMS sent to customer

### Check Out with Overtime
1. Click "Check Out"
2. Server computes `actualCheckoutMin (IST) - bookingEndMin`
3. If `> 15 min`:
   - Hourly: sets `_overtime` in response → client opens `CollectPaymentDialog` with overtime charge pre-filled
   - Day-pass: client opens `AddonsDialog` with "Extended hour" catalog item pre-filled

### Cancel Booking
1. Click "Cancel" → `CancelBookingDialog` opens
2. Select reason from picklist (`customer_requested`, `no_show`, `overbooking_error`, `suspected_fake_booking`, `centre_operational_issue`, `other`)
3. `other` requires details field
4. If payment was collected: option to request refund (creates `refund_requests` row)
5. POST `/api/bookings/[id]/cancel` with body
6. Side effects: voucher revocation, usage charge waiver, waitlist auto-offer, optional lead caution

### Defer (Early Checkout with Credit)
1. Customer leaving early; click "Defer" on checked-in booking detail
2. `DeferBookingDialog` opens; pre-fills `hours_to_carry = floor(remainingHours)`
3. Submit → `POST /api/bookings/[id]/defer`
4. Booking checked out immediately; `booking_credits` row created with 30-day expiry
5. Credit email sent to customer
6. On next booking: credit banner (`BookingCreditBanner`) auto-detects matching credit by phone + location

---

## Known Pitfalls and Gotchas

1. **Overtime IST calculation**: `booking.end_time` is stored as IST clock time. Vercel runs UTC. The PATCH checkout handler uses `Intl.DateTimeFormat` with `Asia/Kolkata` to get the current IST hour/minute. Using `new Date().getHours()` would be wrong by 5h30 — this was a real bug.

2. **Day-pass `duration_hours = 1`**: Always stored as `1` for legacy reasons. The UI shows "Day Pass (full day)" when `booking.pricing_model === 'daily'`. Never display `formatDuration(booking.duration_hours)` for day-pass bookings.

3. **`total_amount_with_gst` includes add-on totals**: When the booking rate changes (reschedule, extend, pricing edit), the `computeBookingTotalsWithAddons()` helper re-fetches `booking_addons.total_with_gst` and folds them in. Forgetting this causes the displayed grand total to drop add-on amounts.

4. **Payment status is read-only via PATCH**: Direct `PATCH { payment_status: "paid" }` is blocked server-side. Payment status transitions only happen through the payment recording workflow or specific endpoints (`/mark-complimentary`, `/convert-from-bill`, `/defer`).

5. **Walk-in check-in gate**: Returns HTTP 402 (not 400/403). The detail page handles 402 specially — opens `CollectPaymentDialog`. The list page does not have this special handling; 402 shows as a generic toast error.

6. **Booking number format**: `TWV-B-NNNN` (zero-padded to 4 digits). The trigger reads `MAX(CAST(SUBSTRING(...) AS INTEGER))` — race condition if two bookings insert simultaneously. Not atomic.

7. **ID proof upload is separate from booking creation**: The booking is created first, then the ID proof is uploaded to `POST /api/leads/[createdLeadId]/id-proof`. If the upload fails, the booking exists but the lead lacks an ID proof — the form shows a warning toast.

8. **Customer type `guest` vs `walk_in`**: Both can have guest fields. For `guest`, the booking's `lead_id` is set to the guest person (not the contract holder). The usage charge is still linked to the contract via `contract.lead_id`. This means `booking.lead_id` ≠ contract holder for guest bookings.

9. **Credit redemption caps at `floor(durationHours)`**: Prevents wasting credit hours on sub-hour bookings. A 1.5h booking can redeem at most 1h of credit.

10. **Complimentary reason "other" enforced on both client and server**: Empty `complimentary_details` when `reason='other'` is rejected at both layers. However, the client-side check uses the same `totalAmountWithGst <= 0` condition — if the rate is set to 0 at the API level but the form shows a non-zero total (stale state), the form won't show the comp reason field. Always ensure `totalAmountWithGst` in the context reflects the actual submitted amount.

11. **Day-pass availability uses count, not time overlap**: The conflict query for daily spaces counts all `confirmed`/`checked_in` bookings on that date. Conflict fires when `count >= space.capacity`. For a capacity-1 day-pass space, any existing booking blocks the date.

12. **Booking credits are location-scoped**: `location_id` mismatch → 400 "Credit is for a different centre — credits are not transferable across locations". Staff sometimes try to use credits across centres.

13. **GST invoice flag**: `gst_invoice_required = true` is set on cancellation/no-show when payment was retained. Finance needs to clear this manually via `POST /api/bookings/[id]/clear-gst-invoice-required` after issuing the invoice.

14. **`booking_number` used as URL segment in some places**: The detail page uses the UUID `id` param, but the `CustomerHistoryCard` and some links reference `booking.booking_number`. The `booking_number` lookup must go via the bookings table, not used as a primary key.

---

## Environment and Config Dependencies

| Key | Source | Notes |
|-----|--------|-------|
| `razorpay_enabled` | `app_settings` table | `"true"` string, checked via `GET /api/settings/public` |
| `razorpay_key_id`, `razorpay_key_secret` | `app_settings` table | Not env vars |
| `upi_id`, `upi_qr_code_path` | `app_settings` table | Shown in collect-payment dialog |
| `MSG91_AUTH_KEY`, `MSG91_WHATSAPP_SENDER` | env vars | For WhatsApp/SMS notifications |
| `RESEND_API_KEY` | env var | For transactional emails |
| `NEXT_PUBLIC_APP_URL` | env var | For feedback links and payment links in emails |
| COSEC integration | `app_settings` or location config | For access PIN provisioning |

The new-booking form fetches `GET /api/settings/public` on mount to check `razorpay_enabled` for showing the Razorpay payment option.

---

## Atomic RPCs (Supabase Functions)

These use `FOR UPDATE` locking to prevent race conditions:

| RPC | Purpose |
|-----|---------|
| `redeem_booking_credit(p_credit_id, p_hours_to_redeem)` | Atomically increments `hours_used`, sets status to `exhausted` if depleted |
| `redeem_prepaid_credits(p_purchase_id, p_booking_id, p_credits_to_deduct, p_redeemed_by)` | Atomically increments `credits_used`, updates status |
| `insert_booking_payment_atomic(...)` | Used by payment recording; prevents double-payment race |

Never do read-then-write for credit/prepaid balances outside these RPCs.
