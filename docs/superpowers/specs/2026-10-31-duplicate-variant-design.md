# Duplicate Variant (+ rename, + delete draft) — Design

Date: 2026-10-31 · Branch: `feat/duplicate-variant` (from `origin/main` @ 2fdfb1c)
Status: draft approved by user; revised after guy-loop spec reviews round 1 + 2 (final).

## Why

A variant test is only valid when B differs from A in ONE thing. Today that's
impossible in the dashboard:

- `+ וריאנט` (`dashboard.html` `showAddVariantModal`, ~L5429) creates an EMPTY
  variant (no HTML, no text edits; it copies image rows from the default
  variant only).
- "Generate" rebuilds a whole new page from the project brief, so B never equals A.

We need a one-click **"duplicate"** that copies the variant the user is looking
at 1:1 into a new draft, and opens it on the Edit-text tab so they change one
thing. Live classroom on **Feb 9 2027** with 12 non-technical users; production
has a live customer with real ad spend.

**Multi-variant has never run in production** (live DB: 27 projects, 27
variants, all `is_default`, zero projects with 2+ variants). This feature is the
first to put real users on non-default-variant paths, so it must also make those
paths work (see the migration below) and verify them.

## Goals

1. A **שכפול** button next to `+ וריאנט` copies the currently selected variant
   1:1 into a new **draft** variant: `generated_html`, all `lp_editable_content`
   rows (the Edit-text overrides), all `lp_image_content` rows (every column that
   affects rendering: `slot, image_url, source, source_meta, enabled,
   display_size, display_shape`).
2. After copying, the dashboard selects the new variant and switches to the
   **Edit-text** tab, and the user can SEE which variant they are editing on
   every tab.
3. The copy's preview is visually identical to the source's preview.
4. **Rename**: the user can change a variant's display name (`variant_name`).
5. **Delete draft**: the user can delete a draft variant that has no data.
6. Saving Edit-text, images, and publishing work on a non-default variant
   without touching the source variant.
7. Safe under concurrency: 12 people at once, either each in their own project
   or several in one shared project.

## Non-goals

- No change to `+ וריאנט` (empty variant) or to "Generate" behavior.
- Rename does NOT change `variant_slug` (the public URL stays the same).
- No copying of analytics, leads, test membership, or publish status.
- No delete for published variants, the default variant, or variants with data.
- No per-user ownership of variants (no creator column): anyone with access to
  the project can rename / delete its drafts, same as they can publish today.
- No refactor of the dashboard; vanilla JS, same style as surrounding code.

## Anti-goals (failure even if it "works")

- Any change in behavior of `/lp/:slug` or `/lp/:slug/:variant` for existing
  variants.
- A half-copied variant left behind after an error that looks complete.
- A delete that silently removes a running test's variant or orphans leads.
- English/tech words or a stack trace in the UI. A silent failure.
- Editing the source (possibly published) variant while believing it's the copy.

## Constraints (verified)

- **Vercel 12-function cap is full**: `api/` has exactly 12 non-test functions
  (admin, apply-image, feedback, generate-lp, remix-answer, resolve-images,
  save-content, search-images, send-email, serve-lp, serve-test, test-monitor).
  A 13th makes deploys fail silently. → **No new `api/*.js` file.** Server logic
  goes into an existing function; `api/_lib/` (underscore) is free for helpers.
- **`lp_editable_content` has TWO unique constraints in the live DB**:
  `lp_editable_content_project_id_key_key UNIQUE (project_id, key)` (legacy,
  pre-variants, never dropped) and `lp_editable_content_variant_id_key_key
  UNIQUE (variant_id, key)`. The legacy one allows a key (e.g. `hero_title`) on
  only ONE variant per project. It breaks: copying text rows, saving Edit-text on
  any second variant (`save-content.js:125` upserts `on_conflict=variant_id,key`
  → 23505 on `(project_id,key)`), and Generate on a second variant
  (`generate-lp.js` ~L486–520 deletes by `variant_id` then inserts).
  No code targets `(project_id, key)`: the only conflict target is
  `variant_id,key` (`save-content.js:125`); readers filter by `variant_id`
  (`lp-renderer.js`, `save-content.js` GET when a variant is selected).
- Live DB `uaspcafukqvgiztzdnfu` FKs onto `project_variants(id)`:
  `lp_editable_content` CASCADE, `lp_image_content` CASCADE,
  `test_variants` **CASCADE**, `leads` SET NULL, `analytics_events` SET NULL,
  `tests.summary_winner_variant_id` / `tests.cpl_leader_variant_id` SET NULL.
