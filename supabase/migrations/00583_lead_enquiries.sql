-- 00583_lead_enquiries.sql
-- One row per public-form submission (Google Ads / Meta Ads / Walk-in), each with a
-- unique reference (TWV-E-0001) the customer can quote. Until now an enquiry had no
-- identity of its own: a first submission created a lead, and a returning contact only
-- added a note to the existing lead.
--
-- Phase 1: numbering + display. Claim / resolve state stays on `leads` for now; moving it
-- onto each enquiry is a later migration.

CREATE SEQUENCE IF NOT EXISTS lead_enquiry_ref_seq;

CREATE TABLE IF NOT EXISTS lead_enquiries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference      text NOT NULL UNIQUE
                   DEFAULT ('TWV-E-' || lpad(nextval('lead_enquiry_ref_seq')::text, 4, '0')),
  -- SET NULL, not CASCADE: a customer may still quote a reference after the lead is deleted.
  lead_id        uuid REFERENCES leads(id) ON DELETE SET NULL,
  source         text NOT NULL CHECK (source IN ('google_ads', 'meta_ads', 'direct_walkin')),
  is_re_enquiry  boolean NOT NULL DEFAULT false,
  -- The submitted form fields exactly as received, so a later edit of the lead can't
  -- rewrite what this enquiry said.
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_enquiries_lead_idx     ON lead_enquiries (lead_id, received_at DESC);
CREATE INDEX IF NOT EXISTS lead_enquiries_received_idx ON lead_enquiries (received_at DESC);

ALTER TABLE lead_enquiries ENABLE ROW LEVEL SECURITY;

-- Rows are written only by the public enquiry API (service role, bypasses RLS).
DROP POLICY IF EXISTS "lead_enquiries_select_authenticated" ON lead_enquiries;
CREATE POLICY "lead_enquiries_select_authenticated"
  ON lead_enquiries FOR SELECT TO authenticated USING (true);

-- ─── Backfill ────────────────────────────────────────────────────────────────
-- One statement, ordered by received time across BOTH kinds of submission, so references
-- read chronologically. Idempotent (NOT EXISTS guards): re-running after deploy picks up
-- anything submitted between the migration and the code going live without duplicating.
--   first submission  = every lead that came in through a public form
--   re-enquiry        = each "Re-enquiry via <source> form" note on an existing lead
INSERT INTO lead_enquiries (lead_id, source, is_re_enquiry, payload, received_at)
SELECT lead_id, source, is_re_enquiry, payload, received_at
FROM (
  SELECT l.id AS lead_id,
         CASE
           WHEN 'meta-ads-form' = ANY (l.tags) THEN 'meta_ads'
           WHEN 'walkin-form'   = ANY (l.tags) THEN 'direct_walkin'
           ELSE 'google_ads'
         END AS source,
         false AS is_re_enquiry,
         jsonb_strip_nulls(jsonb_build_object(
           'name',               btrim(coalesce(l.first_name, '') || ' ' || coalesce(l.last_name, '')),
           'mobile',             l.mobile,
           'email',              l.email,
           'company',            l.company,
           'workspace_type',     l.workspace_type,
           'seat_capacity',      l.seat_capacity,
           'budget_per_seat',    l.budget_per_seat,
           'preferred_location', l.preferred_location,
           'working_hours',      l.working_hours,
           'description',        l.description
         )) AS payload,
         l.created_at AS received_at
  FROM leads l
  WHERE l.tags && ARRAY['google-ads-form', 'meta-ads-form', 'walkin-form']::text[]
    AND NOT EXISTS (
      SELECT 1 FROM lead_enquiries e WHERE e.lead_id = l.id AND NOT e.is_re_enquiry
    )

  UNION ALL

  SELECT a.lead_id,
         CASE
           WHEN a.subject ILIKE 'Re-enquiry via Meta Ads%'       THEN 'meta_ads'
           WHEN a.subject ILIKE 'Re-enquiry via Direct Walk-in%' THEN 'direct_walkin'
           ELSE 'google_ads'
         END,
         true,
         jsonb_build_object('summary', a.description),
         a.created_at
  FROM activities a
  WHERE a.subject ILIKE 'Re-enquiry via %'
    AND a.lead_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM lead_enquiries e
      WHERE e.lead_id = a.lead_id
        AND e.is_re_enquiry
        AND abs(extract(epoch FROM (e.received_at - a.created_at))) < 60
    )
) submissions
ORDER BY received_at;
