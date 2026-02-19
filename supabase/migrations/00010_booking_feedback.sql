-- =============================================
-- BOOKING FEEDBACK / CUSTOMER RATING SYSTEM
-- =============================================
-- Internal-only customer rating captured at booking checkout.
-- 6 dimensions rated 1–5, overall average auto-computed.
-- Lead score (0–100) is recalculated from average feedback.

CREATE TABLE booking_feedbacks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,

  -- 6 rating dimensions (1–5 scale, null = not rated for that dimension)
  space_etiquette SMALLINT CHECK (space_etiquette BETWEEN 1 AND 5),
  payment_discipline SMALLINT CHECK (payment_discipline BETWEEN 1 AND 5),
  community_behavior SMALLINT CHECK (community_behavior BETWEEN 1 AND 5),
  guest_management SMALLINT CHECK (guest_management BETWEEN 1 AND 5),
  resource_usage SMALLINT CHECK (resource_usage BETWEEN 1 AND 5),
  renewal_likelihood SMALLINT CHECK (renewal_likelihood BETWEEN 1 AND 5),

  -- Average of non-null dimensions (computed on insert/update by app layer)
  overall_rating NUMERIC(3,2),

  notes TEXT,
  rated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- One feedback per booking
CREATE UNIQUE INDEX idx_booking_feedbacks_booking ON booking_feedbacks(booking_id);
-- Fast lookup by lead for the feedback tab
CREATE INDEX idx_booking_feedbacks_lead ON booking_feedbacks(lead_id);

-- Reuse the existing updated_at trigger function
CREATE TRIGGER update_booking_feedbacks_updated_at
  BEFORE UPDATE ON booking_feedbacks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- AUTO-RECALCULATE LEAD SCORE FROM FEEDBACKS
-- =============================================
-- Maps average overall_rating (1–5) → lead score (0–100)
-- Formula: score = ROUND((avg_rating - 1) * 25)
--   1 → 0,  2 → 25,  3 → 50,  4 → 75,  5 → 100

CREATE OR REPLACE FUNCTION recalculate_lead_score()
RETURNS TRIGGER AS $$
DECLARE
  avg_rating NUMERIC;
BEGIN
  -- Skip if no lead linked (walk-in / guest bookings)
  IF NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT AVG(overall_rating) INTO avg_rating
  FROM booking_feedbacks
  WHERE lead_id = NEW.lead_id AND overall_rating IS NOT NULL;

  IF avg_rating IS NOT NULL THEN
    UPDATE leads SET score = LEAST(100, GREATEST(0, ROUND((avg_rating - 1) * 25)))
    WHERE id = NEW.lead_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recalculate_lead_score
  AFTER INSERT OR UPDATE ON booking_feedbacks
  FOR EACH ROW EXECUTE FUNCTION recalculate_lead_score();

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================
ALTER TABLE booking_feedbacks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read" ON booking_feedbacks
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "auth_insert" ON booking_feedbacks
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "auth_update" ON booking_feedbacks
  FOR UPDATE USING (auth.uid() IS NOT NULL);
