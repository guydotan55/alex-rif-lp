-- Migration: cap the size of leads.metadata written via the public anon key.
--
-- metadata is a forward-compatible jsonb catch-all filled from arbitrary named form
-- fields. Since the anon key is embedded in every /lp page, a scripted client could
-- stuff a huge blob in there. A DB-side CHECK is the only effective control (a
-- client-side trim is bypassable). 20 KB is ~200x the current largest row (99 bytes,
-- avg 13) — far above any legitimate form, so it can never block a real lead, while
-- stopping MB-scale abuse.
--
-- Scope note: analytics_events.event_data (the other anon-writable jsonb, written by
-- trackEvent) is intentionally NOT capped here — its payloads are bounded, fixed-shape
-- (visitor_id, url, user_agent, email), not a user-controlled free-text catch-all. Revisit
-- if that table ever stores arbitrary input.
--
-- Rollback: ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_metadata_size;

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_metadata_size;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_metadata_size CHECK (octet_length(metadata::text) <= 20000);
