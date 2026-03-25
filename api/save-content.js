// Vercel Serverless Function — save editable text content for an LP variant
import { authenticateAndAuthorize } from "./lib/auth-helper.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SB_HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "resolution=merge-duplicates",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { project_id, variant_id, items } = req.body || {};

  if (!project_id || !variant_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Missing project_id, variant_id, or items" });
  }

  // Auth + project access check
  const auth = await authenticateAndAuthorize(req, res, { projectId: project_id });
  if (!auth) return;

  // Build upsert rows
  const rows = items.map(({ key, value }) => ({
    project_id,
    variant_id,
    key,
    value,
  }));

  // Upsert via PostgREST with service_role key
  const upsertRes = await fetch(
    `${SUPABASE_URL}/rest/v1/lp_editable_content?on_conflict=variant_id,key`,
    {
      method: "POST",
      headers: SB_HEADERS,
      body: JSON.stringify(rows),
    }
  );

  if (!upsertRes.ok) {
    const err = await upsertRes.text();
    console.error("save-content upsert error:", err);
    return res.status(500).json({ error: "Failed to save content" });
  }

  return res.status(200).json({ ok: true });
}
