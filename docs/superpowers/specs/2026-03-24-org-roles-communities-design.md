# Organization, Roles & Communities — Design Spec

## Overview

Add a multi-tenant organizational hierarchy to the LP generator: Organizations → Communities → Projects → LP Variants. Three user roles (super_admin, admin, manager) with invite-only access and magic link auth. Replaces the current `is_manager` boolean with a proper role system.

## Hierarchy

```
Organization: "Bavua"
  ├── Community: "Your Jewish Flow"
  │     ├── Manager: Sarah
  │     ├── Project 1 (testing: messaging) → LP variants
  │     └── Project 2 (testing: feasibility) → LP variants
  ├── Community: "Cheburashka"
  │     ├── Manager: Dan
  │     └── Project 1 (testing: product) → LP variants
  └── Community: "Community X"
        ├── Manager: Noa
        └── Project 1 → LP variants
```

## Roles

| Role | Scope | Access |
|------|-------|--------|
| `super_admin` | All organizations | Everything. Can create organizations. Can invite admins and managers. |
| `admin` | One organization (Bavua) | All communities + projects under that org. Can invite managers. Can manage communities. |
| `manager` | One community | Only their community's projects. Cannot invite anyone. Cannot delete projects. |

Currently: 1 super admin (you), 3-4 admins, 4-5 managers. Each manager handles exactly 1 community.

## Data Model

### New Tables

#### `organizations`
| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | Primary key |
| name | TEXT NOT NULL | e.g., "Bavua" |
| created_at | TIMESTAMPTZ | When created |
| updated_at | TIMESTAMPTZ | Last modified |

#### `communities`
| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | Primary key |
| organization_id | UUID NOT NULL (FK → organizations) | Which org this belongs to |
| name | TEXT NOT NULL | e.g., "Your Jewish Flow" |
| created_at | TIMESTAMPTZ | When created |
| updated_at | TIMESTAMPTZ | Last modified |

#### `user_roles`
| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | Primary key |
| user_id | UUID NOT NULL (FK → auth.users) | The user (see Invite Flow note below) |
| email | TEXT NOT NULL | User's email |
| role | TEXT NOT NULL | 'super_admin', 'admin', or 'manager' |
| organization_id | UUID (FK → organizations, nullable) | Org scope for admin. Null for super_admin. |
| community_id | UUID (FK → communities, nullable) | Community scope for manager. Null for admin/super_admin. |
| created_at | TIMESTAMPTZ | When assigned |

**Constraints:**
- UNIQUE(user_id) — one role per user (for future multi-community support, change to UNIQUE(user_id, community_id))
- When role = 'manager', community_id must be NOT NULL
- When role = 'admin', organization_id must be NOT NULL

**Note on `user_id` at invite time:** `supabase.auth.admin.inviteUserByEmail()` creates the `auth.users` row immediately (with unconfirmed status), returning a UUID. The invite endpoint creates the `user_roles` row with this UUID. The user doesn't exist as "confirmed" until they click the magic link, but the UUID is available at invite time.

### Modified Tables

#### `projects` — add columns
| New Column | Type | Purpose |
|------------|------|---------|
| community_id | UUID NOT NULL (FK → communities) | Which community this project belongs to |
| test_assumptions | JSONB DEFAULT '[]' | What the project tests: ["feasibility", "messaging", "product", "free text value"] |

**Note on `projects.user_id`:** The existing `user_id` column is kept as "created_by" for audit purposes. It records who originally created the project. However, **access control is no longer determined by `user_id`** — it's determined by `community_id` + the user's role. An admin can generate/edit/manage any project in their org's communities, even if they didn't create it.

`community_id` is NOT NULL. Migration backfills all existing projects to the "Default" community before adding the constraint.

#### `test_assumptions` field behavior
- Multi-select from predefined options: "feasibility", "messaging", "product"
- Plus optional free text string
- Stored as JSON array: `["messaging", "feasibility"]` or `["product", "Custom: testing price sensitivity"]`
- Free text entries prefixed with "Custom: " to distinguish from predefined values
- Displayed on project cards in the dashboard
- Included in the brief sent to Claude for LP generation (gives context on what the LP is testing)

