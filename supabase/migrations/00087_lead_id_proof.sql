-- Add ID proof storage to leads
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS id_proof_path TEXT,
  ADD COLUMN IF NOT EXISTS id_proof_uploaded_at TIMESTAMPTZ;
