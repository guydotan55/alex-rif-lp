-- Migration: persist the summary verdict + winner meta so the dashboard banner
-- can color itself correctly and so the email handler doesn't need to trust
-- client-supplied payloads.

ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS summary_verdict TEXT
  CHECK (summary_verdict IS NULL OR summary_verdict IN ('WINNER_FOUND', 'PRACTICAL_TIE', 'TRENDING_UNDERPOWERED'));
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS summary_winner_variant_id UUID
  REFERENCES public.project_variants(id) ON DELETE SET NULL;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS summary_lift_pct NUMERIC(8,2);
