# Organization, Roles & Communities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-tenant hierarchy (Organizations → Communities → Projects → LPs) with three user roles (super_admin, admin, manager) and invite-only auth.

**Architecture:** New DB tables for organizations, communities, and user_roles replace the current `is_manager` boolean. A shared auth helper module provides role-checking functions used by all API endpoints. The dashboard adapts its UI based on the user's role — managers see their community, admins see all communities with a filter, super admin sees everything. Invite-only access with magic link auth.

**Tech Stack:** Supabase (PostgreSQL + Auth + Storage), Vercel Serverless Functions, vanilla JS frontend, Anthropic Claude API.

**Spec:** `docs/superpowers/specs/2026-03-24-org-roles-communities-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `supabase/migrations/add_org_roles_communities.sql` | DB migration: organizations, communities, user_roles tables + projects changes + RLS + indexes + data backfill |
| `api/lib/auth-helper.js` | Shared auth utility: getUserRole(), canAccessProject(), requireRole() |
| `api/manage-communities.js` | CRUD endpoint for communities (admin/super_admin only) |
| `settings.html` | Settings page: manage communities + users (admin/super_admin only) |

### Modified Files
| File | What Changes |
|------|-------------|
| `api/invite-user.js` | Rewrite: role-based invites with community assignment, check user_roles instead of is_manager |
| `api/admin-users.js` | Rewrite: return users with roles + communities, support role/community assignment |
| `api/generate-lp.js` | Replace `user.id !== project.user_id` with role-based auth via auth-helper |
| `api/resolve-images.js` | Same auth update |
| `api/image-directions.js` | Same auth update |
| `api/apply-image.js` | Same auth update |
| `dashboard.html` | Replace `isManager` with `userRole` object, community filter, role-based UI, link to settings |
| `new.html` | Add community selector (admin) or auto-assign (manager), add test_assumptions field, check user_roles before magic link |
| `index.html` | Update redirect logic |

---

## IMPORTANT NOTES FOR IMPLEMENTERS

1. **Dashboard Supabase client:** `sb` (not `supabase`)
2. **API endpoints use `SUPABASE_SERVICE_ROLE_KEY`** — bypasses RLS. Auth is in application code.
3. **Existing `user_id` on projects:** Keep as "created_by" for audit. Access is by `community_id` + role.
4. **Current `isManager` in dashboard.html:** Line 1413. Set from `user_profiles` at lines 1425-1436. Used for filtering at lines 1450-1459.
5. **Current invite flow in `api/invite-user.js`:** Uses `is_manager` boolean. Must be rewritten for roles.
6. **Super admin email:** Will need to be configured during migration (your email).

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/add_org_roles_communities.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Migration: Add organizations, communities, user_roles
-- and modify projects for multi-tenant hierarchy

-- 1. Create organizations table
CREATE TABLE IF NOT EXISTS public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Create communities table
CREATE TABLE IF NOT EXISTS public.communities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Create user_roles table
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'manager')),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  community_id UUID REFERENCES public.communities(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

-- 4. Add community_id and test_assumptions to projects (nullable initially)
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS community_id UUID REFERENCES public.communities(id) ON DELETE RESTRICT;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS test_assumptions JSONB DEFAULT '[]';

-- 5. Seed: Create "Bavua" organization and "Default" community
INSERT INTO public.organizations (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Bavua')
ON CONFLICT DO NOTHING;

INSERT INTO public.communities (id, organization_id, name)
VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Default')
ON CONFLICT DO NOTHING;

-- 6. Backfill: assign all existing projects to Default community
UPDATE public.projects
SET community_id = '00000000-0000-0000-0000-000000000002'
WHERE community_id IS NULL;

-- 7. Make community_id NOT NULL now that all rows are backfilled
ALTER TABLE public.projects
  ALTER COLUMN community_id SET NOT NULL;

-- 8. Migrate user_profiles.is_manager to user_roles
-- is_manager = true -> admin under Bavua
INSERT INTO public.user_roles (user_id, email, role, organization_id)
SELECT up.user_id, up.email, 'admin', '00000000-0000-0000-0000-000000000001'
FROM public.user_profiles up
WHERE up.is_manager = true
ON CONFLICT (user_id) DO NOTHING;

-- is_manager = false -> manager of Default community (preserves access)
INSERT INTO public.user_roles (user_id, email, role, organization_id, community_id)
SELECT up.user_id, up.email, 'manager', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'
FROM public.user_profiles up
WHERE up.is_manager = false OR up.is_manager IS NULL
ON CONFLICT (user_id) DO NOTHING;

-- 9. Drop is_manager from user_profiles
ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS is_manager;

-- 10. RLS for organizations
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admins can do anything with orgs" ON public.organizations
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Admins can view their org" ON public.organizations
  FOR SELECT USING (
    id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

-- 11. RLS for communities
ALTER TABLE public.communities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admins can do anything with communities" ON public.communities
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Admins can manage communities in their org" ON public.communities
  FOR ALL USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Managers can view their community" ON public.communities
  FOR SELECT USING (
    id IN (SELECT community_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
  );

-- 12. RLS for user_roles
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admins can do anything with roles" ON public.user_roles
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Admins can view roles in their org" ON public.user_roles
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins can manage manager roles in their org" ON public.user_roles
  FOR INSERT WITH CHECK (
    role = 'manager' AND
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins can delete manager roles in their org" ON public.user_roles
  FOR DELETE USING (
    role = 'manager' AND
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Users can view own role" ON public.user_roles
  FOR SELECT USING (user_id = auth.uid());

-- 13. Update projects RLS — replace old user_id-based policies
-- Drop existing policies first (they reference user_id or is_manager)
DROP POLICY IF EXISTS "Users can view own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can insert own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can update own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can delete own projects" ON public.projects;
DROP POLICY IF EXISTS "Managers can view all projects" ON public.projects;
DROP POLICY IF EXISTS "Managers can update all projects" ON public.projects;

-- New community-scoped policies
CREATE POLICY "Super admins can do anything with projects" ON public.projects
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Admins can manage projects in their org" ON public.projects
  FOR ALL USING (
    community_id IN (
      SELECT c.id FROM public.communities c
      JOIN public.user_roles ur ON ur.organization_id = c.organization_id
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
    )
  );

CREATE POLICY "Managers can view and edit projects in their community" ON public.projects
  FOR SELECT USING (
    community_id IN (SELECT community_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
  );

CREATE POLICY "Managers can insert projects in their community" ON public.projects
  FOR INSERT WITH CHECK (
    community_id IN (SELECT community_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
  );

CREATE POLICY "Managers can update projects in their community" ON public.projects
  FOR UPDATE USING (
    community_id IN (SELECT community_id FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
  );

-- Managers cannot DELETE projects (per spec)

-- 14. Update related table policies (project_variants, lp_editable_content, etc.)
-- These tables reference project_id, so access follows project access
-- Drop old is_manager-based policies
DROP POLICY IF EXISTS "Managers can read all variants" ON public.project_variants;
DROP POLICY IF EXISTS "Managers can update all variants" ON public.project_variants;

CREATE POLICY "Roles can access variants via project" ON public.project_variants
  FOR ALL USING (
    project_id IN (SELECT id FROM public.projects)  -- RLS on projects handles the filtering
  );

-- Same pattern for lp_editable_content, lp_image_content, analytics_events, leads
-- These already have user-level policies; add role-based ones

DROP POLICY IF EXISTS "Managers can read all images" ON public.lp_image_content;
DROP POLICY IF EXISTS "Managers can update all images" ON public.lp_image_content;

CREATE POLICY "Roles can access images via project" ON public.lp_image_content
  FOR ALL USING (
    project_id IN (SELECT id FROM public.projects)
  );

-- 15. Indexes
CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_email ON public.user_roles(email);
CREATE INDEX IF NOT EXISTS idx_user_roles_community_id ON public.user_roles(community_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_organization_id ON public.user_roles(organization_id);
CREATE INDEX IF NOT EXISTS idx_communities_organization_id ON public.communities(organization_id);
CREATE INDEX IF NOT EXISTS idx_projects_community_id ON public.projects(community_id);
```

