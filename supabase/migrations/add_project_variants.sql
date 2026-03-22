-- Migration: Add project_variants table for A/B testing support
-- Each project (experiment) can have multiple variant LPs with separate URLs
-- Run this via Supabase SQL editor or CLI

-- 1. Create project_variants table
CREATE TABLE IF NOT EXISTS public.project_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  variant_slug TEXT NOT NULL,
  variant_name TEXT,
  generated_html TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, variant_slug)
);

-- 2. Add variant_id to analytics_events (nullable for backward compat)
ALTER TABLE public.analytics_events
  ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES public.project_variants(id) ON DELETE SET NULL;

-- 3. Add variant_id to leads (nullable)
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES public.project_variants(id) ON DELETE SET NULL;

-- 4. Add variant_id to lp_editable_content (nullable initially)
ALTER TABLE public.lp_editable_content
  ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES public.project_variants(id) ON DELETE CASCADE;

-- 5. Backfill: create a default variant for each project that has generated_html
INSERT INTO public.project_variants (project_id, variant_slug, variant_name, generated_html, status, is_default)
SELECT id, 'default', 'Default', generated_html, status, true
FROM public.projects
WHERE generated_html IS NOT NULL
ON CONFLICT (project_id, variant_slug) DO NOTHING;

-- 6. Backfill variant_id on existing lp_editable_content rows
UPDATE public.lp_editable_content ec
SET variant_id = pv.id
FROM public.project_variants pv
WHERE pv.project_id = ec.project_id AND pv.is_default = true
  AND ec.variant_id IS NULL;

-- 7. Backfill variant_id on existing analytics_events
UPDATE public.analytics_events ae
SET variant_id = pv.id
FROM public.project_variants pv
WHERE pv.project_id = ae.project_id AND pv.is_default = true
  AND ae.variant_id IS NULL;

-- 8. Backfill variant_id on existing leads
UPDATE public.leads l
SET variant_id = pv.id
FROM public.project_variants pv
WHERE pv.project_id = l.project_id AND pv.is_default = true
  AND l.variant_id IS NULL;

-- 9. Add new unique constraint on lp_editable_content for (variant_id, key)
ALTER TABLE public.lp_editable_content
  ADD CONSTRAINT lp_editable_content_variant_id_key_key UNIQUE (variant_id, key);

-- 10. RLS policies for project_variants
ALTER TABLE public.project_variants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own variants" ON public.project_variants
  FOR SELECT USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can insert own variants" ON public.project_variants
  FOR INSERT WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can update own variants" ON public.project_variants
  FOR UPDATE USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can delete own variants" ON public.project_variants
  FOR DELETE USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Managers can read all variants" ON public.project_variants
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid() AND up.is_manager = true
    )
  );

CREATE POLICY "Managers can update all variants" ON public.project_variants
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid() AND up.is_manager = true
    )
  );

-- 11. Indexes for serve-lp lookup performance
CREATE INDEX IF NOT EXISTS idx_variants_project_slug ON public.project_variants(project_id, variant_slug);
CREATE INDEX IF NOT EXISTS idx_variants_default ON public.project_variants(project_id) WHERE is_default = true;
