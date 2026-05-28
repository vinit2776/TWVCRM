-- Extend approval_requests to support complimentary booking requests
-- with 24-hour expiry windows.

-- 1. Add expires_at column (null for existing rows — only set for comp_request type)
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 2. Widen the status CHECK to include 'expired'
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_status_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'expired'));

-- 3. Index to make expiry cron fast (only scans rows that have an expiry)
CREATE INDEX IF NOT EXISTS idx_approval_requests_expiry
  ON approval_requests (status, expires_at)
  WHERE expires_at IS NOT NULL;

-- 4. Index for floor-manager "my requests" query
CREATE INDEX IF NOT EXISTS idx_approval_requests_requester_type
  ON approval_requests (requested_by, approval_type, created_at DESC);
