-- ============================================================
-- 00337: add 'recurring_instance' to facility_task_type
--
-- Part of Phase 1 (recurring delegation) of the Internal Tasks plan.
-- Postgres requires ALTER TYPE ... ADD VALUE to run in its own
-- transaction, separate from anything that references the new value —
-- hence this is a standalone migration ahead of 00338, which creates
-- the task_recurrence_rules table and the facility_issues FK that
-- will actually use this value.
-- ============================================================

ALTER TYPE facility_task_type ADD VALUE IF NOT EXISTS 'recurring_instance';
