// POST /api/invite-user
// Body: { email, role, community_id?, organization_id? }
// Authorization: Bearer <access_token>
import { authenticateAndAuthorize, hasMinRole } from "./lib/auth-helper.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Auth: must be at least admin to invite
    const auth = await authenticateAndAuthorize(req, res, { minRole: "admin" });
    if (!auth) return;

    const { email, role, community_id } = req.body || {};
    if (!email || !role) {
      return res.status(400).json({ error: "email and role are required" });
    }

    // Validate role
    if (!["admin", "manager"].includes(role)) {
      return res.status(400).json({ error: "Role must be admin or manager" });
    }

    // Admins can only invite managers
    if (auth.role.role === "admin" && role !== "manager") {
      return res.status(403).json({ error: "Admins can only invite managers" });
    }

    // Manager role requires community_id
    if (role === "manager" && !community_id) {
      return res.status(400).json({ error: "community_id is required for manager role" });
    }

    // Verify community exists and belongs to the inviter's org
    if (community_id) {
      const commRes = await fetch(
        `${SUPABASE_URL}/rest/v1/communities?id=eq.${encodeURIComponent(community_id)}&select=id,organization_id`,
        { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const comms = await commRes.json();
      if (!comms?.length) return res.status(400).json({ error: "Community not found" });

      // Admin must be in the same org as the community
      if (auth.role.role === "admin" && comms[0].organization_id !== auth.role.organization_id) {
        return res.status(403).json({ error: "Community is not in your organization" });
      }
    }

    // Check if user already has a role
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?email=eq.${encodeURIComponent(email)}&select=id`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const existing = await existingRes.json();
    if (existing?.length > 0) {
      return res.status(400).json({ error: "User already has a role assigned" });
    }

    // Invite user via Supabase Admin API (creates auth.users row + sends invite email)
    const inviteRes = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ email }),
    });

    let newUser;
    if (inviteRes.ok) {
      newUser = await inviteRes.json();
    } else {
      // Fallback: create user directly
      const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ email, email_confirm: false }),
      });
      if (!createRes.ok) {
        const err = await createRes.json();
        return res.status(400).json({ error: err.msg || err.message || "Failed to invite user" });
      }
      newUser = await createRes.json();
    }

    // Create user_roles row
    const organization_id = auth.role.organization_id || auth.role.role === "super_admin"
      ? (community_id ? (await fetch(
          `${SUPABASE_URL}/rest/v1/communities?id=eq.${encodeURIComponent(community_id)}&select=organization_id`,
          { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
        ).then(r => r.json()).then(c => c[0]?.organization_id)) : null)
      : auth.role.organization_id;

    const roleRow = {
      user_id: newUser.id,
      email,
      role,
      organization_id: role === "admin" ? organization_id : (organization_id || null),
      community_id: role === "manager" ? community_id : null,
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/user_roles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(roleRow),
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error("Role insert failed:", err);
      return res.status(500).json({ error: "Failed to assign role" });
    }

    // Also create/update user_profiles for basic info
    await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ user_id: newUser.id, email }),
    });

    return res.status(200).json({
      success: true,
      user: { id: newUser.id, email, role, community_id },
    });
  } catch (err) {
    console.error("invite-user error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
