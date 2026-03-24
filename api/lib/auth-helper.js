// Shared auth helper for role-based authorization
// Used by all API endpoints that need to check user roles

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Verify access token and return user object.
 * Returns { id, email } or null.
 */
export async function verifyUser(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Get user's role from user_roles table.
 * Returns { role, organization_id, community_id, email } or null.
 */
export async function getUserRole(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(userId)}&select=role,organization_id,community_id,email`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Check if a user can access a specific project.
 * - super_admin: can access all projects
 * - admin: can access projects in communities belonging to their organization
 * - manager: can access projects in their assigned community
 */
export async function canAccessProject(userId, projectId) {
  const role = await getUserRole(userId);
  if (!role) return false;
  if (role.role === "super_admin") return true;

  // Fetch project's community_id
  const projRes = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=community_id`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  const projects = await projRes.json();
  if (!projects?.length) return false;
  const projectCommunityId = projects[0].community_id;

  if (role.role === "manager") {
    return role.community_id === projectCommunityId;
  }

  if (role.role === "admin") {
    // Check if community belongs to admin's organization
    const commRes = await fetch(
      `${SUPABASE_URL}/rest/v1/communities?id=eq.${encodeURIComponent(projectCommunityId)}&select=organization_id`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const comms = await commRes.json();
    if (!comms?.length) return false;
    return comms[0].organization_id === role.organization_id;
  }

  return false;
}

/**
 * Check if user has a specific role (or higher).
 * Hierarchy: super_admin > admin > manager
 */
export function hasMinRole(userRole, requiredRole) {
  const hierarchy = { super_admin: 3, admin: 2, manager: 1 };
  return (hierarchy[userRole] || 0) >= (hierarchy[requiredRole] || 99);
}

/**
 * Standard auth + role check for API endpoints.
 * Returns { user, role } or sends error response and returns null.
 */
export async function authenticateAndAuthorize(req, res, options = {}) {
  const { access_token } = req.body || {};
  const authHeader = req.headers.authorization;
  const token = access_token || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);

  if (!token) {
    res.status(401).json({ error: "Missing access token" });
    return null;
  }

  const user = await verifyUser(token);
  if (!user) {
    res.status(401).json({ error: "Invalid access token" });
    return null;
  }

  const role = await getUserRole(user.id);
  if (!role) {
    res.status(403).json({ error: "No role assigned. Contact your admin." });
    return null;
  }

  if (options.minRole && !hasMinRole(role.role, options.minRole)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return null;
  }

  if (options.projectId) {
    const canAccess = await canAccessProject(user.id, options.projectId);
    if (!canAccess) {
      res.status(403).json({ error: "You do not have access to this project" });
      return null;
    }
  }

  return { user, role };
}
