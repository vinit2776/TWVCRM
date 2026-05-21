-- cosec_ref_id is null for denied events (event 201) where detail-1 is the
-- denial reason code, not a user ref ID. Make the column nullable.
ALTER TABLE access_logs ALTER COLUMN cosec_ref_id DROP NOT NULL;
