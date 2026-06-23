-- Feedback v3: technical info for debugging (browser/OS, screen+window size, etc.)
-- stored as a flexible JSON blob alongside the existing server-stamped app_version.
-- Additive, safe to re-run.

ALTER TABLE public.feedback_tickets
  ADD COLUMN IF NOT EXISTS client_info jsonb;   -- { ua, viewport, screen, dpr, lang, platform }
