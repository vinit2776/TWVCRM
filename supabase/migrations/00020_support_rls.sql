-- ==========================================
-- Migration 00019: Enable RLS on Support Tables
-- ==========================================
-- NOTE: support_tickets was originally created outside migrations.
-- CREATE TABLE IF NOT EXISTS ensures staging environments bootstrap correctly.
-- On production these statements are no-ops (tables already exist).

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject             TEXT NOT NULL,
  description         TEXT,
  type                TEXT NOT NULL DEFAULT 'bug',
  priority            TEXT NOT NULL DEFAULT 'medium',
  status              TEXT NOT NULL DEFAULT 'open',
  page_url            TEXT,
  user_agent          TEXT,
  screen_resolution   TEXT,
  screenshot_path     TEXT,
  reported_by         UUID REFERENCES public.users(id),
  assigned_to         UUID REFERENCES public.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.support_ticket_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  note        TEXT NOT NULL,
  created_by  UUID REFERENCES public.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Fixes two Supabase Security Advisor errors:
--   "RLS Disabled in Public" on:
--     - public.support_tickets
--     - public.support_ticket_notes
--
-- Policy design:
--   support_tickets
--     • Any authenticated user may INSERT (submit a bug report)
--     • Users may SELECT their own tickets (reported_by = auth.uid())
--     • Admins may SELECT / UPDATE / DELETE all tickets
--
--   support_ticket_notes
--     • Authenticated users may INSERT notes
--     • Authenticated users may SELECT all notes
--     • Admins may UPDATE / DELETE any note
-- ==========================================


-- ==========================================
-- support_tickets — enable RLS
-- ==========================================
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- Any logged-in user can submit a ticket
CREATE POLICY "Authenticated users can create support tickets"
  ON public.support_tickets FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Users can view their own tickets
CREATE POLICY "Users can view own support tickets"
  ON public.support_tickets FOR SELECT
  USING (
    reported_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- Only admins/managers can update tickets (change status, assign, resolve)
CREATE POLICY "Admins can update support tickets"
  ON public.support_tickets FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- Only admins can delete tickets
CREATE POLICY "Admins can delete support tickets"
  ON public.support_tickets FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role = 'admin'
        AND is_active = true
    )
  );


-- ==========================================
-- support_ticket_notes — enable RLS
-- ==========================================
ALTER TABLE public.support_ticket_notes ENABLE ROW LEVEL SECURITY;

-- Any logged-in user can add a note
CREATE POLICY "Authenticated users can create ticket notes"
  ON public.support_ticket_notes FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Any logged-in user can read notes
CREATE POLICY "Authenticated users can read ticket notes"
  ON public.support_ticket_notes FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only admins/managers can update notes
CREATE POLICY "Admins can update ticket notes"
  ON public.support_ticket_notes FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'manager')
        AND is_active = true
    )
  );

-- Only admins can delete notes
CREATE POLICY "Admins can delete ticket notes"
  ON public.support_ticket_notes FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role = 'admin'
        AND is_active = true
    )
  );
