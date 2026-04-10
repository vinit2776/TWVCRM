-- Add KYC, bank details, and compliance document columns to procurement_vendors

ALTER TABLE procurement_vendors
  ADD COLUMN IF NOT EXISTS pan_number         text,
  ADD COLUMN IF NOT EXISTS bank_name          text,
  ADD COLUMN IF NOT EXISTS bank_account_holder text,
  ADD COLUMN IF NOT EXISTS bank_account_number text,
  ADD COLUMN IF NOT EXISTS bank_ifsc          text,
  ADD COLUMN IF NOT EXISTS msme_number        text,
  ADD COLUMN IF NOT EXISTS kyc_verified       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS kyc_verified_at    timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_verified_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pan_doc_path       text,
  ADD COLUMN IF NOT EXISTS gst_cert_path      text,
  ADD COLUMN IF NOT EXISTS reg_cert_path      text,
  ADD COLUMN IF NOT EXISTS aadhar_doc_path    text,
  ADD COLUMN IF NOT EXISTS msme_cert_path     text;
