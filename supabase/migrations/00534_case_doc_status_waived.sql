-- Adds 'waived' to the case document status enum.
--
-- Kept in its own migration and applied before anything reads or writes the
-- value: PostgreSQL will not let a new enum value be used in the same
-- transaction that adds it.

ALTER TYPE case_doc_status ADD VALUE IF NOT EXISTS 'waived';
