-- Migration: 00007_membership_agreement
-- Adds membership agreement fields to contracts table,
-- PAN number to leads table, and expands contract_status enum
-- for send/view/accept/reject workflow.

-- 1. Add PAN number to leads table
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pan_number VARCHAR(20);

-- 2. Expand contract_status enum with new workflow states
ALTER TYPE contract_status ADD VALUE IF NOT EXISTS 'sent';
ALTER TYPE contract_status ADD VALUE IF NOT EXISTS 'viewed';
ALTER TYPE contract_status ADD VALUE IF NOT EXISTS 'accepted';
ALTER TYPE contract_status ADD VALUE IF NOT EXISTS 'rejected';

-- 3. Make proposal_id nullable (contracts can be created directly without a proposal)
ALTER TABLE contracts ALTER COLUMN proposal_id DROP NOT NULL;

-- 4. Add membership agreement fields to contracts table
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS workspace_description TEXT,
  ADD COLUMN IF NOT EXISTS parking_space TEXT,
  ADD COLUMN IF NOT EXISTS complimentary_services TEXT,
  ADD COLUMN IF NOT EXISTS security_deposit_months DECIMAL(3,1) DEFAULT 3.0,
  ADD COLUMN IF NOT EXISTS escalation_percentage DECIMAL(5,2) DEFAULT 10.0,
  ADD COLUMN IF NOT EXISTS notice_period_months DECIMAL(3,1) DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS member_signatory_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS member_signatory_designation VARCHAR(255),
  ADD COLUMN IF NOT EXISTS agreement_date DATE,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
