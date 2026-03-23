-- Migration: Add image support to LP generator
-- Adds image_mode to projects and creates lp_image_content table for per-variant image slots
-- Run this via Supabase SQL editor or CLI

-- 1. Add image_mode column to projects
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS image_mode TEXT NOT NULL DEFAULT 'css_only';

-- 2. Create lp_image_content table
CREATE TABLE IF NOT EXISTS public.lp_image_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES public.project_variants(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  image_url TEXT NOT NULL,
  source TEXT NOT NULL,
  source_meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (variant_id, slot)
);

-- 3. Enable RLS
ALTER TABLE public.lp_image_content ENABLE ROW LEVEL SECURITY;

-- 4. RLS policies for lp_image_content

CREATE POLICY "Users can view own images" ON public.lp_image_content
  FOR SELECT USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can insert own images" ON public.lp_image_content
  FOR INSERT WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can update own images" ON public.lp_image_content
  FOR UPDATE USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can delete own images" ON public.lp_image_content
  FOR DELETE USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Managers can read all images" ON public.lp_image_content
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid() AND up.is_manager = true
    )
  );

CREATE POLICY "Managers can update all images" ON public.lp_image_content
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid() AND up.is_manager = true
    )
  );

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_image_content_variant_id ON public.lp_image_content(variant_id);
CREATE INDEX IF NOT EXISTS idx_image_content_project_id ON public.lp_image_content(project_id);
