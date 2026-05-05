-- Migration: project-level target CPL + per-variant spend + tests-side economic verdict trio.
-- Part of the CPL-per-variant extension to the test-planner-emails feature.

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS target_cpl NUMERIC(8,2);

ALTER TABLE public.test_variants ADD COLUMN IF NOT EXISTS spend NUMERIC(10,2);
ALTER TABLE public.test_variants ADD COLUMN IF NOT EXISTS spend_updated_at TIMESTAMPTZ;

ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS economic_verdict TEXT
  CHECK (economic_verdict IS NULL OR economic_verdict IN
    ('VIABLE', 'NOT_VIABLE', 'WINNER_BUT_CHEAPER_ELSEWHERE',
     'INSUFFICIENT_SPEND', 'INSUFFICIENT_DATA'));
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS cpl_leader_variant_id UUID
  REFERENCES public.project_variants(id) ON DELETE SET NULL;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS oldest_spend_age_days INT;
