-- Migration: give the leads table columns for the contact fields LP forms collect.
--
-- Bug: when an LP form had a phone input (name="phone"/type="tel"), the capture
-- code (api/_lib/lp-renderer.js) sent `phone` (and a legacy `name`) to the leads
-- table — but those columns did not exist. PostgREST rejected every such insert,
-- so any lead who typed a phone number was silently dropped (the row never
-- persisted, yet the lead_captured analytics event still fired — inflating the
-- dashboard's lead counter above the real leads table).
--
-- NOTE: the generator (api/generate-lp.js) currently only MANDATES an email input
-- (name="email"). phone capture already worked wherever a name="phone"/type="tel"
-- input happened to be generated. first_name/last_name are NEW dedicated columns
-- and will stay NULL on already-generated forms until the generator prompt is
-- extended to emit those names; any unrecognised named field is still preserved
-- in `metadata` either way.
--
-- Fix: add dedicated columns for the common contact fields, plus a `metadata`
-- jsonb catch-all so the customer can collect arbitrary extra form fields in
-- the future WITHOUT another schema change (not surfaced in the UI by default,
-- just persisted). All additive + nullable → safe for the live leads table.

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS last_name  TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS phone      TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS metadata   JSONB NOT NULL DEFAULT '{}'::jsonb;