#### `user_profiles` — changes
- Remove `is_manager` column (replaced by `user_roles`)
- Keep table for basic profile info

### Required Indexes

```sql
-- user_roles lookups (used by every RLS policy)
CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_user_roles_community_id ON user_roles(community_id);
CREATE INDEX idx_user_roles_organization_id ON user_roles(organization_id);
CREATE INDEX idx_user_roles_email ON user_roles(email);

-- communities lookup by org
CREATE INDEX idx_communities_organization_id ON communities(organization_id);

-- projects lookup by community
CREATE INDEX idx_projects_community_id ON projects(community_id);
```

### RLS Policies (all tables)

**Authorization approach:** API endpoints (serverless functions) continue using `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS. Authorization in API endpoints is handled in application code by querying `user_roles` to check the user's role and scope. RLS policies protect data accessed directly from the client (dashboard JS using `sb` client with user token).

**Projects RLS:**
- Super admin: SELECT/INSERT/UPDATE/DELETE all
- Admin: SELECT/INSERT/UPDATE/DELETE where `project.community_id` IN communities belonging to their organization
- Manager: SELECT/INSERT/UPDATE where `project.community_id` = their assigned community. No DELETE.

**Communities RLS:**
- Super admin: full access
- Admin: SELECT/INSERT/UPDATE/DELETE communities in their organization
- Manager: SELECT only their assigned community

**Organizations RLS:**
- Super admin: full access
- Admin: SELECT their organization only
- Manager: no direct access

**user_roles RLS:**
- Super admin: full access
- Admin: SELECT all roles in their org, INSERT/DELETE manager roles in their org
- Manager: SELECT own role only

**lp_image_content, lp_editable_content, project_variants, analytics_events, leads:**
- Access follows the same project-scoping logic — if you can see the project, you can see its data.

## API Endpoint Authorization Changes

All serverless API endpoints currently check `user.id !== project.user_id` for ownership. This must change to role-based authorization.

**Shared auth helper pattern** (new utility):
```javascript
async function getUserRole(userId) {
  // Fetch from user_roles table
  // Returns { role, organization_id, community_id } or null
}

