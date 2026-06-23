-- Feedback v2: user-set urgency, "mark the spot" target, and image attachments
-- (screenshot + uploaded image). Additive to add_feedback_tickets.sql.
-- Safe to re-run.

-- 1) New columns on the ticket -------------------------------------------------
ALTER TABLE public.feedback_tickets
  ADD COLUMN IF NOT EXISTS user_urgency text
    CHECK (user_urgency IS NULL OR user_urgency IN ('blocking','annoying')),
  ADD COLUMN IF NOT EXISTS page_target  text;   -- short description of the clicked element

-- 2) Attachments table ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.feedback_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES public.feedback_tickets(id) ON DELETE CASCADE,
  storage_path text NOT NULL,                    -- path inside the feedback-attachments bucket
  kind         text NOT NULL CHECK (kind IN ('screenshot','image')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_attachments_ticket ON public.feedback_attachments (ticket_id);

ALTER TABLE public.feedback_attachments ENABLE ROW LEVEL SECURITY;

-- Only super_admin reads attachment rows (the inbox). Inserts are service-role
-- only (server), so no insert-own policy — mirrors feedback_tickets.
DROP POLICY IF EXISTS "feedback_attachments_super_admin_all" ON public.feedback_attachments;
CREATE POLICY "feedback_attachments_super_admin_all" ON public.feedback_attachments
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );

-- 3) Private storage bucket ----------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('feedback-attachments', 'feedback-attachments', false, 5242880,
        ARRAY['image/png','image/jpeg','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Authenticated users may upload ONLY into their own "{auth.uid()}/" folder.
DROP POLICY IF EXISTS "feedback_attach_insert_own" ON storage.objects;
CREATE POLICY "feedback_attach_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'feedback-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- super_admin may read every object (needed to mint signed URLs in the inbox).
DROP POLICY IF EXISTS "feedback_attach_read_admin" ON storage.objects;
CREATE POLICY "feedback_attach_read_admin" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'feedback-attachments'
    AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );
