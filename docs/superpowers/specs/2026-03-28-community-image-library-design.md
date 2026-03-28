# Community Image Library — Design Spec

## Overview
A per-community image library that stores all images users have applied to LP slots or manually saved from AI generation. Accessible as a 4th tab in the image picker modal.

## Data Model

### New table: `community_image_library`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | `gen_random_uuid()` |
| community_id | UUID FK → communities | NOT NULL |
| image_url | TEXT | Cached Supabase storage URL |
| source | TEXT | 'upload', 'pexels', 'imagen' |
| source_meta | JSONB | prompt, photographer, search query, etc. |
| added_by | UUID FK → auth.users | Who saved it |
| created_at | TIMESTAMPTZ | `now()` |

**Constraints:** UNIQUE on `(community_id, image_url)` — no duplicate URLs per community.

### RLS Policies
- Super admins: full access
- Admins: access images in their org's communities
- Managers: access images in their assigned community

(Mirror existing `projects` RLS pattern.)

## How Images Enter the Library

### 1. Auto-save on apply
When `applySelectedImage()` succeeds, insert into `community_image_library` using the project's `community_id`. Uses upsert (on conflict do nothing) to avoid duplicates.

### 2. Save button on AI results
A "💾 שמור" button on each AI-generated image in the AI tab. Saves to library without applying to a slot. Requires knowing the community_id (from `selectedProject.community_id`).

## UI: 4th Tab "📁 הספרייה שלי"

### Position
4th tab after AI Generated: `העלאה | Stock Photo | AI Generated | הספרייה שלי`

### Layout
- Grid of thumbnails (same 3-column layout as stock results)
- Each image has an X delete button (top-right corner, visible on hover)
- Click to select → shows "החל תמונה" apply bar
- Sorted by newest first

### Empty State
"אין תמונות שמורות — תמונות שתבחרו יישמרו כאן אוטומטית"

### Delete
- X button removes row from `community_image_library`
- Does NOT delete from storage (other variants may reference it)
- No confirmation dialog

## Implementation Changes

### Files to modify
1. **Supabase migration** — create `community_image_library` table + RLS
2. **dashboard.html** — add 4th tab, library loading, save button on AI results, auto-save on apply, delete functionality
3. **api/apply-image.js** — after successful apply, also insert into library

### No new API endpoints needed
- Library CRUD can use Supabase client directly from dashboard (RLS handles auth)
- Only `apply-image.js` needs a small addition for auto-save

## Access Control
All users in a community see the same library. Any community member can add or delete images. This matches the collaborative nature of the tool.
