-- Add aggregator as a lead source; the lead creation UI already offers it (src/lib/constants.ts LEAD_SOURCES)
-- but the enum was never updated, causing "invalid input value for enum lead_source: aggregator".
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'aggregator';
