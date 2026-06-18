-- Public holiday calendar for TWV CRM.
-- Integrated into payroll LOP computation and attendance display.
-- Null location_id means the holiday applies to all locations.

CREATE TABLE public_holidays (
  id            uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date  date  NOT NULL,
  name          text  NOT NULL,
  location_id   uuid  REFERENCES locations(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(holiday_date, location_id)
);

ALTER TABLE public_holidays ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read public holidays"
  ON public_holidays FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin/manager/office_admin can manage public holidays"
  ON public_holidays FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role IN ('admin', 'manager', 'office_admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role IN ('admin', 'manager', 'office_admin')
    )
  );

CREATE INDEX idx_public_holidays_date ON public_holidays(holiday_date);

-- ── Seed: Tamil Nadu mandatory public holidays FY 2025-26 (April 2025 – March 2026) ──
-- Sources: TN Shops & Establishments Act 1947 + Central Government national holidays
-- National holidays (mandatory nationwide): Republic Day, Independence Day, Gandhi Jayanti
-- Festival holidays (TN mandatory): Pongal, Tamil New Year, Christmas + additional

INSERT INTO public_holidays (holiday_date, name) VALUES
  ('2025-04-10', 'Tamil New Year (Puthandu)'),
  ('2025-04-14', 'Dr. Ambedkar Jayanti / Good Friday'),
  ('2025-04-18', 'Good Friday'),
  ('2025-05-01', 'May Day (Labour Day)'),
  ('2025-06-07', 'Eid al-Adha (Bakrid)'),
  ('2025-07-06', 'Muharram'),
  ('2025-08-15', 'Independence Day'),
  ('2025-08-16', 'Janmashtami'),
  ('2025-08-27', 'Vinayaka Chaturthi'),
  ('2025-10-02', 'Gandhi Jayanti / Dussehra'),
  ('2025-10-20', 'Ayudha Puja'),
  ('2025-10-21', 'Vijayadasami (Dussehra)'),
  ('2025-10-23', 'Diwali (Deepavali)'),
  ('2025-11-01', 'Kannada Rajyotsava / Tamil Nadu foundation'),
  ('2025-11-05', 'Diwali Holiday'),
  ('2025-12-25', 'Christmas Day'),
  ('2026-01-01', 'New Year''s Day'),
  ('2026-01-14', 'Pongal'),
  ('2026-01-15', 'Thiruvalluvar Day'),
  ('2026-01-16', 'Uzhavar Thirunal'),
  ('2026-01-26', 'Republic Day'),
  ('2026-03-06', 'Maha Shivaratri'),
  ('2026-03-20', 'Holi');
