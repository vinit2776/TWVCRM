-- Allow attachments without a specific event (vendor uploads via QR scan)
ALTER TABLE amc_event_attachments
  ALTER COLUMN event_id DROP NOT NULL,
  DROP CONSTRAINT amc_event_attachments_event_id_fkey,
  ADD CONSTRAINT amc_event_attachments_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES amc_service_events(id) ON DELETE SET NULL;

-- Add notes column for vendor comments
ALTER TABLE amc_event_attachments ADD COLUMN notes text;

CREATE INDEX idx_amc_event_attachments_asset ON amc_event_attachments(asset_id);
