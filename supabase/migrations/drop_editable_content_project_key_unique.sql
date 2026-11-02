-- The legacy pre-variants constraint blocks per-variant text rows.
-- Prerequisite: Task 1 must be deployed to production first.
-- applied manually by the main session after user confirmation
ALTER TABLE public.lp_editable_content
  DROP CONSTRAINT IF EXISTS lp_editable_content_project_id_key_key;
