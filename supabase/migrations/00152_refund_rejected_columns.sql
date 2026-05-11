-- Add dedicated rejected_by / rejected_at columns to refund_requests (Wave 3, item 2.5)
--
-- Previously, rejected refunds stored the rejector in approved_by, mixing
-- approvers and rejectors. This adds clean separation for audit trails.

ALTER TABLE refund_requests
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

-- Backfill: move rejection data out of approved_by for historically rejected requests
UPDATE refund_requests
  SET rejected_by = approved_by,
      rejected_at = approved_at,
      approved_by = NULL,
      approved_at = NULL
  WHERE status = 'rejected'
    AND approved_by IS NOT NULL
    AND rejected_by IS NULL;