- [ ] **Step 2: Run migration via Supabase MCP or SQL editor**

Verify after running:
- `organizations` table exists with "Bavua" row
- `communities` table exists with "Default" row
- `user_roles` table exists with migrated users
- `projects` table has `community_id` (NOT NULL) and `test_assumptions` columns
- All existing projects have `community_id` set to Default community
- `user_profiles` no longer has `is_manager` column

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/add_org_roles_communities.sql
git commit -m "feat: add organizations, communities, user_roles tables with migration"
```

---

## Task 2: Shared Auth Helper (`api/lib/auth-helper.js`)

**Files:**
- Create: `api/lib/auth-helper.js`

**Context:** Every API endpoint needs role-based auth. Instead of duplicating logic, create a shared module. All endpoints use `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS), so auth is in application code.

- [ ] **Step 1: Create the auth helper**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add api/lib/auth-helper.js
git commit -m "feat: add shared auth helper for role-based authorization"
```

---

## Task 3: Update API Endpoints for Role-Based Auth

**Files:**
- Modify: `api/generate-lp.js`
- Modify: `api/resolve-images.js`
- Modify: `api/image-directions.js`
- Modify: `api/apply-image.js`

**Context:** All these endpoints currently check `user.id !== project.user_id`. Replace with `canAccessProject()` from the auth helper.

- [ ] **Step 1: Update `generate-lp.js`**

At the top of the file, add import:
```javascript
import { verifyUser, canAccessProject, getUserRole } from "./lib/auth-helper.js";
```

Replace the auth check block (around lines 240-253, where it fetches user and checks `user.id !== project.user_id`) with:
```javascript
    // Verify user and check access
    const user = await verifyUser(access_token);
    if (!user) return res.status(401).json({ error: "Invalid token" });

    const hasAccess = await canAccessProject(user.id, project_id);
    if (!hasAccess) return res.status(403).json({ error: "You do not have access to this project" });
