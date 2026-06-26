# Changelog

All notable changes to TWV CRM are documented here.

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
