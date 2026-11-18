-- Migration 00731: Prepaid package sale terms, cancellation restore, activation guard
--
-- 1. Cancellation window (hours before start) on templates and on each sale
-- 2. Redeemable locations per sold package
-- 3. Audit record for every cancel / no-show of a booking that used a package
-- 4. record_prepaid_cancellation(): atomic, idempotent credit restore
-- 5. Activation guard: only admin/manager can (de)activate a package; a package
--    edited by anyone else goes back to inactive for re-approval

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Cancellation window. NULL means credits are never restored.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE prepaid_packages
  ADD COLUMN IF NOT EXISTS default_cancellation_window_hours NUMERIC(6,2) DEFAULT 2
    CHECK (default_cancellation_window_hours IS NULL OR default_cancellation_window_hours >= 0);

ALTER TABLE prepaid_purchases
  ADD COLUMN IF NOT EXISTS cancellation_window_hours NUMERIC(6,2)
    CHECK (cancellation_window_hours IS NULL OR cancellation_window_hours >= 0);

-- Purchases sold before this migration take the standard 2 hour window. Done once
-- here: from now on NULL on a purchase is a deliberate "no restores" choice.
UPDATE prepaid_purchases SET cancellation_window_hours = 2 WHERE cancellation_window_hours IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Redeemable locations. A purchase with no rows (legacy) is valid everywhere.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prepaid_purchase_locations (
  purchase_id UUID NOT NULL REFERENCES prepaid_purchases(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id),
  PRIMARY KEY (purchase_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_prepaid_purchase_locations_location
  ON prepaid_purchase_locations(location_id);

ALTER TABLE prepaid_purchase_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read"   ON prepaid_purchase_locations FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON prepaid_purchase_locations FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Carry over the single location older purchases were sold for.
INSERT INTO prepaid_purchase_locations (purchase_id, location_id)
SELECT id, location_id FROM prepaid_purchases WHERE location_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. One audit row per booking that used a package and was then cancelled or
--    marked no-show. Feeds the package statement of account.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prepaid_cancellation_events (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id         UUID         NOT NULL REFERENCES prepaid_purchases(id),
  booking_id          UUID         NOT NULL UNIQUE REFERENCES bookings(id),
  trigger             TEXT         NOT NULL CHECK (trigger IN ('cancel', 'no_show')),
  outcome             TEXT         NOT NULL CHECK (outcome IN ('restored', 'forfeited')),
  credits_restored    NUMERIC(10,2) NOT NULL DEFAULT 0,
  hours_before_start  NUMERIC(8,2) NOT NULL,
  window_hours        NUMERIC(6,2),
  is_override         BOOLEAN      NOT NULL DEFAULT false,
  override_reason     TEXT,
  actor_id            UUID,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (NOT is_override OR override_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_prepaid_cancellation_events_purchase
  ON prepaid_cancellation_events(purchase_id);

ALTER TABLE prepaid_cancellation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read"   ON prepaid_cancellation_events FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON prepaid_cancellation_events FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Atomic restore. The caller decides restore vs forfeit (src/lib/prepaid.ts);
--    this only applies it. Idempotent: a booking is recorded once.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION record_prepaid_cancellation(
  p_booking_id         UUID,
  p_trigger            TEXT,
  p_hours_before_start NUMERIC,
  p_window_hours       NUMERIC,
  p_restore            BOOLEAN,
  p_override           BOOLEAN,
  p_override_reason    TEXT,
  p_actor              UUID
)
RETURNS TABLE(applied BOOLEAN, credits_restored NUMERIC, new_credits_used NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE
  v_red      RECORD;
  v_pur      RECORD;
  v_restore  NUMERIC := 0;
  v_new_used NUMERIC;
BEGIN
  SELECT * INTO v_red
  FROM prepaid_redemptions
  WHERE booking_id = p_booking_id
  ORDER BY redeemed_at
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 0::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  -- The purchase row lock serialises concurrent cancellations of the same booking.
  SELECT * INTO v_pur FROM prepaid_purchases WHERE id = v_red.purchase_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM prepaid_cancellation_events WHERE booking_id = p_booking_id) THEN
    RETURN QUERY SELECT FALSE, 0::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  v_new_used := v_pur.credits_used;

  IF p_restore THEN
    v_restore  := v_red.credits_deducted;
    v_new_used := GREATEST(0, ROUND(v_pur.credits_used - v_restore, 2));
    UPDATE prepaid_purchases SET
      credits_used = v_new_used,
      status = CASE
        WHEN status = 'exhausted' AND v_new_used < total_credits AND expires_at >= CURRENT_DATE
          THEN 'active' ELSE status END,
      updated_at = NOW()
    WHERE id = v_pur.id;
  END IF;

  INSERT INTO prepaid_cancellation_events (
    purchase_id, booking_id, trigger, outcome, credits_restored,
    hours_before_start, window_hours, is_override, override_reason, actor_id
  ) VALUES (
    v_pur.id, p_booking_id, p_trigger,
    CASE WHEN p_restore THEN 'restored' ELSE 'forfeited' END,
    v_restore, p_hours_before_start, p_window_hours,
    COALESCE(p_override, false), p_override_reason, p_actor
  );

  RETURN QUERY SELECT TRUE, v_restore, v_new_used;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Activation guard. auth.uid() is NULL for the service role, which is allowed.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_prepaid_package_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT role::TEXT INTO v_role FROM users WHERE auth_id = auth.uid();

  IF v_role IN ('admin', 'manager') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.is_active := false;
    RETURN NEW;
  END IF;

  -- Material edit to a live package by anyone else: back to inactive for re-approval.
  IF OLD.is_active AND (
       NEW.name IS DISTINCT FROM OLD.name
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.price IS DISTINCT FROM OLD.price
    OR NEW.validity_days IS DISTINCT FROM OLD.validity_days
    OR NEW.total_credits IS DISTINCT FROM OLD.total_credits
    OR NEW.credit_type IS DISTINCT FROM OLD.credit_type
    OR NEW.workspace_type IS DISTINCT FROM OLD.workspace_type
    OR NEW.space_id IS DISTINCT FROM OLD.space_id
    OR NEW.location_id IS DISTINCT FROM OLD.location_id
    OR NEW.default_cancellation_window_hours IS DISTINCT FROM OLD.default_cancellation_window_hours
  ) THEN
    NEW.is_active := false;
    RETURN NEW;
  END IF;

  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    RAISE EXCEPTION 'Only admins and managers can activate or deactivate packages';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prepaid_package_activation ON prepaid_packages;
CREATE TRIGGER trg_prepaid_package_activation
  BEFORE INSERT OR UPDATE ON prepaid_packages
  FOR EACH ROW EXECUTE FUNCTION enforce_prepaid_package_activation();

-- Rollback:
--   DROP TRIGGER trg_prepaid_package_activation ON prepaid_packages;
--   DROP FUNCTION enforce_prepaid_package_activation();
--   DROP FUNCTION record_prepaid_cancellation(UUID, TEXT, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT, UUID);
--   DROP TABLE prepaid_cancellation_events, prepaid_purchase_locations;
--   ALTER TABLE prepaid_purchases DROP COLUMN cancellation_window_hours;
--   ALTER TABLE prepaid_packages DROP COLUMN default_cancellation_window_hours;
