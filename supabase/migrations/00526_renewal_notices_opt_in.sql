-- Renewal notices are for cases created from here on, never for the ones
-- 00525 just backfilled.
--
-- 00525 gave all 58 existing cases an end_date. Those dates are historically
-- correct, but they were derived by a migration, not agreed with anyone — and
-- several are already in the past or close to it. If the renewal cron were
-- enabled with those dates in place, it would email customers and referral
-- partners about agreements nobody has been tracking, some of them expired
-- months ago, with live payment links attached.
--
-- Keeping the cron off the vercel.json schedule prevents that today, but it is
-- a soft guarantee: re-adding one line to vercel.json would undo it. This
-- makes the guarantee structural instead. Every stage of the renewal cron
-- filters on renewal_notices_enabled, so a backfilled case cannot be selected
-- however the job is invoked — scheduled, by hand, or by mistake.
--
-- New cases default to true and are unaffected.
--
-- To opt an individual existing case in later — deliberately, once someone has
-- confirmed its end_date with the client or partner:
--   UPDATE cases SET renewal_notices_enabled = true WHERE case_number = 'TWV-CASE-00NN';

ALTER TABLE cases
  ADD COLUMN renewal_notices_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN cases.renewal_notices_enabled IS
  'Whether the VO renewal cron may notify anyone about this case. False for the cases that predate the 00525 end_date backfill; true by default for everything created since.';

-- Suppress every case that exists at this point — i.e. exactly the set 00525
-- backfilled. Anything inserted after this migration gets the default.
UPDATE cases SET renewal_notices_enabled = false;

CREATE INDEX idx_cases_renewal_notices_enabled
  ON cases(renewal_notices_enabled)
  WHERE renewal_notices_enabled = true;
