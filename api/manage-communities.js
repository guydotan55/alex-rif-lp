// GET    /api/manage-communities — list communities (scoped by role)
// POST   /api/manage-communities — create community { name, organization_id }
// PATCH  /api/manage-communities — update community { id, name }
// DELETE /api/manage-communities — delete community { id }
import { authenticateAndAuthorize } from "./lib/auth-helper.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const minRole = req.method === "GET" ? "manager" : "admin";
  const auth = await authenticateAndAuthorize(req, res, { minRole });
  if (!auth) return;

  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  try {
    if (req.method === "GET") {
      let url = `${SUPABASE_URL}/rest/v1/communities?select=*,organizations(name)&order=name`;
      if (auth.role.role === "admin") {
        url += `&organization_id=eq.${auth.role.organization_id}`;
      } else if (auth.role.role === "manager") {
        url += `&id=eq.${auth.role.community_id}`;
      }
      const r = await fetch(url, { headers });
      return res.status(200).json({ communities: await r.json() });
    }

    if (req.method === "POST") {
      const { name, organization_id } = req.body || {};
      if (!name) return res.status(400).json({ error: "name is required" });

      const orgId = organization_id || auth.role.organization_id;
      if (!orgId) return res.status(400).json({ error: "organization_id is required" });

      const r = await fetch(`${SUPABASE_URL}/rest/v1/communities`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ name, organization_id: orgId }),
      });
      if (!r.ok) return res.status(500).json({ error: "Failed to create community" });
      const data = await r.json();
      return res.status(201).json({ community: data[0] || data });
    }

    if (req.method === "PATCH") {
      const { id, name } = req.body || {};
      if (!id || !name) return res.status(400).json({ error: "id and name are required" });

      const r = await fetch(`${SUPABASE_URL}/rest/v1/communities?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ name, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(500).json({ error: "Failed to update community" });
      return res.status(200).json({ success: true });
    }

    if (req.method === "DELETE") {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: "id is required" });

      // Check for existing projects
      const projRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?community_id=eq.${encodeURIComponent(id)}&select=id&limit=1`,
        { headers }
      );
      const projects = await projRes.json();
      if (projects?.length > 0) {
        return res.status(400).json({ error: "Cannot delete community with existing projects. Move or delete projects first." });
      }

      // Delete community
      await fetch(`${SUPABASE_URL}/rest/v1/communities?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE", headers,
      });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("manage-communities error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