```

Remove the old `userRes` fetch and `user.id !== project.user_id` check.

- [ ] **Step 2: Update `resolve-images.js`**

Same pattern — add import, replace the auth section:
```javascript
import { verifyUser, canAccessProject } from "./lib/auth-helper.js";
```

Replace the user verification + ownership check with:
```javascript
    const user = await verifyUser(access_token);
    if (!user) return res.status(401).json({ error: "Invalid token" });

    const hasAccess = await canAccessProject(user.id, project_id);
    if (!hasAccess) return res.status(403).json({ error: "Forbidden" });
```

- [ ] **Step 3: Update `image-directions.js`**

Same pattern as resolve-images.

- [ ] **Step 4: Update `apply-image.js`**

Same pattern. Replace the user + project ownership check with import + canAccessProject.

- [ ] **Step 5: Commit**

```bash
git add api/generate-lp.js api/resolve-images.js api/image-directions.js api/apply-image.js
git commit -m "feat: update API endpoints to use role-based auth"
```

---

## Task 4: Rewrite `api/invite-user.js`

**Files:**
- Modify: `api/invite-user.js`

**Context:** Currently invites users with `is_manager` boolean. Rewrite to support roles + community assignment.

- [ ] **Step 1: Rewrite the endpoint**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add api/invite-user.js
git commit -m "feat: rewrite invite-user for role-based invitations"
```

---

## Task 5: Rewrite `api/admin-users.js`

**Files:**
- Modify: `api/admin-users.js`

**Context:** Currently returns users with `is_manager` boolean. Rewrite to return users with roles, communities, and support role management.

- [ ] **Step 1: Rewrite the endpoint**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add api/admin-users.js
git commit -m "feat: rewrite admin-users for role-based user management"
```

---

## Task 6: Community Management Endpoint (`api/manage-communities.js`)

**Files:**
- Create: `api/manage-communities.js`

- [ ] **Step 1: Create the endpoint**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add api/manage-communities.js
git commit -m "feat: add community management endpoint"
```

---

## Task 7: Update Login Flow — Check `user_roles` Before Magic Link

**Files:**
- Modify: `dashboard.html`
- Modify: `new.html`

**Context:** Currently anyone can request a magic link. We need to check if the email exists in `user_roles` before sending it. Since RLS blocks unauthenticated access to `user_roles`, we need a small API endpoint.

- [ ] **Step 1: Create `api/check-email.js`**

```javascript
// POST /api/check-email
// Body: { email }
// Returns: { allowed: true/false }
// No auth required (pre-login check)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "email is required" });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const rows = await r.json();
    return res.status(200).json({ allowed: rows?.length > 0 });
  } catch (err) {
    console.error("check-email error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
```

