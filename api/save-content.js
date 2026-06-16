// Vercel Serverless Function — load and save editable text content for an LP variant
import { authenticateAndAuthorize } from "./_lib/auth-helper.js";
import { isWriteBackRequest, shouldWriteBack } from "./_lib/write-back.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SB_HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

export default async function handler(req, res) {
  // GET: load editable content for a variant or project
  if (req.method === "GET") {
    const { project_id, variant_id } = req.query;
    if (!project_id) {
      return res.status(400).json({ error: "Missing project_id" });
    }

    // Auth + project access check
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Missing access token" });

    const auth = await authenticateAndAuthorize(req, res, { projectId: project_id });
    if (!auth) return;

    // Build query filter
    let filter = variant_id
      ? `variant_id=eq.${encodeURIComponent(variant_id)}`
      : `project_id=eq.${encodeURIComponent(project_id)}`;

    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_editable_content?${filter}&select=*&order=key`,
      { headers: SB_HEADERS }
    );

    if (!fetchRes.ok) {
      const err = await fetchRes.text();
      console.error("load-content fetch error:", err);
      return res.status(500).json({ error: "Failed to load content" });
    }

    const data = await fetchRes.json();
    return res.status(200).json(data);
  }

  // POST: save editable content
  if (req.method === "POST") {
    const { project_id, variant_id, items, healed_html } = req.body || {};

    // --- One-time healed-HTML write-back (Task 2B) ---
    // The editor sends { variant_id, healed_html } once, after auto-hooking an
    // un-hooked single-event LP. Authenticate the same way, then PATCH
    // project_variants.generated_html ONCE — but only if it actually changed.
    if (isWriteBackRequest(req.body || {})) {
      if (!project_id) {
        return res.status(400).json({ error: "Missing project_id" });
      }
      const auth = await authenticateAndAuthorize(req, res, { projectId: project_id });
      if (!auth) return; // sends 401/403 itself

      // Read the currently stored HTML so we can no-op on equality.
      const storedRes = await fetch(
        `${SUPABASE_URL}/rest/v1/project_variants?id=eq.${encodeURIComponent(variant_id)}&select=generated_html&limit=1`,
        { headers: SB_HEADERS }
      );
      if (!storedRes.ok) {
        const err = await storedRes.text();
        console.error("write-back fetch error:", storedRes.status, err);
        return res.status(500).json({ error: "Failed to load variant for write-back" });
      }
      const rows = await storedRes.json();
      if (!rows.length) {
        return res.status(404).json({ error: "Variant not found" });
      }
      const stored = rows[0].generated_html;

      if (!shouldWriteBack(stored, healed_html)) {
        return res.status(200).json({ ok: true, written: false, reason: "no-op" });
      }

      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/project_variants?id=eq.${encodeURIComponent(variant_id)}`,
        {
          method: "PATCH",
          headers: { ...SB_HEADERS, Prefer: "return=minimal" },
          body: JSON.stringify({ generated_html: healed_html }),
        }
      );
      if (!patchRes.ok) {
        const err = await patchRes.text();
        console.error("write-back PATCH error:", patchRes.status, err);
        return res.status(500).json({ error: "Failed to write back healed HTML" });
      }
      return res.status(200).json({ ok: true, written: true });
    }

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
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(rows),
      }
    );

    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      console.error("save-content upsert error:", upsertRes.status, err);
      return res.status(500).json({ error: "Failed to save content", detail: err });
    }

    // Verify the save by reading back
    const verifyFilter = `variant_id=eq.${encodeURIComponent(variant_id)}`;
    const verifyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_editable_content?${verifyFilter}&select=key,value&order=key`,
      { headers: SB_HEADERS }
    );
    const saved = verifyRes.ok ? await verifyRes.json() : [];

    return res.status(200).json({ ok: true, saved_count: saved.length });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
