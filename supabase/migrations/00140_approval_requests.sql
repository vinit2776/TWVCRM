-- Generic approval requests table
-- Supports escalation approvals and can be extended for other approval types
CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What type of approval
  approval_type TEXT NOT NULL,  -- 'escalation_reduction', 'escalation_waiver', etc.

  -- What entity this approval is for
  entity_type TEXT NOT NULL DEFAULT 'contract',
  entity_id UUID NOT NULL,

  -- Human-readable reference (e.g., contract number)
  entity_reference TEXT,

  -- Who requested and when
  requested_by UUID NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Request details
  reason TEXT,  -- Why the requester wants this
  metadata JSONB DEFAULT '{}',  -- Structured data (e.g., old_escalation, new_escalation, contract_number)

  -- Approval status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),

  -- Who acted and when
  acted_by UUID REFERENCES users(id),
  acted_at TIMESTAMPTZ,
  rejection_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_entity ON approval_requests(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_requested_by ON approval_requests(requested_by);

-- RLS
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read approval requests"
  ON approval_requests FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert approval requests"
  ON approval_requests FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update approval requests"
  ON approval_requests FOR UPDATE
  TO authenticated
  USING (true);

-- Add escalation_approval_status to contracts for quick filtering
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS escalation_approval_status TEXT DEFAULT NULL
  CHECK (escalation_approval_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS escalation_approval_id UUID REFERENCES approval_requests(id);
