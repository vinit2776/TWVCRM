-- Rollback: NOT POSSIBLE. Postgres cannot remove a value from an enum type
-- (ALTER TYPE ... DROP VALUE does not exist). Once applied, gst_new and
-- gst_existing stay in vo_purpose for good. They are harmless if unused: the
-- five original values are kept and every existing row is untouched.
--
-- Virtual Office purposes: GST registration split into a new registration and
-- an additional place under an existing GSTIN. Only ADD VALUE statements live
-- here, because a newly added enum value cannot be used in the same transaction.

ALTER TYPE vo_purpose ADD VALUE IF NOT EXISTS 'gst_new';
ALTER TYPE vo_purpose ADD VALUE IF NOT EXISTS 'gst_existing';
