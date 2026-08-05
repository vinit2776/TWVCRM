# Changelog

All notable changes to TWV CRM are documented here.

## [1.0.98.253] - 2026-08-05

### Added
- **Recurring bill auto-approval**: admin can set up a recurring bill rule for a vendor (Vendors → [vendor] → Recurring Bills tab), seeded from an existing manually-approved bill. Future bills from that vendor skip the manual approval queue automatically when they clear four guardrails — variance tolerance (default ±10%), a hard rupee cap, a duplicate-invoice check, and a first-bill-after-rule confirmation. Auto-approved bills carry a distinct violet "Auto-approved" badge (separate from a human "Approved for Payment") plus a human-readable reasoning note, on both the Vendor Bills list and the bill detail page. Admin can pause/resume a rule at any time; a paused rule's next bill falls back to manual.
- Migration `00388_procurement_recurring_bill_rules.sql` — new `procurement_recurring_bill_rules` table; `vendor_bills` gains `auto_approved`, `recurring_rule_id`, `auto_approval_note`.

## [1.0.98.1] - 2026-06-26

### Changed
- **Employees page**: CRM users (app users) are now listed by default alongside manually-created employees. CRM users show a "CRM User" badge and an "Add to COSEC" button that pre-fills the create-employee dialog. COSEC enrollment actions (Enroll, Assign Card, Block, Restore) are hidden for CRM-only entries. De-duplication is by email so users with an existing employee record don't appear twice.

## [1.0.98.0] - 2026-06-26

### Added
- **Facility claim model — full UI**: ticket detail page now shows a claim countdown banner (amber/red), "Claim this ticket" button for any user on unowned tickets, "Take over" button when owned by someone else, and a ShieldAlert ownership notice for non-owners
- **Dispatch board (Unowned tab)**: issues list has a new "Unowned" chip with badge count; activating it fetches only new/reopened unassigned tickets sorted by claim SLA breach → priority → age
- **Asset AMC context card**: when an issue has a linked asset, the detail page sidebar shows make/model, warranty expiry, AMC status + end date, vendor helpline (clickable tel: link), contact name/email, escalation contact, scope notes, and last 3 issues on that asset
- **Auto-asset maintenance event on resolve**: resolving an issue with a linked asset automatically writes a `maintenance` event to `facility_asset_events` — no manual logging needed; shows up in the asset's event history

### Changed
- Issues list "Unowned" filter uses `assigned_to=unassigned` + status `new/reopened`; grouped view is disabled in unowned mode to preserve the sort order
- `GET /api/facility/issues` now accepts `asset_id` query param for filtering issues by asset

## [1.0.97.0] - 2026-06-26

### Added
- **Tally Inbox — booking payment confirmation**: every booking GST task row now shows a green "Paid · Mode · Ref" pill inline; a "Payment ▼" toggle in the actions bar expands a full confirmation table (Amount, Mode, Reference/ID, Date) at any handoff state without opening the upload drawer
- **Facility claim model**: migration 00305 adds claim tracking; assign and status routes tightened with role checks and claim handling; SLA cron skips already-claimed issues

### Changed
- Tally inbox booking rows fall back to `bookings.payment_mode` + `payment_reference` when no `booking_payments` confirmation row exists
- Assignee scoping and notification improvements in facility module

## [1.0.96.0] - 2026-06-26

### Added
- **Inventory analytics tab**: per-location stock snapshot with holding value, consumption trend, predicted stockouts, dead-stock, and top items by value/consumption
- **Stock aging**: tracks how long each item has been held; per-department thresholds flag items as "old" (e.g. Food items > 7d, Cleaning > 90d); surfaced in both the Inventory list and the new analytics tab
- **Incoming transfers panel**: Inventory page now shows live "upcoming inwards" — transfers heading to the current location that haven't arrived yet, so floor managers can anticipate stock before it lands
- **Searchable item picker on New Transfer**: freetext search across all procurement items with department grouping; replaces the flat dropdown
- **Consumption lifecycle timeline**: each consumption log shows a step-by-step history (logged → adjusted / voided → relogged) with corrector name and reason
- **Transfer lifecycle stepper**: stock transfer detail page shows the full approval → dispatch → receive pipeline with timestamps
- **Tally Handoff v2**: accounts can upload a Tally GST invoice PDF; the system extracts the IRN, applies series rules (series A/B/C), and links the Tally record directly; booking GST tasks now surface in the handoff panel with their own audit trail

### Changed
- **Sidebar access**: `floor_manager` and `fms` roles can now see the Inventory, Transfers, and Consumption menus (they were previously hidden even though these users are the primary loggers)
- **Admin > Location Access Assignments**: renamed from "User-Location Assignments"; labels clarified — "Location In-Charges" in location settings controls alert routing (cleaning, headcount, check-in notifications); "Location Access Assignments" controls inventory/consumption/transfer scoping
- Location edit dialog now shows a cross-check warning if an In-Charge user has no Location Access Assignment for that location (they can't log stock there without one)
- Primary locations sort reliably first in all pickers (fixed one-argument sort comparator that produced non-deterministic order)
- Analytics date range capped at 365 days to prevent unbounded DB scans

### Fixed
- Secondary floor managers (e.g. `floor_manager` role) could not see Consumption / Inventory / Transfers menus at all — the nav role lists were missing these roles
- `GET /api/procurement/inventory` and `GET /api/procurement/transfers` had no server-side location-scope check; a scoped floor_manager could query any other branch's stock or transfers by crafting the URL manually
- Transfers route: `incoming_to` query param was passed to the DB without UUID validation
- Consumption log void: correction audit-trail insert failure was silently swallowed; now returns a `{ warning }` field so the caller knows the audit trail needs a follow-up
- Inventory analytics route: `getLastReceivedMap` was awaited sequentially after an already-parallel block; now runs in the same `Promise.all`
- Consumption POST: stock-level check was an N+1 loop; now a single batched query; stock deduction RPCs now run in parallel

### Removed
- Dead `locations` fallback path (`locData.locations`) removed from consumption history page (the endpoint has always returned `{ data }`)