- `lp_image_content` has `UNIQUE (variant_id, slot)`; `project_variants` has
  `UNIQUE (project_id, variant_slug)`. `project_id` is NOT NULL on both child
  tables. `variant_name` is nullable; generated default variants are named
  `"Default"` (`generate-lp.js:432`).
- Service-role code bypasses RLS, so every server action must check the variant
  belongs to the authorized project (same pattern as the write-back guard in
  `api/save-content.js` ~L64–86).
- `authenticateAndAuthorize` returns English errors (e.g. 403 "No role assigned.
  Contact your admin.") — the dashboard must never show server error text.
- `showToast` (`dashboard.html` ~L5520) uses `textContent` and un-cleared 3.5 s
  timers: it cannot host a button and will hide other toasts early.

## Decisions (user)

- Classroom setup: **unknown / mixed** → must be safe both in own projects and
  in one shared project.
- Name: **auto-name, rename later.**
- Button: **next to `+ וריאנט`**, copies the variant currently being viewed.
- After copy: **open the copy on the Edit-text tab.**
- Rename: **yes, a small rename** (display name only; URL unchanged).
- Mistakes: **a full "delete draft" button.**
- Schema: "no schema changes unless needed" → the single migration below is
  needed (the feature cannot work without it).

## Design

### Migration (the only schema change)

New file `supabase/migrations/drop_editable_content_project_key_unique.sql`:

```sql
ALTER TABLE public.lp_editable_content
  DROP CONSTRAINT IF EXISTS lp_editable_content_project_id_key_key;
```

Deletes no data; `UNIQUE (variant_id, key)` stays. Applied to the live DB by the
main session **only after explicit user confirmation**, before the code is
deployed to production. The builder writes the file but never applies it.

**Security prerequisite (ships BEFORE the migration is applied).** Today the
legacy constraint is the only thing stopping a cross-tenant text write: the
`save-content.js` items POST (~L107–131) authorizes `project_id` only, then
upserts `{project_id, variant_id, key, value}` on `variant_id,key` — and variant
ids are public (`lp-renderer.js:220` prints `VARIANT_ID` into every served LP).
With the constraint dropped, an account with access to project A could rewrite
another tenant's live LP text. So, in this same change: the items POST must load
`project_variants?id=eq.<variant_id>&select=project_id` with the service role and
return 404 if missing, 403 if `project_id` differs (strict equality) — the same
check the write-back branch already has (~L64–84) — before any upsert. Also 400
when `variant_id` is missing. Co-located test: foreign variant → 403 and no
upsert call. Order: deploy this check to production → then apply the migration.

### Server: two new actions in `api/admin.js` (my call)

`admin.js` is already the merged `{ action }` dispatcher built to dodge the
function cap. Logic lives in a new helper `api/_lib/variant-ops.js` (testable;
`admin.js` only routes). Both actions authenticate with
`authenticateAndAuthorize(req, res, { projectId })` (project access, NOT an
admin-role gate), then verify via service role that the variant's own
`project_id` equals the authorized `project_id` (403 otherwise). Return 400
when `project_id` or the variant id is missing, BEFORE calling auth
(`authenticateAndAuthorize` skips the project check when `projectId` is falsy,
`auth-helper.js:174`). The ownership compare is strict equality, never guarded
by `if (project_id && …)`. Errors return
`{ error: <code> }` with a stable machine code (e.g. `not_found`,
`wrong_project`, `empty_source`, `slug_exhausted`, `copy_failed`,
`has_data`, `not_draft`, `is_default`); the dashboard maps codes to Hebrew.

**`{ action: "duplicate-variant", project_id, source_variant_id }`**

1. Load source variant (`id, project_id, variant_name, variant_slug,
   generated_html, is_default`). 404 if missing, 403 if wrong project, 400 if
   `generated_html` is empty.
2. Read this project's existing slugs + names **fresh from the DB**.
3. Slug: first free letter `a..z`; else the smallest free `v<N>` (N ≥ 1) in the
   fresh set.
   Name: base = source is default → `הדף הראשי`; else `variant_name ||
   variant_slug`. Candidate `<base> – עותק`, then `<base> – עותק 2`, `3`, … ;
   base is truncated so the full name is ≤ 40 characters.
4. Insert `project_variants` row: `status: 'draft'`, `is_default: false`, copied
   `generated_html`. On unique-violation of `(project_id, variant_slug)` (a
   concurrent duplicate won the race): re-read slugs + names, pick a **random**
   free slug (random free letter, else smallest free `v<N>`), recompute the
   name, wait a small random jitter (e.g. 20–150 ms), retry — up to 10
   attempts, then fail with `slug_exhausted`. (Names have no unique
   constraint; under a simultaneous race two copies may share a name. Accepted:
   they have different pills/URLs and can be renamed.)
5. Copy all `lp_image_content` rows of the source: `project_id` (the authorized
   project), new `variant_id`, and `slot, image_url, source, source_meta,
   enabled, display_size, display_shape`.
6. Copy all `lp_editable_content` rows: `project_id`, new `variant_id`, `key,
   value`. (Skip the insert when the source has zero rows.)
7. If step 5 or 6 fails: delete the new variant (children cascade), log the
   error, return 500 `copy_failed`. If that rollback DELETE also fails, log
   loudly with the orphan variant id (`console.error`) and still return 500
   `copy_failed`. The orphan is a draft with no data, so the user can remove it
   with "delete draft".
8. Return the new variant row with the same fields the dashboard selects for
   variants in `selectProject`.

**`{ action: "delete-draft-variant", project_id, variant_id }`**

Refuse (409 + code) unless ALL hold, checked server-side with service role at
delete time: `status = 'draft'` (`not_draft`), `is_default = false`
(`is_default`), zero `leads`, zero `analytics_events`, zero `test_variants` rows
for this `variant_id` (`has_data`). Then delete with a **conditional** DELETE
(`?id=eq.<id>&project_id=eq.<project>&status=eq.draft&is_default=eq.false`,
`Prefer: return=representation`); zero rows deleted → 409 `not_draft` (someone
published it between check and delete). Children cascade. Missing variant →
404 `not_found`. The token may be sent in the body (`access_token`) so the call
works with `fetch(..., { keepalive: true })` on page hide —
`authenticateAndAuthorize` already reads `req.body.access_token`
(`auth-helper.js:148-150`).

### Dashboard (`dashboard.html`)

- **Variant bar placement**: move `#variant-bar` out of `#tab-preview` to just
  above `.tabs-bar`, so it shows on every variant-scoped tab (my call). Keep its
  existing hide-when-no-variants rule, and also hide it on the **Email** tab
  (email settings are per-project). The active pill must be clearly
  distinguishable (existing `.active` style).
- **Default label**: display-only — when a variant `is_default` and its name is
  null or `"Default"`, the pill shows `הדף הראשי` (matches the copy's name).
- **Every variant switch reloads every variant-scoped view** (control-state
  rule: derived UI must follow all its inputs). `selectVariant` additionally
  reloads the image slots (`loadImageSlots()`, at least when the Images tab is
  active) so the Images tab never shows one variant while edits go to another.
  `showAddVariantModal` ends with `selectVariant(data.id)` instead of its own
  partial refresh (refresh only — its creation behavior is unchanged).
- **Unsaved Edit-text guard**: track a dirty flag on `#edit-fields` input
  (cleared on load and on successful save). If dirty when the user clicks
  שכפול, another pill, `+ וריאנט`, or delete: block the action and show a Hebrew
  toast like "יש שינויים שלא נשמרו — שמרו קודם" (no modal).
- **שכפול button**: next to `+ וריאנט`. Disabled when the selected variant has
  no HTML. Re-entry guard set synchronously; while running: disabled +
  "משכפל…". On success: push the returned row into `projectVariants`, select it
  (`selectVariant`), switch to the Edit-text tab, toast in Hebrew. On failure:
  Hebrew toast mapped from the error code (generic Hebrew fallback for unknown
  codes / network errors), selection unchanged, `console.error` the detail.
- **Rename**: a pencil control rendered as a **sibling** of the active pill (not
  nested inside the `<button>`). Click → inline text input prefilled with the
  name. One `editing` state with a single exit: Enter or blur = commit, Esc =
  cancel; whichever fires first ends the state and every later event (e.g. the
  blur caused by removing the input) is a no-op — no double save, no save after
  cancel. Trimmed, non-empty, max 40 chars; unchanged name = no request. Save via
  `sb.from('project_variants').update({ variant_name }).eq('id', id).select()`;
  zero returned rows or an error → Hebrew error toast + revert. Any re-render of
  the bar (e.g. `selectVariant`) first cancels an open edit.
- **Delete draft**: a quiet "מחיקת טיוטה" control next to the active pill, shown
  only when the selected variant is a draft and not the default. No "are you
  sure?" modal (admin-ux rule). Flow:
  1. Remove the variant from `projectVariants` into a single pending holder
     (row + original index + the `access_token` captured now), select the
     default variant, show a **dedicated undo toast** (its own element and
     timer, not `showToast`) with **ביטול**, ~6 seconds.
  2. Undo → restore pill + previous selection; nothing is sent.
  3. Toast expires → call `delete-draft-variant`.
  4. The pending delete is **flushed immediately** (sent now) when: the user
     switches project, starts another delete, or the page is hidden
     (`pagehide`: synchronous `fetch(..., { keepalive: true })` using the
     token captured in step 1 — no awaits in the handler). Only one pending
     delete at a time.
  5. Any variant list re-fetched while a delete is pending filters out the
     pending id.
  6. Server refuses → restore the pill and show the reason in plain Hebrew
     (e.g. "אי אפשר למחוק — לדף הזה כבר יש נתונים").
- **Hebrew errors on the copy's path**: `saveContent` (~L5025) and
  `togglePublish` (~L4458) show a Hebrew message instead of `'שגיאה: ' + …`;
  keep `console.error` of the detail. When the variant no longer exists
  (server `not_found` / 404, or an FK 23503 — e.g. another user deleted the
  draft), show "הדף הזה נמחק — רעננו את העמוד". (In scope because the copy
  flow sends users straight there.)
- All new UI copy: warm, casual Hebrew, no English tech words (use the
  `hebrew-content-writer` skill).

### Tests

Co-located, for the new code only (`api/_lib/variant-ops.test.js`, plus an
`api/admin` routing test if cheap): duplicate copies variant + all image columns
+ text rows with the new id and the authorized `project_id`; slug picking incl.
`v<N>` gaps; name picking incl. default → `הדף הראשי`, null name, numbering,
40-char cap; retry on slug conflict; rollback on child-copy failure (and the
rollback-also-fails path); cross-project 403; empty source 400; delete refuses
each guard condition; delete succeeds on a clean draft. Follow the repo's
existing test runner and mocking style (see `api/save-content.test.js`).

### Verification (per CLAUDE.md)

Main session, after the migration is applied and a Vercel preview is deployed.
On a test project (never the live customer's):

1. Duplicate a variant that has text edits + an image override + a disabled
   image → previews match.
2. On the copy: edit one field, save, reload → persisted; source unchanged.
3. On the copy: swap an image and toggle fold2 → source unchanged.
4. Publish the copy → `/lp/<test-slug>/<copy-slug>` loads with the copy's
   content; the source's public URL is unchanged.
5. Rename the copy; switch tabs → the variant bar shows the new name everywhere.
6. Delete the copy (wait out the toast) → gone after reload. Undo path works.
   Delete control hidden on published/default; a variant with leads is refused.
7. ~10 duplicates of the same source fired in parallel against the preview
   (a script is fine) → ~10 distinct copies, no `slug_exhausted`.
8. On the Images tab and on the Edit-text tab, click another pill → fields and
   images match that pill. Type in Edit-text without saving, click שכפול →
   blocked with the unsaved-changes toast.
9. `save-content` POST with a variant id from another project → 403, nothing
   written (run before applying the migration, on the preview).
10. `/lp/lipaz-ela-1` still loads unchanged. No console errors.

## Classroom readiness (ops, not built here)

Each of the 12 users needs an account AND a `user_roles` row, or every server
action returns 403. Managers see every project in their community, so "own
project" is not isolation. A manager's `user_roles.community_id` must equal the
project's `community_id` (`canAccessProject`); live DB has 8 of 27 projects whose
owner's role community differs — those owners can see the project via RLS but
every server action, duplicate included, returns 403. Don't move classroom users
between communities; run a read-only SQL check of role-community vs
project-community for the classroom accounts before Feb 9.

## Left to the builder / plan

- Exact Hebrew strings; button styling consistent with `.btn-add-variant`.
- Undo-toast markup/CSS.

## Decided — apply-image hole (user chose Option A: fix here, plan Task 2)

- **`api/apply-image.js` cross-tenant hole (exists today):** it checks project
  access but never that `variant_id` belongs to `project_id`, then upserts
  `lp_image_content` and PATCHes `project_variants.generated_html` of any
  variant id (ids are public in served LPs). This feature doesn't widen it, but
  the classroom adds 12 accounts. Option A (recommended): fix here with the same
  ownership check + a test. Option B: leave it, recorded here.

## Observed, out of scope

- **Browser-side RLS on `project_variants` is wide** (live policy "Roles can
  access variants via project": `FOR ALL`, no `with_check`). Any user who can
  see a project can UPDATE/DELETE any of its variants (incl. published/default)
  straight from the anon client, bypassing the `delete-draft-variant` guards.
  Exists today; this feature doesn't widen it. Recorded for a follow-up
  (user's call), with the extra classroom accounts in mind.

- `showAddVariantModal` copies image rows WITHOUT `enabled`, `display_size`,
  `display_shape`. Not fixed here.
- `+ וריאנט` asks for an English slug via `prompt()`. Not changed here.
- Spec review round 1 reviewer suggested an atomic SQL function for duplicate;
  not taken (keeps the migration to one DROP CONSTRAINT; rollback covers it).
