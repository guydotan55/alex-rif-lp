// Merged admin endpoint — replaces admin-users.js, manage-communities.js,
// check-email.js and invite-user.js to stay under Vercel's 12-function limit.
//
// Routes (all POST):
//   { action: "check-email", email }              — no auth
//   { action: "list-users" }                      — admin+
//   { action: "delete-user", user_id }            — admin+
//   { action: "list-communities" }                — manager+
//   { action: "create-community", name, organization_id? } — admin+
//   { action: "update-community", id, name }      — admin+
//   { action: "delete-community", id }            — admin+
//   { action: "invite-user", email, role, community_id? }  — admin+

import { authenticateAndAuthorize, hasMinRole } from "./_lib/auth-helper.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_ORIGIN = process.env.APP_URL || "https://messaginglab-guydotan55s-projects.vercel.app";
const SB_HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { action } = req.body || {};

  switch (action) {
    case "check-email":
      return handleCheckEmail(req, res);
    case "list-users":
      return handleListUsers(req, res);
    case "delete-user":
      return handleDeleteUser(req, res);
    case "list-communities":
      return handleListCommunities(req, res);
    case "create-community":
      return handleCreateCommunity(req, res);
    case "update-community":
      return handleUpdateCommunity(req, res);
    case "delete-community":
      return handleDeleteCommunity(req, res);
    case "invite-user":
      return handleInviteUser(req, res);
    default:
      return res.status(400).json({ error: "Unknown action: " + action });
  }
}

