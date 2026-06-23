-- Per-project Meta Pixel support.
-- A project can override the global META_PIXEL_ID; CAPI tokens are stored
-- server-side only (RLS-locked) and never exposed to the browser.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS meta_pixel_id text;

COMMENT ON COLUMN projects.meta_pixel_id IS
  'Optional per-project Meta Pixel ID. NULL = fall back to the global META_PIXEL_ID env var. Public value (rendered into LP HTML).';

CREATE TABLE IF NOT EXISTS meta_capi_tokens (
  pixel_id   text PRIMARY KEY,
  token      text NOT NULL,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE meta_capi_tokens IS
  'Server-only Meta Conversions API access tokens, keyed by Pixel ID. RLS denies all client roles; only the service role (server) reads it. NEVER select from the browser/anon key.';

-- Lock it down: enable RLS with no policies => anon/authenticated get nothing.
-- The service role bypasses RLS, so server-side reads in send-email.js still work.
ALTER TABLE meta_capi_tokens ENABLE ROW LEVEL SECURITY;

-- Token values are inserted out-of-band (not in this migration) so secrets
-- never land in git. See ops notes / runbook.

-- Expose the new column to PostgREST immediately (matches what was applied live).
NOTIFY pgrst, 'reload schema';
