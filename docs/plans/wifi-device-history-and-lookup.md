# Wi-Fi device history and "who was connected at time T"

Status: plan only, nothing built. Mock: `mock-wifi-device-history.html` (repo root, untracked).
Parent design: `docs/customer-value-tab-spec.md` section 5.7.

## Why

A request such as "this person sent an email at 16:20 from public IP X, link them to it" cannot be answered today:

- Usage is stored per MAC only (`wifi_client_hourly` / `wifi_client_daily`, migrations 00625 and 00627). Which person a MAC belongs to is worked out when someone opens the Value tab, from the console's live guest list, so it is lost once the console forgets the guest or a seat is reassigned.
- No session record (start, end, private IP, access point) is kept.
- The center's public IP is not read anywhere in the code, so we cannot confirm an IP was ours at that time.

## Decisions already made

- Retention 12 months for everything below.
- Destination (DNS) logs are in scope, as the last phase.
- No fixed police format. Goal: enough visibility to investigate. Main case: who was connected at time T from public IP X.
- Roles allowed to use it: `admin`, `it_manager`, `it_technician`. An admin needs no separate authoriser (recorded as self-authorised). IT roles must name an admin as authoriser, and cannot authorise themselves.
- Every lookup and every export is audited.

## Data model (migrations, numbers picked at build time)

Used 00744 (origin/main ends at 00741; 00742 and 00743 are taken by unmerged branches). Run `node .github/scripts/check-migration-numbers.mjs` and re-check just before merging.

1. `wifi_device_assignments` (append-only): `id`, `location_id`, `mac`, `contract_id` null, `contract_member_id` null, `seat_number` null, `voucher_issuance_id` null, `source` (voucher_guest | adhoc_voucher | manual_label), `valid_from`, `valid_to` null, `created_at`. A MAC has at most one open row (partial unique index on `(location_id, mac) WHERE valid_to IS NULL`). Reassigning closes the open row and inserts a new one in one RPC. No UPDATE or DELETE except setting `valid_to` through that RPC.
2. `wifi_session_log` (append-only): `location_id`, `mac`, `ip`, `assoc_time`, `disassoc_time` null, `ap_mac`, `essid`, `rx_bytes`, `tx_bytes`, `hostname`, `is_guest`, `captured_at`. Unique on `(location_id, mac, assoc_time)` so a re-capture upserts. Open sessions are re-captured until they close.
3. `center_public_ip_history`: `location_id`, `ip`, `first_seen`, `last_seen`. The capture extends `last_seen` while the IP is unchanged and opens a new row when it changes.
4. `wifi_investigation_log` (immutable): `id`, `user_id`, `role`, `kind` (lookup | export_csv | export_cover), `query` (jsonb: public IP, time, window), `case_ref`, `authorised_by`, `row_counts`, `content_hash`, `created_at`. A `BEFORE UPDATE OR DELETE` trigger raises, so the app cannot edit it.

RLS on all four: enabled; SELECT only for users whose role is one of the three; writes by service role only. A MAC identifies a device and sessions identify a person, so none of these are readable by every authenticated user.

## Capture (extends the existing hourly cron)

Extend `captureLocationWifi` in `src/lib/wifi-ledger-capture.ts`, keeping the existing order so the usage rows are safe if a later call fails:

- `/stat/session` since the last stored `assoc_time` (minus a small overlap) into `wifi_session_log`.
- `/stat/guest` into `wifi_device_assignments`, resolved with the existing `resolveDevices` logic in `src/lib/customer-value/wifi-devices.ts` (seat vouchers, ad-hoc vouchers, manual labels). Only confirmed matches create assignments; suggested ones never do.
- The WAN address from the console's health data into `center_public_ip_history`.
- Read-only against UniFi; sends nothing. Same `withCronHealth` pattern. A daily purge deletes rows older than 12 months and has its own `cron_health` row.

## API and screens

- `POST /api/network/connected-at` (body: public IP, time, window). Checks the role, checks the IP against `center_public_ip_history`, returns devices and people connected in the window, with the three outcomes in the mock (IP matches, IP not ours at that time, IP matches but no session records). Writes a `lookup` row to `wifi_investigation_log` before returning.
- `POST /api/network/connected-at/export` (CSV of every dataset in scope; cover-sheet PDF). Requires case reference; IT roles also an admin authoriser. Writes an export row with a content hash.
- Role check in each route, server-side, via a helper in `src/lib/restricted-roles.ts` style. Hiding the menu is not enough.
- Screen under Network (`src/app/(dashboard)/network`), visible only to the three roles. Warnings follow the repo rule: each says what is missing and links to the fix.
- Manual reassignment of a device reuses the existing device-labels route, changed to call the reassign RPC. Tighten `unifi_device_labels` write policy at the same time (currently writable by any authenticated user).

## PRs, in order

1. Tables + RPC + capture + purge cron, no screen. Ships dark behind `app_settings.wifi_investigation_enabled` (false). Includes backfill from what the console still holds (about 90 days of daily usage, current guest list), read-only first against staging.
2. Lookup route, export route, screen, investigation log, tests for the role and authoriser rules.
3. DNS logs in a separate store (Backblaze B2, one file per center per day), only after the console check below passes.

## To verify before or during PR 1 (read-only)

- Real shape of `/stat/session` and `/stat/guest` responses (field names for IP, disassoc time) against staging.
- Whether the console health data exposes the WAN IP, and its behaviour on a failover link.
- Whether each center's public IP is its own or shared by the provider (CGNAT). If shared, the IP check in the lookup must say so.
- How long the console keeps sessions and guests (decides how far the backfill reaches).
- What the console can export for DNS and connection logs (PR 3 only).

## Tests

- Unit: session parsing, assignment resolution and the append-only reassign RPC, IP-history extension and change, lookup outcomes, role and authoriser rules (admin self-authorised; IT needs a different admin; IT cannot self-authorise), purge cut-off.
- Browser click-through on a preview against staging with the STAGING banner visible, for each of the three roles and one non-allowed role. Never run it against production customers.

## Risks

- Per-person monitoring of customers' staff: keep access narrow, audit everything, state the retention period, and have a lawyer confirm 12 months and the disclosure process before PR 2 is used.
- Shared vouchers and private (rotating) MACs: reports narrow candidates, they do not name who typed the message. The cover sheet must say so.
- KYC is only at company level; seat users are name and phone as given by the company. The report states this.
- Cron time: extra console calls per center must stay inside the existing 50 second budget; check after the first run.
- Where to work: the current checkout is on an unrelated branch. Build in a worktree from `origin/main` (`git worktree add ../twv-crm-wifi-history -b feat/wifi-device-history origin/main`).
