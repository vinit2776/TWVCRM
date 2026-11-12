-- 00584_enquiry_claim_resolve_state.sql
-- Phase 2 of per-enquiry tracking: claim / resolve state moves from `leads` onto each
-- `lead_enquiries` row, so a re-enquiry no longer wipes who handled the earlier one.
--
-- The old lead-level columns (leads.claimed_*, resolved_*, resolution_outcome,
-- attention_reset_at) are left in place but are no longer read or written by the app.
-- They can be dropped in a later cleanup once this has been live for a while.

ALTER TABLE lead_enquiries
  ADD COLUMN IF NOT EXISTS claimed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at        timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_outcome text
    CHECK (resolution_outcome IN ('converted', 'not_interested', 'no_response', 'superseded'));

-- 'superseded' is written only by the backfill below: an older enquiry whose real outcome
-- was overwritten when the customer enquired again. It is excluded from conversion stats.

-- Active-queue index: the tracker and bell only query open enquiries.
CREATE INDEX IF NOT EXISTS lead_enquiries_open_idx
  ON lead_enquiries (received_at DESC)
  WHERE resolved_at IS NULL;

-- Live updates for the bell / tracker (they subscribe to this table).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'lead_enquiries'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE lead_enquiries;
  END IF;
END $$;

-- ─── Backfill ────────────────────────────────────────────────────────────────
-- Run ONCE. Step 1 is guarded so it never overwrites state already on an enquiry, and a
-- copy of step 1 alone can be re-run straight after the deploy to catch claims/resolves
-- made on the old lead columns between applying this and the new code going live.
-- Step 2 must NOT be re-run: after deploy, older enquiries can legitimately stay open.

-- 1) Each lead's CURRENT state belongs to its LATEST enquiry.
WITH latest AS (
  SELECT DISTINCT ON (lead_id) id, lead_id
  FROM lead_enquiries
  WHERE lead_id IS NOT NULL
  ORDER BY lead_id, received_at DESC, created_at DESC, reference DESC
)
UPDATE lead_enquiries e
SET claimed_by         = l.claimed_by,
    claimed_at         = l.claimed_at,
    resolved_by        = l.resolved_by,
    resolved_at        = l.resolved_at,
    resolution_outcome = l.resolution_outcome
FROM latest, leads l
WHERE e.id = latest.id
  AND l.id = latest.lead_id
  AND e.claimed_by IS NULL AND e.claimed_at IS NULL
  AND e.resolved_at IS NULL AND e.resolution_outcome IS NULL
  AND (l.claimed_by IS NOT NULL OR l.claimed_at IS NOT NULL
       OR l.resolved_at IS NOT NULL OR l.resolution_outcome IS NOT NULL);

-- 2) Every older enquiry for the same lead: its outcome was lost when the customer
--    enquired again. Mark it superseded, closed at the moment the next enquiry arrived.
WITH ranked AS (
  SELECT id,
         lead_id,
         lead(received_at) OVER (PARTITION BY lead_id ORDER BY received_at, created_at, reference) AS next_received_at
  FROM lead_enquiries
  WHERE lead_id IS NOT NULL
)
UPDATE lead_enquiries e
SET resolved_at        = r.next_received_at,
    resolution_outcome = 'superseded'
FROM ranked r
WHERE e.id = r.id
  AND r.next_received_at IS NOT NULL
  AND e.resolved_at IS NULL
  AND e.resolution_outcome IS NULL;
