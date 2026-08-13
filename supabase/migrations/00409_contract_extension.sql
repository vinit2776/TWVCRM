-- Contract extension: lets an active contract's end_date be pushed forward by a
-- small number of days (capped at 60 cumulative days) instead of running a full
-- renewal for a short validity gap. days_extended tracks the lifetime total so
-- the cap can be enforced across multiple extension actions.
ALTER TABLE contracts ADD COLUMN days_extended integer NOT NULL DEFAULT 0
  CONSTRAINT contracts_days_extended_non_negative CHECK (days_extended >= 0);
