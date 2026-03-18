-- Migration: Add RLS policy so managers can view all projects
-- Run this via Supabase SQL editor or CLI
-- Note: This assumes the projects table already has RLS enabled.
-- If RLS is not enabled yet, uncomment the next line:
-- ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- Users can read their own projects
CREATE POLICY IF NOT EXISTS "Users can read own projects" ON public.projects
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own projects
CREATE POLICY IF NOT EXISTS "Users can insert own projects" ON public.projects
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own projects
CREATE POLICY IF NOT EXISTS "Users can update own projects" ON public.projects
  FOR UPDATE USING (auth.uid() = user_id);

-- Managers can read all projects
CREATE POLICY "Managers can read all projects" ON public.projects
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid() AND up.is_manager = true
    )
  );

-- Managers can update all projects (e.g. change status)
CREATE POLICY "Managers can update all projects" ON public.projects
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid() AND up.is_manager = true
    )
  );
