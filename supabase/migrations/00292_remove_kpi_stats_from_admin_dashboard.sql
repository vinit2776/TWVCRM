-- Remove kpi_stats from the admin dashboard saved widget config.
-- The code default no longer includes it, but the saved DB record takes
-- precedence so the widget kept reappearing after the code change.

UPDATE app_settings
SET value = (
  SELECT jsonb_set(
    value::jsonb,
    '{admin}',
    COALESCE(
      (
        SELECT jsonb_agg(elem ORDER BY ordinality)
        FROM jsonb_array_elements_text(value::jsonb -> 'admin') WITH ORDINALITY AS t(elem, ordinality)
        WHERE elem <> 'kpi_stats'
      ),
      '[]'::jsonb
    )
  )::text
)
WHERE key = 'dashboard_role_widgets'
  AND value::jsonb -> 'admin' IS NOT NULL;
