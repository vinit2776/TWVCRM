-- One-time fix: leads that arrived via public forms (status = 'new') but already
-- have activities, contracts, or proposals logged against them should not linger
-- in the "new enquiries" alert panel. Promote them to 'contacted'.
UPDATE leads
SET status = 'contacted'
WHERE status = 'new'
  AND tags && ARRAY['google-ads-form', 'meta-ads-form', 'walkin-form']::text[]
  AND (
    EXISTS (SELECT 1 FROM activities WHERE activities.lead_id = leads.id)
    OR EXISTS (SELECT 1 FROM contracts WHERE contracts.lead_id = leads.id)
    OR EXISTS (SELECT 1 FROM proposals WHERE proposals.lead_id = leads.id)
  );
