-- Migration: planner inputs + lifecycle-email state ledger on tests
-- Run via: npx supabase db push (or Supabase SQL editor)

-- Planner inputs (filled at test creation in the dashboard calculator)
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS target_sample_size INT;       -- per variant
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS baseline_cvr NUMERIC(5,4);    -- 0.0300 = 3%
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS mde NUMERIC(5,4);             -- 0.2000 = +20% relative
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS expected_cpc NUMERIC(8,2);    -- ₪3.50

-- Email-state ledger (cron writes; idempotency)
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS last_milestone_sent INT NOT NULL DEFAULT 0;  -- 0/25/50/75/100
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS stall_alert_sent_at TIMESTAMPTZ;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS summary_sent_at TIMESTAMPTZ;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS kickoff_sent_at TIMESTAMPTZ;

-- Partial index for the cron's primary query
CREATE INDEX IF NOT EXISTS idx_tests_running_started ON public.tests(status, started_at)
  WHERE status = 'running';
