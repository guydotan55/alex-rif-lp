// GET    /api/admin-users — returns all users with roles + communities
// DELETE /api/admin-users — remove a user's role { user_id }
import { authenticateAndAuthorize } from "./lib/auth-helper.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = await authenticateAndAuthorize(req, res, { minRole: "admin" });
  if (!auth) return;

  try {
    if (req.method === "GET") {
      // Fetch all user_roles (scoped to admin's org or all for super_admin)
      let rolesUrl = `${SUPABASE_URL}/rest/v1/user_roles?select=*,communities(name),organizations(name)`;
      if (auth.role.role === "admin") {
        rolesUrl += `&organization_id=eq.${auth.role.organization_id}`;
      }

      const rolesRes = await fetch(rolesUrl, {
        headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      });
      const roles = await rolesRes.json();

      // Fetch project counts per community
      const projectsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?select=community_id`,
        { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const allProjects = await projectsRes.json();
      const projectCounts = {};
      (allProjects || []).forEach(p => {
        projectCounts[p.community_id] = (projectCounts[p.community_id] || 0) + 1;
      });

      const users = (roles || []).map(r => ({
        id: r.id,
        user_id: r.user_id,
        email: r.email,
        role: r.role,
        community_id: r.community_id,
        community_name: r.communities?.name || null,
        organization_id: r.organization_id,
        organization_name: r.organizations?.name || null,
        projects_count: r.community_id ? (projectCounts[r.community_id] || 0) : null,
        created_at: r.created_at,
      }));

      return res.status(200).json({ users });
    }

    if (req.method === "DELETE") {
      const { user_id } = req.body || {};
      if (!user_id) return res.status(400).json({ error: "user_id is required" });

      // Don't allow deleting yourself
      if (user_id === auth.user.id) {
        return res.status(400).json({ error: "Cannot remove your own role" });
      }

      // Admins can only delete managers in their org
      if (auth.role.role === "admin") {
        const targetRes = await fetch(
          `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(user_id)}&select=role,organization_id`,
          { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
        );
        const targets = await targetRes.json();
        if (!targets?.length) return res.status(404).json({ error: "User not found" });
        if (targets[0].role !== "manager") return res.status(403).json({ error: "Admins can only remove managers" });
        if (targets[0].organization_id !== auth.role.organization_id) return res.status(403).json({ error: "User is not in your organization" });
      }

      // Delete user_roles row
      await fetch(
        `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(user_id)}`,
        {
          method: "DELETE",
          headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        }
      );

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("admin-users error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
