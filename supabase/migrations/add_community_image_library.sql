-- Community Image Library: stores images users have applied or saved
CREATE TABLE public.community_image_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES public.communities(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  source TEXT NOT NULL,
  source_meta JSONB DEFAULT '{}',
  added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (community_id, image_url)
);

-- Index for fast lookups
CREATE INDEX idx_community_image_library_community ON public.community_image_library(community_id);

-- Enable RLS
ALTER TABLE public.community_image_library ENABLE ROW LEVEL SECURITY;

-- Super admins: full access
CREATE POLICY "Super admins full access to image library"
  ON public.community_image_library FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'super_admin'
  ));

-- Admins: access images in their org's communities
CREATE POLICY "Admins access image library in their org"
  ON public.community_image_library FOR ALL
  USING (community_id IN (
    SELECT c.id FROM public.communities c
    JOIN public.user_roles ur ON ur.organization_id = c.organization_id
    WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
  ));

-- Managers: access images in their community
CREATE POLICY "Managers access image library in their community"
  ON public.community_image_library FOR ALL
  USING (community_id IN (
    SELECT community_id FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'manager'
  ));
