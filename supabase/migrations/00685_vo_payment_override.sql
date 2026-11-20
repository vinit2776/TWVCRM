-- 00685_vo_payment_override.sql
-- Audited admin override of the VO execution payment gate, plus the
-- vo_draft_gate_mode setting ('off' default | 'enforce').
--
-- Rollback:
--   ALTER TABLE cases DROP COLUMN IF EXISTS payment_override_reason;
--   ALTER TABLE cases DROP COLUMN IF EXISTS payment_override_by;
--   ALTER TABLE cases DROP COLUMN IF EXISTS payment_override_at;
--   DELETE FROM app_settings WHERE key = 'vo_draft_gate_mode';

ALTER TABLE cases ADD COLUMN IF NOT EXISTS payment_override_reason text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS payment_override_by uuid REFERENCES users(id);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS payment_override_at timestamptz;

INSERT INTO app_settings (key, value) VALUES ('vo_draft_gate_mode', 'off')
ON CONFLICT (key) DO NOTHING;
