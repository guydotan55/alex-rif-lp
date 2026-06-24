-- Migration: close the leads SELECT/PII exposure.  *** REVIEW BEFORE APPLYING ***
--
-- Problem (verified on live DB uaspcafukqvgiztzdnfu):
--   The leads table had two over-permissive SELECT policies:
--     1. "Users can read leads for own projects" (role public) USING
--        (project_id IS NULL OR project_id IN own-projects) — lets the PUBLIC anon
--        key (embedded in every /lp page) read ANY row with project_id IS NULL.
--        4 such rows exist today and are world-readable.
--     2. "auth_select_leads" (role authenticated) USING (true) — lets ANY logged-in
--        user read EVERY tenant's leads (cross-tenant read once there is >1 NGO).
--   The dropped-leads fix newly stores phone/first_name/last_name PII in this table,
--   so both holes now expose real contact PII.
--
-- Fix: drop both, replace with a single scoped SELECT policy that mirrors project
-- visibility — super_admins see all; owners see their own projects' leads;
-- managers/admins see leads for projects in their community (org-wide role =
-- NULL community = all). anon gets NO select policy => cannot read leads at all.
--
-- INSERT policies are intentionally left UNTOUCHED so lead capture cannot break.
--
-- Simulated against live data BEFORE applying (counts of leads visible per user):
--   super_admin guydospam55 / libby .......... 59 / 59  (dashboard unchanged)
--   manager maayan, admins matan/or/yaara ..... 55 / 59  (their community only)
--   ANON ....................................... 0 / 59  (exposure closed)
--   The 4 rows hidden from non-super-admins are exactly the project_id-NULL leak rows.
--
-- Rollback: DROP POLICY leads_select_scoped; then recreate the two original policies.

DROP POLICY IF EXISTS "auth_select_leads" ON public.leads;
DROP POLICY IF EXISTS "Users can read leads for own projects" ON public.leads;

CREATE POLICY "leads_select_scoped" ON public.leads
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'super_admin'
    )
    OR EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = leads.project_id
        AND (
          p.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('manager', 'admin')
              AND (ur.community_id = p.community_id OR ur.community_id IS NULL)
          )
        )
    )
  );

-- ---------------------------------------------------------------------------
-- OPTIONAL defense-in-depth (NOT enabled by default — discuss before applying).
-- Each carries a small risk of breaking an unknown insert path, so left commented.
--
-- a) Require project_id on new anonymous inserts so no future row can become the
--    "project_id IS NULL" world-readable kind (the LP flow always sets project_id;
--    the 4 legacy NULL rows came from source='cheburashka', a different/old path):
-- DROP POLICY IF EXISTS "Anon can insert leads with project_id" ON public.leads;
-- DROP POLICY IF EXISTS "anon_insert_leads" ON public.leads;
-- CREATE POLICY "leads_insert_anon" ON public.leads
--   FOR INSERT TO anon, authenticated
--   WITH CHECK (project_id IS NOT NULL);
--
-- b) Cap metadata size so the public anon key can't write huge JSONB blobs:
-- ALTER TABLE public.leads
--   ADD CONSTRAINT leads_metadata_size CHECK (pg_column_size(metadata) <= 8192);
-- ---------------------------------------------------------------------------
