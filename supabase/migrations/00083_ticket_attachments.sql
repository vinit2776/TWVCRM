-- Add attachments array to support_tickets for multiple file uploads
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;

-- Migrate existing screenshot_path into attachments array
UPDATE support_tickets
SET attachments = jsonb_build_array(jsonb_build_object('path', screenshot_path, 'name', 'screenshot', 'uploaded_at', created_at))
WHERE screenshot_path IS NOT NULL AND (attachments IS NULL OR attachments = '[]'::jsonb);