- [ ] **Step 2: Update `dashboard.html` login flow**

Find the `doLogin()` function (around line 1377). Before calling `sb.auth.signInWithOtp()`, add the email check:

```javascript
async function doLogin() {
  const email = document.getElementById('l-email').value.trim();
  if (!email) return showErr('נא להזין כתובת מייל');

  const btn = document.getElementById('l-btn');
  btn.disabled = true;
  btn.textContent = 'בודק...';

  // Check if email has a role
  try {
    const checkRes = await fetch('/api/check-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const checkData = await checkRes.json();
    if (!checkData.allowed) {
      showErr('לא נמצא חשבון. פנה למנהל המערכת.');
      btn.disabled = false;
      btn.textContent = 'שלחו לי קישור';
      return;
    }
  } catch (e) {
    // If check fails, proceed anyway (don't block on check failure)
  }

  // Send magic link (existing code)
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + '/dashboard' }
  });
  // ... rest of existing handler
}
```

- [ ] **Step 3: Update `new.html` login flow**

Same pattern — find the login function and add the check-email call before `signInWithOtp`.

- [ ] **Step 4: Commit**

```bash
git add api/check-email.js dashboard.html new.html
git commit -m "feat: check user_roles before sending magic link"
```

---

## Task 8: Update Dashboard — Role-Based UI

**Files:**
- Modify: `dashboard.html`

**Context:** Replace `isManager` boolean with `userRole` object. Adjust project loading, sidebar, and UI based on role. Add community filter for admins.

- [ ] **Step 1: Replace `isManager` with `userRole`**

Find line 1413: `let isManager = false;` and replace with:
```javascript
let userRole = null; // { role, organization_id, community_id, email }
let communities = []; // loaded for admins
let selectedCommunityFilter = 'all'; // 'all' or community_id
```

- [ ] **Step 2: Update the profile fetch (lines 1425-1436)**

Replace the `user_profiles` fetch + `isManager` assignment:

```javascript
// Fetch user role
const { data: roleData } = await sb.from('user_roles')
  .select('role, organization_id, community_id, email')
  .eq('user_id', session.user.id)
  .single();

if (!roleData) {
  // No role — show error, redirect to login
  await sb.auth.signOut();
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  showErr('אין לך הרשאה. פנה למנהל המערכת.');
  return;
}

userRole = roleData;

// Load communities for admin/super_admin (for filter dropdown)
if (userRole.role === 'admin' || userRole.role === 'super_admin') {
  const { data: comms } = await sb.from('communities').select('id, name').order('name');
  communities = comms || [];
}
```

- [ ] **Step 3: Update project loading (lines 1450-1459)**

Replace the `isManager` filter logic:

```javascript
async function loadProjects() {
  const list = document.getElementById('project-list');
  list.innerHTML = '<div class="sidebar-loading"><div class="loading-block"><div class="small-spin"></div> טוען...</div></div>';

  let query = sb.from('projects').select('*, communities(name)').order('created_at', { ascending: false });

  // RLS handles role-based filtering, but we add community filter for admin UI
  if (selectedCommunityFilter !== 'all') {
    query = query.eq('community_id', selectedCommunityFilter);
  }

  const { data, error } = await query;
  if (error) { console.error(error); return; }
  projects = data || [];
  renderProjectList();
}
```

- [ ] **Step 4: Add community filter UI for admins**

In the sidebar HTML (around line 1107), add a community filter dropdown before the project list:

