-- =============================================
-- TWV CRM - Signed Contract Document Reference
-- =============================================

-- Add a reference to the signed contract document
ALTER TABLE contracts ADD COLUMN signed_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
