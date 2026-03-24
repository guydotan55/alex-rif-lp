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
| `manager` | One community | Only their community's projects. Cannot invite anyone. |

Currently: 1 super admin (you), 3-4 admins, 4-5 managers. Each manager handles exactly 1 community.

## Data Model

### New Tables

#### `organizations`
| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | Primary key |
| name | TEXT NOT NULL | e.g., "Bavua" |
| created_at | TIMESTAMPTZ | When created |

#### `communities`
| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | Primary key |
| organization_id | UUID NOT NULL (FK → organizations) | Which org this belongs to |
| name | TEXT NOT NULL | e.g., "Your Jewish Flow" |
| created_at | TIMESTAMPTZ | When created |

#### `user_roles`
| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | Primary key |
| user_id | UUID NOT NULL (FK → auth.users) | The user |
| email | TEXT NOT NULL | User's email (for invite before they sign up) |
| role | TEXT NOT NULL | 'super_admin', 'admin', or 'manager' |
| organization_id | UUID (FK → organizations, nullable) | Org scope for admin. Null for super_admin. |
| community_id | UUID (FK → communities, nullable) | Community scope for manager. Null for admin/super_admin. |
| created_at | TIMESTAMPTZ | When assigned |

**Constraints:**
- UNIQUE(user_id) — one role per user
- When role = 'manager', community_id must be NOT NULL
- When role = 'admin', organization_id must be NOT NULL

### Modified Tables

#### `projects` — add columns
| New Column | Type | Purpose |
|------------|------|---------|
| community_id | UUID (FK → communities) | Which community this project belongs to |
| test_assumptions | JSONB DEFAULT '[]' | What the project tests: ["feasibility", "messaging", "product", "free text value"] |

#### `user_profiles` — changes
- Remove `is_manager` column (replaced by `user_roles`)
- Keep table for basic profile info

### RLS Policies (all tables)

**Projects RLS:**
- Super admin: SELECT/INSERT/UPDATE/DELETE all
- Admin: SELECT/INSERT/UPDATE/DELETE where `project.community_id` IN communities belonging to their organization
- Manager: SELECT/INSERT/UPDATE/DELETE where `project.community_id` = their assigned community

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

## User Invite & Auth Flow

### Invite Flow
1. Admin/super admin goes to Settings → Users
2. Clicks "Invite User"
3. Fills: email, role (admin/manager), community (dropdown, only for manager role)
4. System creates `user_roles` row with email + role + scope
5. System sends magic link email via Supabase Auth (`supabase.auth.admin.inviteUserByEmail()`)
6. User clicks link → account created → lands on dashboard → role already assigned

### Returning User Flow
1. User goes to dashboard URL
2. Enters email → "Send magic link"
3. Clicks link → logged in → dashboard scoped to their role
4. If no `user_roles` row exists for their email: "No account found. Contact your admin."

### Who Can Invite Who
| Inviter | Can invite |
|---------|-----------|
| Super admin | Admins + Managers |
| Admin | Managers only |
| Manager | Nobody |

### Removing Access
Admin/super admin goes to Settings → Users → "Remove" next to user. Deletes `user_roles` row. User can no longer access anything.

## Dashboard Changes

### Role-Based Views

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

### Project Creation Changes

**Admin creating a project:**
- Must select which community the project belongs to (dropdown)
- "What do you want to test?" multi-select: Feasibility, Messaging, Product, Free text input
- Rest of form unchanged

**Manager creating a project:**
- Community auto-assigned (their community, no dropdown)
- Same "What do you want to test?" field
- Rest of form unchanged

### Settings Page (new)
Only visible to admin + super admin.

**Tabs:**
1. **Communities** — list communities, create new, edit name, delete (with confirmation)
2. **Users** — list all users with role + community, invite new user, remove user

## Migration from Current System

1. Create "Bavua" organization
2. Create "Default" community under Bavua
3. Add `community_id` column to `projects` — set all existing projects to Default community
4. Create `user_roles` rows:
   - Current user with `is_manager = true` → `admin` role under Bavua
   - Current user with `is_manager = false` → needs manual assignment (or skip, re-invite)
   - Your account → `super_admin`
5. Drop `is_manager` column from `user_profiles`
6. Remove public signup flow — replace with invite-only
7. Update all RLS policies to use `user_roles` instead of `user_profiles.is_manager`

## What This Does NOT Include (Future)

- Multiple managers per community
- Multiple organizations (data model supports it, UI doesn't)
- Manager self-signup
- Role hierarchy changes
