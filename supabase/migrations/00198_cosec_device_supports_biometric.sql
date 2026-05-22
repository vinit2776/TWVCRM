-- Add supports_biometric flag to cosec_devices.
-- Defaults to TRUE so all existing devices retain their current behaviour.
-- Set to FALSE for NFC card–only readers that have no fingerprint scanner.

ALTER TABLE cosec_devices
  ADD COLUMN IF NOT EXISTS supports_biometric BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN cosec_devices.supports_biometric IS
  'FALSE for NFC card–only readers (no fingerprint scanner). Skips the biometric enrollment step in the onboarding wizard.';
