-- ============================================================
-- 00336: widen facility_asset_events.event_type
--
-- Asset history today only gets an auto-written row when an
-- asset-linked task is resolved (see .../issues/[id]/status/route.ts).
-- Extending it to also capture 'assigned' (who took ownership) and
-- 'reopened' (a "fixed" problem came back) — both meaningful moments
-- in an asset's maintenance record, per user request.
-- ============================================================

ALTER TABLE facility_asset_events
  DROP CONSTRAINT facility_asset_events_event_type_check;

ALTER TABLE facility_asset_events
  ADD CONSTRAINT facility_asset_events_event_type_check CHECK (event_type IN (
    'maintenance', 'inspection', 'fault_observed', 'part_replaced',
    'cleaning', 'installation', 'relocation', 'assigned', 'reopened', 'other'
  ));
