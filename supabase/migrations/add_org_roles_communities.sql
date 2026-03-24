-- Migration: Add organizations, communities, user_roles
-- and modify projects for multi-tenant hierarchy

-- 1. Create organizations table
CREATE TABLE IF NOT EXISTS public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Create communities table
CREATE TABLE IF NOT EXISTS public.communities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Create user_roles table
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'manager')),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  community_id UUID REFERENCES public.communities(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

-- 4. Add community_id and test_assumptions to projects (nullable initially)
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS community_id UUID REFERENCES public.communities(id) ON DELETE RESTRICT;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS test_assumptions JSONB DEFAULT '[]';

-- 5. Seed: Create "Bavua" organization and "Default" community
INSERT INTO public.organizations (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Bavua')
ON CONFLICT DO NOTHING;

INSERT INTO public.communities (id, organization_id, name)
VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Default')
ON CONFLICT DO NOTHING;

-- 6. Backfill: assign all existing projects to Default community
UPDATE public.projects
SET community_id = '00000000-0000-0000-0000-000000000002'
WHERE community_id IS NULL;

-- 7. Make community_id NOT NULL now that all rows are backfilled
ALTER TABLE public.projects
  ALTER COLUMN community_id SET NOT NULL;

-- 8. Migrate user_profiles.is_manager to user_roles
-- is_manager = true -> admin under Bavua
INSERT INTO public.user_roles (user_id, email, role, organization_id)
SELECT up.user_id, up.email, 'admin', '00000000-0000-0000-0000-000000000001'
FROM public.user_profiles up
WHERE up.is_manager = true
ON CONFLICT (user_id) DO NOTHING;

-- is_manager = false -> manager of Default community (preserves access)
INSERT INTO public.user_roles (user_id, email, role, organization_id, community_id)
SELECT up.user_id, up.email, 'manager', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'
FROM public.user_profiles up
WHERE up.is_manager = false OR up.is_manager IS NULL
ON CONFLICT (user_id) DO NOTHING;

-- 9. Drop is_manager from user_profiles
ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS is_manager;

-- 10. RLS for organizations
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admins can do anything with orgs" ON public.organizations
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Admins can view their org" ON public.organizations
  FOR SELECT USING (
    id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

-- 11. RLS for communities
ALTER TABLE public.communities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admins can do anything with communities" ON public.communities
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Admins can manage communities in their org" ON public.communities
  FOR ALL USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Managers can view their community" ON public.communities
  FOR SELECT USING (
    id IN (SELECT community_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
  );

-- 12. RLS for user_roles
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admins can do anything with roles" ON public.user_roles
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Admins can view roles in their org" ON public.user_roles
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins can manage manager roles in their org" ON public.user_roles
  FOR INSERT WITH CHECK (
    role = 'manager' AND
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins can delete manager roles in their org" ON public.user_roles
  FOR DELETE USING (
    role = 'manager' AND
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Users can view own role" ON public.user_roles
  FOR SELECT USING (user_id = auth.uid());

-- 13. Update projects RLS — replace old user_id-based policies
-- Drop existing policies first (they reference user_id or is_manager)
DROP POLICY IF EXISTS "Users can view own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can insert own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can update own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can delete own projects" ON public.projects;
DROP POLICY IF EXISTS "Managers can view all projects" ON public.projects;
DROP POLICY IF EXISTS "Managers can update all projects" ON public.projects;

-- New community-scoped policies
CREATE POLICY "Super admins can do anything with projects" ON public.projects
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Admins can manage projects in their org" ON public.projects
  FOR ALL USING (
    community_id IN (
      SELECT c.id FROM public.communities c
      JOIN public.user_roles ur ON ur.organization_id = c.organization_id
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
    )
  );

CREATE POLICY "Managers can view and edit projects in their community" ON public.projects
  FOR SELECT USING (
    community_id IN (SELECT community_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
  );

CREATE POLICY "Managers can insert projects in their community" ON public.projects
  FOR INSERT WITH CHECK (
    community_id IN (SELECT community_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
  );

CREATE POLICY "Managers can update projects in their community" ON public.projects
  FOR UPDATE USING (
    community_id IN (SELECT community_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
  );

-- Managers cannot DELETE projects (per spec)

-- 14. Update related table policies (project_variants, lp_editable_content, etc.)
-- These tables reference project_id, so access follows project access
-- Drop old is_manager-based policies
DROP POLICY IF EXISTS "Managers can read all variants" ON public.project_variants;
DROP POLICY IF EXISTS "Managers can update all variants" ON public.project_variants;

CREATE POLICY "Roles can access variants via project" ON public.project_variants
  FOR ALL USING (
    project_id IN (SELECT id FROM public.projects)  -- RLS on projects handles the filtering
  );

-- Same pattern for lp_editable_content, lp_image_content, analytics_events, leads
-- These already have user-level policies; add role-based ones

DROP POLICY IF EXISTS "Managers can read all images" ON public.lp_image_content;
DROP POLICY IF EXISTS "Managers can update all images" ON public.lp_image_content;

CREATE POLICY "Roles can access images via project" ON public.lp_image_content
  FOR ALL USING (
    project_id IN (SELECT id FROM public.projects)
  );

-- 15. Indexes
CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_email ON public.user_roles(email);
CREATE INDEX IF NOT EXISTS idx_user_roles_community_id ON public.user_roles(community_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_organization_id ON public.user_roles(organization_id);
CREATE INDEX IF NOT EXISTS idx_communities_organization_id ON public.communities(organization_id);
CREATE INDEX IF NOT EXISTS idx_projects_community_id ON public.projects(community_id);
