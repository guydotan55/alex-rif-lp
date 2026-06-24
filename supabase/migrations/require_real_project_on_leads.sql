-- Migration: anon lead inserts must reference a REAL project (not just a non-null id).
--
-- Strengthens require_project_id_on_leads.sql. That stopped "ownerless" (NULL) leads,
-- but an anon caller could still insert a lead with any random non-null UUID, poisoning
-- a nonexistent/arbitrary project's lead count.
--
-- We can't do `EXISTS (SELECT 1 FROM projects ...)` directly in the policy: WITH CHECK
-- runs AS the anon role, and anon has NO SELECT access to projects (verified: anon reads
-- 0 rows), so the subquery would return false for EVERY project and block ALL capture.
-- Instead use a SECURITY DEFINER function that validates existence with RLS bypassed.
--
-- Note: this only blocks FABRICATED project ids. An anonymous public form inherently
-- can't be restricted to "the owning project" — project_id comes from the page — so
-- existence is the strongest reasonable check for anon inserts.
--
-- Rollback: recreate leads_insert_anon WITH CHECK (project_id IS NOT NULL) and
-- DROP FUNCTION public.lead_project_exists(uuid).

CREATE OR REPLACE FUNCTION public.lead_project_exists(pid uuid)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
  STABLE
AS $$
  SELECT pid IS NOT NULL AND EXISTS (SELECT 1 FROM public.projects WHERE id = pid);
$$;

REVOKE ALL ON FUNCTION public.lead_project_exists(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.lead_project_exists(uuid) TO anon, authenticated;

DROP POLICY IF EXISTS "leads_insert_anon" ON public.leads;
CREATE POLICY "leads_insert_anon" ON public.leads
  FOR INSERT TO anon, authenticated
  WITH CHECK (public.lead_project_exists(project_id));