```javascript
function renderCommunityFilter() {
  if (userRole.role === 'manager' || communities.length === 0) return;

  const sidebar = document.getElementById('sidebar');
  const existingFilter = document.getElementById('community-filter');
  if (existingFilter) existingFilter.remove();

  const filterHtml = `
    <div id="community-filter" style="padding:0 16px 12px;">
      <select id="community-select" onchange="filterByCommunity(this.value)"
        style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--navy);color:var(--text);font-family:inherit;font-size:13px;">
        <option value="all">כל הקהילות</option>
        ${communities.map(c => `<option value="${c.id}" ${c.id === selectedCommunityFilter ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
    </div>
  `;

  const projectList = document.getElementById('project-list');
  projectList.insertAdjacentHTML('beforebegin', filterHtml);
}

function filterByCommunity(communityId) {
  selectedCommunityFilter = communityId;
  loadProjects();
}
```

Call `renderCommunityFilter()` after communities are loaded.

- [ ] **Step 5: Update sidebar header for managers**

Show community name for managers:

```javascript
// After setting userRole:
const sidebarTitle = document.querySelector('.sidebar-title');
if (userRole.role === 'manager' && userRole.community_id) {
  const { data: comm } = await sb.from('communities').select('name').eq('id', userRole.community_id).single();
  if (comm) sidebarTitle.textContent = comm.name;
}
```

- [ ] **Step 6: Add Settings link for admin/super_admin**

In the sidebar or header, add a link to the settings page:

```javascript
if (userRole.role === 'admin' || userRole.role === 'super_admin') {
  const sidebar = document.getElementById('sidebar');
  const settingsLink = document.createElement('a');
  settingsLink.href = '/settings';
  settingsLink.className = 'btn-new-project';
  settingsLink.style.cssText = 'margin-top:8px;background:transparent;border:1px solid var(--border);';
  settingsLink.textContent = '⚙ הגדרות';
  sidebar.querySelector('.sidebar-head').appendChild(settingsLink);
}
```

- [ ] **Step 7: Replace all remaining `isManager` references**

Search dashboard.html for all occurrences of `isManager` and replace with role-based checks:
- `isManager` → `userRole.role === 'admin' || userRole.role === 'super_admin'` (for admin-level checks)
- Or use specific role checks where appropriate

- [ ] **Step 8: Commit**

```bash
git add dashboard.html
git commit -m "feat: update dashboard for role-based UI with community filter"
```

---

## Task 9: Update `new.html` — Community Selector + Test Assumptions

**Files:**
- Modify: `new.html`

- [ ] **Step 1: Add community selector to Step 1**

For admins: add a community dropdown before the business name field.
For managers: auto-fill with their community (hidden field).

After the user role is fetched (similar pattern to dashboard), add:

```javascript
// Fetch user role
const { data: roleData } = await sb.from('user_roles')
  .select('role, organization_id, community_id')
  .eq('user_id', session.user.id)
  .single();

if (!roleData) {
  showToast('אין לך הרשאה. פנה למנהל המערכת.');
  await sb.auth.signOut();
  return;
}

let selectedCommunityId = roleData.community_id; // auto-set for managers

// For admins, show community selector
if (roleData.role === 'admin' || roleData.role === 'super_admin') {
  const { data: comms } = await sb.from('communities').select('id, name').order('name');
  // Render dropdown in Step 1
  const step1 = document.querySelector('[data-step="1"]');
  const communityField = document.createElement('div');
  communityField.className = 'field';
  communityField.innerHTML = `
    <label class="field-label">קהילה *</label>
    <select id="communitySelect" class="field-input" onchange="selectedCommunityId = this.value">
      <option value="">בחר קהילה</option>
      ${comms.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
    </select>
    <div class="field-error" id="err-community">נא לבחור קהילה</div>
  `;
  step1.querySelector('.step-header').insertAdjacentElement('afterend', communityField);
}
```

- [ ] **Step 2: Add test assumptions field**

Add a new field to Step 1 or Step 2 (after the business info):

```html
<div class="field">
  <label class="field-label">מה אתם רוצים לבדוק?</label>
  <span class="field-hint">בחרו אחד או יותר</span>
  <div class="test-assumptions-group" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
    <label class="assumption-chip">
      <input type="checkbox" value="feasibility" onchange="updateAssumptions()"> היתכנות
    </label>
    <label class="assumption-chip">
      <input type="checkbox" value="messaging" onchange="updateAssumptions()"> מסרים
    </label>
    <label class="assumption-chip">
      <input type="checkbox" value="product" onchange="updateAssumptions()"> מוצר
    </label>
  </div>
  <input type="text" class="field-input" id="customAssumption" placeholder="טקסט חופשי (אופציונלי)"
    style="margin-top:8px;" oninput="updateAssumptions()">
</div>
```

JavaScript:
```javascript
let testAssumptions = [];

function updateAssumptions() {
  const checked = [...document.querySelectorAll('.assumption-chip input:checked')].map(i => i.value);
  const custom = document.getElementById('customAssumption')?.value.trim();
  testAssumptions = [...checked];
  if (custom) testAssumptions.push('Custom: ' + custom);
}
```

- [ ] **Step 3: Update `submitQuestionnaire()` and `submitBrief()`**

Add to the project insert:
```javascript
community_id: selectedCommunityId,
test_assumptions: testAssumptions,
```

Add validation: if admin role and no community selected, show error.

- [ ] **Step 4: Update Step 1 validation**

```javascript
if (currentStep === 1) {
  // Existing validations...
  if (roleData.role !== 'manager' && !selectedCommunityId) {
    showFieldError('err-community', 'נא לבחור קהילה');
    return false;
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add new.html
git commit -m "feat: add community selector and test assumptions to creation form"
```

---

## Task 10: Settings Page (`settings.html`)

**Files:**
- Create: `settings.html`

**Context:** Admin and super_admin page for managing communities and users. Follows existing dashboard.html patterns for auth, styling, and Supabase usage.

- [ ] **Step 1: Create settings.html**

Create a new page that:
- Uses the same auth flow as dashboard (magic link, session check)
- Checks role — if not admin/super_admin, redirect to dashboard
- Has two tabs: "Communities" and "Users"

**Communities tab:**
- List all communities with project count
- "Create Community" button → prompt for name → POST `/api/manage-communities`
- Edit name (inline or modal)
- Delete button (blocked if has projects)

**Users tab:**
- List all users with email, role, community name, created date
- "Invite User" button → modal with email + role dropdown + community dropdown (for managers)
- Remove button → DELETE `/api/admin-users`

The page should use the same CSS variables and design system as dashboard.html (dark theme, gold accents, Heebo font).

This is a large HTML file. The implementer should:
1. Read `dashboard.html` for auth flow, CSS patterns, and Supabase client setup
2. Create `settings.html` with the full UI
3. Keep it simpler than dashboard — no preview iframe, just two management tables

- [ ] **Step 2: Commit**

```bash
git add settings.html
git commit -m "feat: add settings page for community and user management"
```

---

## Task 11: Update `index.html` Redirect

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Update redirect logic**

Currently redirects to `/dashboard` or `/new`. Update to always go to `/dashboard` (which handles both login and project view):

The current behavior at lines 31-39 is fine — session check → dashboard or new. No major change needed unless you want to remove the `/new` redirect for non-authenticated users (since signup is invite-only now).

Update: redirect to `/dashboard` always (login is on the dashboard page):
```javascript
window.location.replace('/dashboard');
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: update index redirect for invite-only auth"
```

---

## Task 12: Set Super Admin Role

**Context:** After migration, you need to set your own account as super_admin. This is a one-time manual step.

- [ ] **Step 1: Run SQL to set super admin**

Using Supabase SQL editor or MCP, run:

```sql
-- Replace with your actual auth.users UUID and email
UPDATE public.user_roles
SET role = 'super_admin', organization_id = NULL, community_id = NULL
WHERE email = 'YOUR_EMAIL_HERE';
```

Or if your user wasn't migrated:
```sql
INSERT INTO public.user_roles (user_id, email, role)
SELECT id, email, 'super_admin'
FROM auth.users
WHERE email = 'YOUR_EMAIL_HERE'
ON CONFLICT (user_id) DO UPDATE SET role = 'super_admin', organization_id = NULL, community_id = NULL;
```

- [ ] **Step 2: Verify in Supabase**

Query `user_roles` to confirm your account shows `role = 'super_admin'`.

---

## Implementation Order & Dependencies

```
Task 1 (DB Migration) ← do first, no dependencies
    ↓
Task 2 (Auth Helper) ← needs DB tables
    ↓
Task 3 (Update API endpoints) ← needs auth helper
Task 4 (Rewrite invite-user) ← needs auth helper
Task 5 (Rewrite admin-users) ← needs auth helper
Task 6 (manage-communities) ← needs auth helper
Task 7 (Login flow + check-email) ← needs DB
    ↓ (Tasks 3-7 can be done in parallel after Task 2)
Task 8 (Dashboard role-based UI) ← needs all API endpoints
Task 9 (new.html community + assumptions) ← needs DB + communities
Task 10 (Settings page) ← needs manage-communities + admin-users
Task 11 (index.html redirect) ← independent, do anytime
    ↓
Task 12 (Set super admin) ← needs DB migration run
```
