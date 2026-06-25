-- Migration: require project_id on every anonymous lead insert.
--
-- Defense-in-depth follow-up to fix_leads_rls_pii.sql. The leads SELECT exposure
-- there was reachable only because rows could exist with project_id IS NULL
-- ("ownerless" leads, which the public read policy exposed). The LP capture flow
-- always sets project_id, and the only legacy NULL rows (source='cheburashka',
-- Feb–Mar) have been deleted — verified 0 NULL-project rows remain, all 55 live
-- rows are source='lp-builder' with a project_id. So tightening the insert is safe.
--
-- There were TWO permissive anon INSERT policies (with_check=true); permissive
-- policies OR together, so BOTH must be replaced or the requirement is bypassed.
-- Consolidate to ONE policy that requires project_id IS NOT NULL.
--
-- Rollback: DROP POLICY leads_insert_anon; then recreate the two originals with
-- WITH CHECK (true).

DROP POLICY IF EXISTS "Anon can insert leads with project_id" ON public.leads;
DROP POLICY IF EXISTS "anon_insert_leads" ON public.leads;

CREATE POLICY "leads_insert_anon" ON public.leads
  FOR INSERT TO anon, authenticated
  WITH CHECK (project_id IS NOT NULL);
