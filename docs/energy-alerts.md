# Energy slot alerts

Admin → Energy Alerts (`/admin/energy-alerts`). Tells staff when a location's power use strays
from what is usual for that 15-minute slot, without emailing on every slot.

## How it decides

- **Usual** = median kW of the same slot over the last 30 days of the same kind of day
  (Mon–Fri / Saturday / Sunday & holiday), from `location_energy_readings`
  (`src/lib/energy-alerts/baseline.ts`). Needs at least 3 comparable days, and there is **no
  fallback to other kinds of day** — a thin Saturday stays silent rather than being compared with
  weekdays. Days that had a real alert episode are left out of "usual".
- **Out of band** = more than `tolerance_pct` from usual AND at least `min_kw` away, in the rule's direction.
- **Episodes** (`src/lib/energy-alerts/engine.ts`, pure and unit-tested): a deviation is notified once
  it has lasted `persist_slots`; after that it is one open episode. Further emails only on a worsening
  step (1×/2×/4× tolerance) or a reminder (`std` = 2h/6h/24h, max 3; `4h` = every 4h, max 6; `none`).
  It closes only after `recover_slots` consecutive slots under 60% of tolerance, so hovering at the
  edge does not flap. Acknowledging stops reminders; a worsening step can still email.
- **Caps / safety**: `daily_cap` per rule (extras recorded as `held`), mute for N hours, test mode,
  and the global gate below. The unique `(rule_id, slot_ts, kind)` on `energy_alert_events` is the
  claim that stops a retried or overlapping run deciding twice; one open episode per rule is a partial unique index.
- **Stale slots**: a slot more than 3 hours old when processed (e.g. the ledger catching up after an
  outage) can move state but never emails.

## Sending

Nothing emails unless the rule is **Live** AND `app_settings.energy_alerts_cron_mode = 'live'`
(default `dry_run`; admin can change it on the page). Otherwise the decision is stored with status
`test`. Recipients are free-text staff addresses on the rule (max 10); CRM users among them also get an
in-app notification. Never a customer.

## Latency

The evaluator runs hourly at :14, after the hourly OneGrid ledger capture at :07, so an alert lands up
to about an hour after the slot. Faster alerts need the capture to run more often first.

## Testing on staging

```bash
node scripts/seed-staging-energy.mjs            # fake meter + ~36 days of readings, last 2h spiked
node scripts/seed-staging-energy.mjs --clear    # undo
```

Then create a rule on "Perungudi - OMR (staging test)" and press **Check now**. Preview/staging
deployments should keep dummy email keys (see CLAUDE.md → Staging) so even a Live rule cannot reach anyone.

## Not built yet

Signed one-click acknowledge/mute links in the email, an alert-health page, a planned-events calendar,
per-slot adaptive bands, other check types (after-hours load, day running ahead, meter silent).
