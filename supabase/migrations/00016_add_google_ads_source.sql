-- Add google_ads as a lead source to support Google Ads enquiry form
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'google_ads';
