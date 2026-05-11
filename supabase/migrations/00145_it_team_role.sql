-- Add 'it_team' role for IT staff
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'it_team';