async function canAccessProject(userId, projectId) {
  const role = await getUserRole(userId);
  if (!role) return false;
  if (role.role === 'super_admin') return true;
  // Fetch project's community_id
  // For admin: check community belongs to their org
  // For manager: check community matches their community_id
}
```

**Endpoints to update:**

| Endpoint | Current Auth | New Auth |
|----------|-------------|----------|
| `generate-lp.js` | `user.id !== project.user_id` | `canAccessProject(user.id, project_id)` |
| `resolve-images.js` | `user.id !== project.user_id` | `canAccessProject(user.id, project_id)` |
| `image-directions.js` | `user.id !== project.user_id` | `canAccessProject(user.id, project_id)` |
| `apply-image.js` | `user.id !== project.user_id` | `canAccessProject(user.id, project_id)` |
| `search-images.js` | token validation only | No change (no project scope) |
| `serve-lp.js` | Public (no auth) | No change (public LP serving) |
| `send-email.js` | Called from LP form | No change |
| `remix-answer.js` | token validation | No change (stateless) |
| `invite-user.js` | `is_manager` check | Role-based: super_admin can invite all, admin can invite managers |
| `admin-users.js` | `is_manager` check | Role-based: check `user_roles` for admin/super_admin |

## User Invite & Auth Flow

### Invite Flow
1. Admin/super admin goes to Settings → Users
2. Clicks "Invite User"
3. Fills: email, role (admin/manager), community (dropdown, only for manager role)
4. System calls `supabase.auth.admin.inviteUserByEmail(email)` — creates `auth.users` row, returns UUID
5. System creates `user_roles` row with UUID + email + role + scope
6. User receives invite email with magic link
7. User clicks link → account confirmed → lands on dashboard → role already assigned

### Returning User Flow
1. User goes to dashboard URL
2. Enters email
3. **Before sending magic link:** System checks if `user_roles` row exists for this email
4. If no role exists → show error: "לא נמצא חשבון. פנה למנהל המערכת." (No account found. Contact your admin.) — magic link is NOT sent
5. If role exists → send magic link → user clicks → logged in → dashboard scoped to their role

### Who Can Invite Who
| Inviter | Can invite |
|---------|-----------|
| Super admin | Admins + Managers |
| Admin | Managers only |
| Manager | Nobody |

### Removing Access
Admin/super admin goes to Settings → Users → "Remove" next to user. This:
1. Deletes the `user_roles` row
2. Optionally deletes the `auth.users` row (prevents future magic link login)
3. Projects they created remain (with their `user_id` as audit trail) — access determined by community, not creator

## Dashboard Changes

### Role-Based Views

**Refactoring note:** The current `isManager` boolean in dashboard.html must be replaced with a `userRole` object:
```javascript
// Current: let isManager = false;
// New:
let userRole = null; // { role: 'admin', organization_id: '...', community_id: null }
```
All conditional UI rendering currently using `isManager` must switch to checking `userRole.role`.

**Super admin dashboard:**
- Organization selector (for future multi-org)
- Community filter (All / specific community)
- Settings: manage organizations, communities, users
- Sees all projects across all communities

**Admin dashboard:**
- Community filter: dropdown or pill tabs (All / Your Jewish Flow / Cheburashka / etc.)
- Settings: manage communities + invite/remove managers
- Sees all projects in their organization's communities

**Manager dashboard:**
- Community name shown in header
- Sees only their community's projects
- No community selector
- No Settings/Users access
- Can create and edit projects, but cannot delete them

### Project Creation Changes

**Admin creating a project:**
- Must select which community the project belongs to (dropdown)
- "What do you want to test?" multi-select: Feasibility, Messaging, Product, Free text input
- Rest of form unchanged

**Manager creating a project:**
- Community auto-assigned (their community, no dropdown)
- Same "What do you want to test?" field
- Rest of form unchanged

**Where community selection happens:** In `new.html` for both questionnaire and brief modes. A community dropdown is added as Step 1 (before business info) for admins. For managers, it's hidden and auto-filled.

### Settings Page (new)
Only visible to admin + super admin. New page: `settings.html`.

**Tabs:**
1. **Communities** — list communities, create new, edit name, delete
   - Delete blocked if community has projects. Must move or delete projects first.
2. **Users** — list all users with role + community, invite new user, remove user

## Deletion Rules

| Deleting | Behavior |
|----------|----------|
| Organization | Blocked if communities exist. Super admin only. |
| Community | Blocked if projects exist. Must move/delete projects first. |
| Project | Admin/super admin only. Cascades to variants, editable content, image content, analytics, leads. |
| User (remove access) | Deletes `user_roles` row. Projects they created remain. Optionally remove `auth.users` row. |

## Migration from Current System

1. Create "Bavua" organization
2. Create "Default" community under Bavua
3. Add `community_id` column to `projects` (nullable initially)
4. Backfill: set all existing projects' `community_id` to the Default community
5. Alter `community_id` to NOT NULL
6. Create `user_roles` rows:
   - Your account (super admin email) → `super_admin` role
   - Users with `is_manager = true` → `admin` role under Bavua
   - Users with `is_manager = false` → `manager` role assigned to Default community (preserves their access to existing projects)
7. Add `test_assumptions` column to `projects` (JSONB DEFAULT '[]')
8. Drop `is_manager` column from `user_profiles`
9. Update all RLS policies to use `user_roles` instead of `user_profiles.is_manager`
10. Update login flow: check `user_roles` before sending magic link

## What This Does NOT Include (Future)

- Multiple managers per community (data model change: remove UNIQUE(user_id), add UNIQUE(user_id, community_id))
- Multiple organizations UI (data model already supports it)
- Manager self-signup
- Role hierarchy changes
- Notification email routing per organization