// ── check-email (no auth) ───────────────────────────────────
async function handleCheckEmail(req, res) {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "email is required" });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
      { headers: SB_HEADERS }
    );
    const rows = await r.json();
    return res.status(200).json({ allowed: rows?.length > 0 });
  } catch (err) {
    console.error("check-email error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ── list-users (admin+) ─────────────────────────────────────
async function handleListUsers(req, res) {
  const auth = await authenticateAndAuthorize(req, res, { minRole: "admin" });
  if (!auth) return;

  try {
    let rolesUrl = `${SUPABASE_URL}/rest/v1/user_roles?select=*,communities(name),organizations(name)`;
    if (auth.role.role === "admin") {
      rolesUrl += `&organization_id=eq.${auth.role.organization_id}`;
    }

    const rolesRes = await fetch(rolesUrl, { headers: SB_HEADERS });
    const roles = await rolesRes.json();

    // Fetch project counts per community
    const projectsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?select=community_id`,
      { headers: SB_HEADERS }
    );
    const allProjects = await projectsRes.json();
    const projectCounts = {};
    (allProjects || []).forEach((p) => {
      projectCounts[p.community_id] = (projectCounts[p.community_id] || 0) + 1;
    });

    const users = (roles || []).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      email: r.email,
      role: r.role,
      community_id: r.community_id,
      community_name: r.communities?.name || null,
      organization_id: r.organization_id,
      organization_name: r.organizations?.name || null,
      projects_count: r.community_id
        ? projectCounts[r.community_id] || 0
        : null,
      created_at: r.created_at,
    }));

    return res.status(200).json({ users });
  } catch (err) {
    console.error("list-users error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ── delete-user (admin+) ────────────────────────────────────
async function handleDeleteUser(req, res) {
  const auth = await authenticateAndAuthorize(req, res, { minRole: "admin" });
  if (!auth) return;

  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "user_id is required" });

  // Don't allow deleting yourself
  if (user_id === auth.user.id) {
    return res.status(400).json({ error: "Cannot remove your own role" });
  }

  try {
    // Admins can only delete managers in their org
    if (auth.role.role === "admin") {
      const targetRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(user_id)}&select=role,organization_id`,
        { headers: SB_HEADERS }
      );
      const targets = await targetRes.json();
      if (!targets?.length)
        return res.status(404).json({ error: "User not found" });
      if (targets[0].role !== "manager")
        return res.status(403).json({ error: "Admins can only remove managers" });
      if (targets[0].organization_id !== auth.role.organization_id)
        return res.status(403).json({ error: "User is not in your organization" });
    }

    // Delete user_roles row
    await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(user_id)}`,
      { method: "DELETE", headers: SB_HEADERS }
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("delete-user error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ── list-communities (manager+) ─────────────────────────────
async function handleListCommunities(req, res) {
  const auth = await authenticateAndAuthorize(req, res, { minRole: "manager" });
  if (!auth) return;

  try {
    let url = `${SUPABASE_URL}/rest/v1/communities?select=*,organizations(name)&order=name`;
    if (auth.role.role === "admin") {
      url += `&organization_id=eq.${auth.role.organization_id}`;
    } else if (auth.role.role === "manager") {
      url += `&id=eq.${auth.role.community_id}`;
    }
    const r = await fetch(url, { headers: SB_HEADERS });
    return res.status(200).json({ communities: await r.json() });
  } catch (err) {
    console.error("list-communities error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ── create-community (admin+) ───────────────────────────────
async function handleCreateCommunity(req, res) {
  const auth = await authenticateAndAuthorize(req, res, { minRole: "admin" });
  if (!auth) return;

  const { name, organization_id } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });

  let orgId = organization_id || auth.role.organization_id;

  // Super admin has no org_id — fetch the first org as default
  if (!orgId) {
    const orgRes = await fetch(`${SUPABASE_URL}/rest/v1/organizations?select=id&limit=1`, { headers: SB_HEADERS });
    const orgs = await orgRes.json();
    orgId = orgs?.[0]?.id;
  }
  if (!orgId)
    return res.status(400).json({ error: "organization_id is required" });

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/communities`, {
      method: "POST",
      headers: {
        ...SB_HEADERS,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ name, organization_id: orgId }),
    });
    if (!r.ok)
      return res.status(500).json({ error: "Failed to create community" });
    const data = await r.json();
    return res.status(201).json({ community: data[0] || data });
  } catch (err) {
    console.error("create-community error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ── update-community (admin+) ───────────────────────────────
async function handleUpdateCommunity(req, res) {
  const auth = await authenticateAndAuthorize(req, res, { minRole: "admin" });
  if (!auth) return;

  const { id, name } = req.body || {};
  if (!id || !name)
    return res.status(400).json({ error: "id and name are required" });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/communities?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          ...SB_HEADERS,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ name, updated_at: new Date().toISOString() }),
      }
    );
    if (!r.ok)
      return res.status(500).json({ error: "Failed to update community" });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("update-community error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ── delete-community (admin+) ───────────────────────────────
async function handleDeleteCommunity(req, res) {
  const auth = await authenticateAndAuthorize(req, res, { minRole: "admin" });
  if (!auth) return;

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "id is required" });

  try {
    // Check for existing projects
    const projRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?community_id=eq.${encodeURIComponent(id)}&select=id&limit=1`,
      { headers: SB_HEADERS }
    );
    const projects = await projRes.json();
    if (projects?.length > 0) {
      return res.status(400).json({
        error:
          "Cannot delete community with existing projects. Move or delete projects first.",
      });
    }

    // Delete community
    await fetch(
      `${SUPABASE_URL}/rest/v1/communities?id=eq.${encodeURIComponent(id)}`,
      { method: "DELETE", headers: SB_HEADERS }
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("delete-community error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ── invite-user (admin+) ────────────────────────────────────
async function handleInviteUser(req, res) {
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
    return res
      .status(400)
      .json({ error: "community_id is required for manager role" });
  }

  try {
    // Verify community exists and belongs to the inviter's org
    if (community_id) {
      const commRes = await fetch(
        `${SUPABASE_URL}/rest/v1/communities?id=eq.${encodeURIComponent(community_id)}&select=id,organization_id`,
        { headers: SB_HEADERS }
      );
      const comms = await commRes.json();
      if (!comms?.length)
        return res.status(400).json({ error: "Community not found" });

      if (
        auth.role.role === "admin" &&
        comms[0].organization_id !== auth.role.organization_id
      ) {
        return res
          .status(403)
          .json({ error: "Community is not in your organization" });
      }
    }

    // Check if user already has a role
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?email=eq.${encodeURIComponent(email)}&select=id`,
      { headers: SB_HEADERS }
    );
    const existing = await existingRes.json();
    if (existing?.length > 0) {
      return res
        .status(400)
        .json({ error: "User already has a role assigned" });
    }

    // Check if user already exists in auth.users (e.g. previously removed from a community)
    let newUser;
    let existingAuthUser = null;
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/get_user_id_by_email`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...SB_HEADERS },
        body: JSON.stringify({ lookup_email: email }),
      }
    );
    if (lookupRes.ok) {
      const lookupData = await lookupRes.json();
      if (lookupData) {
        existingAuthUser = { id: lookupData };
      }
    }

    if (existingAuthUser) {
      // User exists in auth.users — reuse their ID
      newUser = existingAuthUser;
    } else {
      // Invite user via Supabase Admin API (creates auth.users row + sends invite email)
      const inviteRes = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...SB_HEADERS },
        body: JSON.stringify({ email }),
      });

      if (inviteRes.ok) {
        newUser = await inviteRes.json();
      } else {
        // Fallback: create user directly
        const createRes = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...SB_HEADERS },
            body: JSON.stringify({ email, email_confirm: false }),
          }
        );
        if (!createRes.ok) {
          const err = await createRes.json();
          return res
            .status(400)
            .json({ error: err.msg || err.message || "Failed to invite user" });
        }
        newUser = await createRes.json();
      }
    }

    // Resolve organization_id for the new role
    let orgIdForRole = auth.role.organization_id;

    // Super admin has no org — resolve from community or fetch default
    if (!orgIdForRole) {
      if (community_id) {
        const commRes = await fetch(
          `${SUPABASE_URL}/rest/v1/communities?id=eq.${encodeURIComponent(community_id)}&select=organization_id`,
          { headers: SB_HEADERS }
        );
        const comms = await commRes.json();
        orgIdForRole = comms?.[0]?.organization_id;
      }
      if (!orgIdForRole) {
        const orgRes = await fetch(`${SUPABASE_URL}/rest/v1/organizations?select=id&limit=1`, { headers: SB_HEADERS });
        const orgs = await orgRes.json();
        orgIdForRole = orgs?.[0]?.id;
      }
    }

    const roleRow = {
      user_id: newUser.id,
      email,
      role,
      organization_id: orgIdForRole || null,
      community_id: role === "manager" ? community_id : null,
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/user_roles`, {
      method: "POST",
      headers: {
        ...SB_HEADERS,
        "Content-Type": "application/json",
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
        ...SB_HEADERS,
        "Content-Type": "application/json",
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
