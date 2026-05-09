-- Add 'renewal_in_progress' to contract_status enum
-- This intermediate status is set on the parent contract when a renewal draft
-- is created, and transitions to 'renewed' only when the renewal is activated.
ALTER TYPE contract_status ADD VALUE IF NOT EXISTS 'renewal_in_progress' BEFORE 'renewed';
