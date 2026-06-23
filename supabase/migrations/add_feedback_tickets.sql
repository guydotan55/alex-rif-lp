-- User feedback + AI triage (Messaging Lab).
-- Tickets are inserted server-side (service role) by api/feedback.js, triaged by
-- the daily cron, and read client-side by the super_admin inbox under RLS.
-- Safe to re-run: table guarded by IF NOT EXISTS, policy DROP-then-CREATE.

CREATE TABLE IF NOT EXISTS public.feedback_tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email      text,                        -- stamped server-side from verified token
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  page_url        text,                        -- origin+pathname only (query/hash stripped)
  app_version     text,                        -- VERCEL_GIT_COMMIT_SHA, stamped server-side
  status          text NOT NULL DEFAULT 'NEEDS_TRIAGE'
                  CHECK (status IN ('NEEDS_TRIAGE','TRIAGED','READ','RESOLVED','TRIAGE_FAILED')),
  summary         text,                        -- written only by cron
  category        text CHECK (category IS NULL OR category IN ('bug','UX','feature-request','question','praise')),
  severity        text CHECK (severity IS NULL OR severity IN ('low','medium','high')),
  triage_attempts int  NOT NULL DEFAULT 0,     -- cap at 3 -> TRIAGE_FAILED
  triage_error    text,                        -- fail-loud: last failure recorded, not swallowed
  triaged_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
  -- no updated_at: nothing maintained it (revisit if we ever need "last touched")
);

CREATE INDEX IF NOT EXISTS idx_feedback_tickets_status     ON public.feedback_tickets (status);
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_created_at ON public.feedback_tickets (created_at DESC);

ALTER TABLE public.feedback_tickets ENABLE ROW LEVEL SECURITY;

-- ONLY policy: super_admin reads/updates everything (the inbox).
-- No insert-own policy -> submit is service-role only, so a user can't seed a fake-triaged row.
-- DROP-first so the migration is safe to re-run (CREATE POLICY is not idempotent).
DROP POLICY IF EXISTS "feedback_super_admin_all" ON public.feedback_tickets;
CREATE POLICY "feedback_super_admin_all" ON public.feedback_tickets
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );
