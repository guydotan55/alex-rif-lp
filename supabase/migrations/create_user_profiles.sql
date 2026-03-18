-- Migration: Create user_profiles table for manager role system
-- Run this via Supabase SQL editor or CLI

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  is_manager boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "Users can read own profile" ON public.user_profiles
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own profile (auto-create on first login)
CREATE POLICY "Anon and authenticated can insert own profile" ON public.user_profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Service role has full access (used by API endpoints)
CREATE POLICY "Service role full access" ON public.user_profiles
  FOR ALL USING (true);
