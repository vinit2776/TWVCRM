-- Tamil Nadu public holidays for calendar year 2026, per G.O.(Ms.) No.708,
-- Public (Miscellaneous) Dept, dated 11 Nov 2025. Applies to every Chennai
-- location (location_id NULL = all locations). 01-Apr (annual bank closing) is
-- banks-only and deliberately omitted.
--
-- The earlier seed (00266) stopped at Mar 2026 and used approximate dates; this
-- adds the official list so working-day vs holiday classification (energy usage
-- baselines, attendance) has a calendar to read. UNIQUE (holiday_date,
-- location_id) does not dedupe NULL locations, hence the NOT EXISTS guard —
-- safe to re-run, and it leaves any row already on a date untouched.
INSERT INTO public_holidays (holiday_date, name, location_id)
SELECT v.d::date, v.n, NULL
FROM (VALUES
  ('2026-01-01', 'New Year''s Day'),
  ('2026-01-15', 'Pongal'),
  ('2026-01-16', 'Thiruvalluvar Day'),
  ('2026-01-17', 'Uzhavar Thirunal'),
  ('2026-01-26', 'Republic Day'),
  ('2026-02-01', 'Thai Poosam'),
  ('2026-03-19', 'Telugu New Year''s Day'),
  ('2026-03-21', 'Ramzan (Idu''l Fitr)'),
  ('2026-03-31', 'Mahaveer Jayanthi'),
  ('2026-04-03', 'Good Friday'),
  ('2026-04-14', 'Tamil New Year''s Day / Dr. B.R. Ambedkar''s Birthday'),
  ('2026-05-01', 'May Day'),
  ('2026-05-28', 'Bakrid (Idul Azha)'),
  ('2026-06-26', 'Muharram (Yaom-E-Shahadath)'),
  ('2026-08-15', 'Independence Day'),
  ('2026-08-26', 'Milad-un-Nabi (Prophet''s Birthday)'),
  ('2026-09-04', 'Krishna Jayanthi'),
  ('2026-09-14', 'Vinayakar Chathurthi'),
  ('2026-10-02', 'Gandhi Jayanthi'),
  ('2026-10-19', 'Ayutha Pooja'),
  ('2026-10-20', 'Vijaya Dasami'),
  ('2026-11-08', 'Deepavali'),
  ('2026-12-25', 'Christmas')
) AS v(d, n)
WHERE NOT EXISTS (
  SELECT 1 FROM public_holidays h WHERE h.holiday_date = v.d::date AND h.location_id IS NULL
);
