# Duplicate Variant Implementation Plan

> **Builder:** Codex, one task at a time, in order, commit per task. Steps use checkbox (`- [ ]`) syntax. Every Hebrew string is fixed in the "Hebrew strings" section — use them verbatim; do not invent copy.

**Goal:** A one-click "שכפול" that copies the selected variant 1:1 into a new draft and opens it on Edit-text, plus rename, guarded delete-draft, and the fixes that make non-default variants work.

**Architecture:** Server logic in a new testable helper `api/_lib/variant-ops.js`, routed from the existing `api/admin.js` `{ action }` dispatcher (no new function file). One migration drops a legacy unique constraint; a security check in `api/save-content.js` ships first. Dashboard changes stay vanilla JS inside `dashboard.html`, with small pure helpers tested by extracting them from the HTML (existing pattern in `api/dashboard-preview-parity.test.js`).

**Tech Stack:** Vercel serverless (Node ESM), Supabase PostgREST via `fetch` with the service role, vanilla HTML/JS, `node --test` (`npm test`), `linkedom` available.

**Spec:** `docs/superpowers/specs/2026-10-31-duplicate-variant-design.md` — read it fully before Task 1. Where this plan is silent, the spec decides.

## Global Constraints

- **No new file directly under `api/`** except `*.test.js` files. 12 functions is the Vercel cap; helpers go in `api/_lib/`.
- **Never** apply the migration, write to any database, deploy, or push. Write files and commit locally only.
- Do not change `api/serve-lp.js`, `api/serve-test.js`, `api/_lib/lp-renderer.js`, or `vercel.json`.
- Do not change what `+ וריאנט` creates or what Generate does (Task 8 only changes the refresh at the end of `showAddVariantModal`).
- All user-facing strings are warm, casual Hebrew, with no English and no server error text. Show only mapped Hebrew. `console.error` the detail.
- No empty `catch {}`: every catch logs or rethrows.
- Server errors return `{ error: <code> }` with codes from this set: `missing_fields`, `not_found`, `wrong_project`, `empty_source`, `slug_exhausted`, `copy_failed`, `not_draft`, `is_default`, `has_data`, `server_error`.
- Ownership compares are strict equality (`row.project_id !== projectId` → 403). Never guard them with `if (projectId && …)`.
- Auto-name max 40 chars; rename max 40 chars.
- The default variant's display label is `הדף הראשי` when its name is null or `"Default"`.
- Baseline: `npm test` → 207 pass, 0 fail. Every task ends with `npm test` all green.
- Commit message prefix `feat(variants):` or `fix(security):`. End each commit message with `Co-Authored-By: claude-flow <ruv@ruv.net>`.

## Hebrew strings (verbatim)

`variantErrorMessage(code, status)` map:

| code / case | text |
|---|---|
| `not_found` | הדף הזה נמחק — רעננו את העמוד |
| `has_data` | אי אפשר למחוק — לדף הזה כבר יש נתונים |
| `not_draft` | הדף הזה כבר מפורסם, אז אי אפשר למחוק אותו |
| `is_default` | את הדף הראשי אי אפשר למחוק |
| `wrong_project` | אין לכם גישה לדף הזה |
| `empty_source` | אין עדיין מה לשכפל — קודם צריך ליצור את הדף |
| `slug_exhausted` | הרבה אנשים משכפלים עכשיו. נסו שוב בעוד כמה שניות |
| `copy_failed` | השכפול לא הצליח. שום דבר לא השתנה — אפשר לנסות שוב |
| status 401 (any code) | פג תוקף ההתחברות — התחברו מחדש |
| status 403 without a known code | אין לכם גישה לפרויקט הזה. פנו למנהל/ת |
| `missing_fields`, `server_error`, unknown, network | משהו השתבש. נסו שוב בעוד רגע |

Other UI strings:

| where | text |
|---|---|
| duplicate button | שכפול |
| duplicate tooltip (`title`) | יוצר עותק מדויק של הדף הזה, כדי לשנות בו דבר אחד ולבדוק מה עובד יותר טוב |
| duplicate in flight | משכפל… |
| duplicate success toast | נוצר עותק! עכשיו שנו בו דבר אחד בלבד |
| unsaved-changes toast | יש שינויים שלא נשמרו — שמרו או בטלו אותם קודם |
| discard button (Edit-text tab, next to save) | ביטול שינויים |
| rename button tooltip | שינוי שם |
| rename invalid | השם צריך להיות באורך 1 עד 40 תווים |
| rename failed | לא הצלחנו לשנות את השם. נסו שוב |
| delete-draft button | מחיקת טיוטה |
| undo toast text | הטיוטה נמחקה |
| undo button | ביטול |
| default variant label / copy-name base | הדף הראשי |
| copy-name suffix | ` – עותק` (then ` – עותק 2`, `3`, …) |

## Review Focus

1. **Cross-tenant ids.** A variant id from another project sent to save-content / duplicate / delete must give 403 and no write. Pinned in Tasks 1, 5, 6.
2. **Class-wide race.** ~10 parallel duplicates in one project must all succeed with distinct slugs. Pinned in Task 4 (random pick) and Task 5 (retry on 23505 picks a different slug).
3. **Stale tab after a switch / out-of-order loads.** After clicking another pill, the Edit/Images tabs must show the new pill's data even if an older load resolves last — otherwise a save overwrites the variant with another's text. Pinned in Task 8 (load sequence guard; out-of-order test).
4. **Unsaved typing lost — or the user stranded on the source.** User-initiated switch/duplicate/delete while dirty is blocked; programmatic selects (after duplicate, undo) are never blocked. Pinned in Task 9 + Task 10.
5. **Delete fails open.** A draft published between check and delete, or a guard query that errors, must never delete (test_variants CASCADE). Pinned in Task 6.

---

### Task 1: save-content items POST — variant ownership check (security prerequisite)

**Files:**
- Modify: `api/save-content.js` (items POST branch, ~L107–131)
- Test: `api/save-content.test.js` (append)

**Interfaces:** none new.

- [ ] **Step 1: Write failing tests** (reuse the file's `withFetch` / `authOkRouter` / `mockRes`):
  - `items POST with foreign variant -> 403, no upsert`: the router returns `[{ project_id: 'OTHER' }]` for `project_variants?id=eq.v1`. Assert `res.statusCode === 403`, `res.body.error === 'wrong_project'`, and no call whose URL contains `lp_editable_content` with method POST.
  - `items POST with unknown variant -> 404`: `project_variants` returns `[]`. Assert 404 with `not_found` and no upsert.
  - `items POST happy path still upserts`: `project_variants` returns `[{ project_id: 'p1' }]`. Assert 200 and exactly one POST to `lp_editable_content?on_conflict=variant_id,key`.
  - **Update the existing test** `regular content save (items) still works and does NOT trigger write-back` (~L127): its router must return `{ json: [{ project_id: 'p1' }] }` for `project_variants` GETs (it currently returns `[]`, which becomes 404 under the new check). Do not weaken the new check to make it pass.
- [ ] **Step 2:** `npm test`. Expected: the 403 and 404 tests FAIL.
- [ ] **Step 3: Implement.** After `authenticateAndAuthorize` succeeds and before building rows, GET `project_variants?id=eq.<variant_id>&select=project_id&limit=1` with `SB_HEADERS`. A non-ok response → 500 `server_error` (logged). Empty → 404 `not_found`. Mismatch → 403 `wrong_project`. Keep the existing 400 for missing fields.
- [ ] **Step 4:** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `fix(security): save-content checks variant belongs to project`.

### Task 2: apply-image ownership check — ONLY IF the user chose Option A

**Skip this task unless the launch brief says "apply-image: A".** The spec's "Open — user's call" section explains the choice.

**Files:** Modify `api/apply-image.js` (~L82–100). Test: `api/apply-image.test.js` (create).

- [ ] **Step 1:** Write two failing tests, using the same fetch-stub style as `save-content.test.js`.
  - Foreign variant → 403 `wrong_project`, with no POST to `lp_image_content` and no PATCH to `project_variants`.
  - Own variant → proceeds. Stub `ensureCached`'s storage calls, or assert only that the ownership GET happens before any write.
- [ ] **Step 2:** `npm test`. Expected: FAIL.
- [ ] **Step 3:** After `canAccessProject`, do the same `project_variants` ownership GET as Task 1, with the same status codes.
- [ ] **Step 4:** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `fix(security): apply-image checks variant belongs to project`.

### Task 3: Migration file

**Files:** Create `supabase/migrations/drop_editable_content_project_key_unique.sql`.

- [ ] **Step 1:** Write the file with a 3-line header comment. It must say:
  - why: the legacy pre-variants constraint blocks per-variant text rows
  - the prerequisite: Task 1 must be deployed to production first
  - "applied manually by the main session after user confirmation"

  The body is exactly:
  ```sql
  ALTER TABLE public.lp_editable_content
    DROP CONSTRAINT IF EXISTS lp_editable_content_project_id_key_key;
  ```
- [ ] **Step 2: Commit** `feat(variants): migration to drop legacy (project_id,key) unique`. Do NOT run it.

### Task 4: variant-ops pure helpers — slug + name picking

**Files:** Create `api/_lib/variant-ops.js` and `api/_lib/variant-ops.test.js`.

**Interfaces — Produces:**
- `pickSlug(existingSlugs: string[], opts?: { random?: boolean, rng?: () => number }) -> string`
  - When `random` is false: the first free letter in `a..z`, else the smallest free `v<N>` (N ≥ 1).
  - When `random` is true: a uniformly random free letter (using `rng`); if no letter is free, a uniformly random pick among the first 20 free `v<N>`.
  - Slug comparison is case-sensitive, and existing slugs are lowercase.
- `pickName(source: { variant_name: string|null, variant_slug: string, is_default: boolean }, existingNames: string[]) -> string`
  - base = `'הדף הראשי'` if `source.is_default && (!source.variant_name || source.variant_name === 'Default')`, else `source.variant_name || source.variant_slug`. This matches `variantDisplayLabel` in Task 8, so a renamed default keeps its new name.
  - The candidates are `${base} – עותק`, then `${base} – עותק 2`, `3`, and so on, until one is not in `existingNames`.
  - The separator is an en dash with a space on each side.
  - If a candidate is longer than 40 characters, truncate the **base** (trim the trailing space) so the full candidate is ≤ 40. The suffix is never cut.

- [ ] **Step 1: Write failing tests** with exact values:
  - `pickSlug(['default'])` → `'a'`
  - `pickSlug(['default','a','b'])` → `'c'`
  - all 26 letters plus `'v1'`, `'v3'` → `'v2'`
  - `pickSlug(['a'], { random: true, rng: () => 0 })` → `'b'`
  - `pickSlug(['a'], { random: true, rng: () => 0.9999 })` → `'z'`
  - all 26 letters taken, `pickSlug(letters, { random: true, rng: () => 0.9999 })` → `'v20'`
  - `pickName({variant_name:'Default',variant_slug:'default',is_default:true}, [])` → `'הדף הראשי – עותק'`
  - `pickName({variant_name:'גרסה מקורית',variant_slug:'default',is_default:true}, [])` → `'גרסה מקורית – עותק'`
  - `pickName({variant_name:null,variant_slug:'b',is_default:false}, [])` → `'b – עותק'`
  - with `existingNames` `['b – עותק']` → `'b – עותק 2'`
  - a 60-char base gives a result with length ≤ 40 that ends with `' – עותק'`
- [ ] **Step 2:** `npm test`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement both as pure functions. No I/O.
- [ ] **Step 4:** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(variants): slug and name pickers`.

### Task 5: `duplicateVariant` server operation

**Files:** Modify `api/_lib/variant-ops.js` and `api/_lib/variant-ops.test.js`.

**Interfaces:**
- Consumes: `pickSlug`, `pickName` (Task 4).
- Produces: `duplicateVariant({ projectId: string, sourceVariantId: string, sleep?: (ms) => Promise<void>, rng?: () => number }) -> Promise<{ status: number, body: object }>`
  - On success: `{ status: 200, body: { variant: <full project_variants row> } }`.
  - It reads `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from `process.env` at call time and uses global `fetch`.
  - `sleep` exists so tests skip the jitter.

Behavior (spec "duplicate-variant" steps 1–8):
1. GET the source with `select=*`. Missing → 404 `not_found`. `project_id !== projectId` → 403 `wrong_project`. Empty/whitespace `generated_html` → 400 `empty_source`.
2. GET `project_variants?project_id=eq.<p>&select=variant_slug,variant_name`.
3. POST `project_variants` with `Prefer: return=representation` and the fields:
   - `project_id`, `variant_slug`, `variant_name`, `generated_html`
   - `status:'draft'`, `is_default:false`

   Attempt 1 uses `pickSlug(slugs)`. A conflict means the response body has `code === '23505'` (and nothing else — a 409 with `23503` is an ordinary error → 500 `server_error`). On a conflict: re-read slugs and names, then `sleep(20 + rng*130)`, then retry with `pickSlug(slugs, { random: true })` and a recomputed name. Allow at most 10 attempts, then 409 `slug_exhausted`. Any other insert error → 500 `server_error`.
4. GET the source images (`lp_image_content?variant_id=eq.<src>&select=*`). If there are any, POST copies with:
   - `project_id: projectId` and the new `variant_id`
   - `slot, image_url, source, source_meta, enabled, display_size, display_shape`
5. GET the source text rows (`lp_editable_content?variant_id=eq.<src>&select=key,value`). If there are any, POST `{project_id: projectId, variant_id: new, key, value}`.
6. If step 4 or 5 fails (non-ok response or rejected fetch), DELETE `project_variants?id=eq.<new>`. If that DELETE also fails, `console.error` a message containing the orphan id. Either way return 500 `copy_failed`.

- [ ] **Step 1: Write failing tests** with a URL-routing fetch stub (same shape as `save-content.test.js` `withFetch`):
  - `happy path copies all three`: assert the inserted variant has `status:'draft'`, `is_default:false`, `variant_slug:'a'`, `variant_name:'הדף הראשי – עותק'`, and the source HTML. Assert the image POST body includes `enabled:false`, `display_size:'small'`, `display_shape:'circle'` from the stubbed source row, plus `project_id:'p1'` and the new id. Assert the text POST body has the new id and `project_id:'p1'`. Assert 200 and that `body.variant.id` is the new id.
  - `no text rows -> no text POST` (still 200).
  - `foreign source -> 403 wrong_project, zero POSTs`.
  - `missing source -> 404`. `empty html -> 400 empty_source`.
  - `slug conflict once then success`: the first insert returns `{ok:false,status:409,json:{code:'23505'}}`, and the slug re-read after it returns `['default','a']` (the race winner). Assert 2 inserts with different slugs and `sleep` called once. Pass a fixed `rng` so the test is deterministic.
  - `409 with code 23503 -> 500 server_error, one insert only`.
  - `source GET non-ok -> 500 server_error` (not 404).
  - `10 conflicts -> 409 slug_exhausted` (10 insert calls).
  - `image copy fails -> rollback DELETE of new id, 500 copy_failed`.
  - `rollback DELETE also fails -> console.error mentions new id, 500 copy_failed`. Stub `console.error` and capture the calls.
- [ ] **Step 2:** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement `duplicateVariant`.
- [ ] **Step 4:** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(variants): server-side duplicateVariant with retry and rollback`.

### Task 6: `deleteDraftVariant` server operation

**Files:** Modify `api/_lib/variant-ops.js` and its test file.

**Interfaces — Produces:** `deleteDraftVariant({ projectId: string, variantId: string }) -> Promise<{ status, body }>`. On success: `{ status: 200, body: { ok: true } }`.

Behavior:
1. GET the variant with `select=id,project_id,status,is_default`. Missing → 404 `not_found`. Wrong project → 403 `wrong_project`. `is_default` → 409 `is_default`. `status !== 'draft'` → 409 `not_draft`.
2. Count rows in `leads`, `analytics_events` and `test_variants` where `variant_id=eq.<id>`. Use `select=id&limit=1` on each; any row → 409 `has_data`. **Fail closed:** a non-ok response, a rejected fetch, or a body that is not an array on ANY guard query → 500 `server_error` with no DELETE. The same applies to the step-1 GET: non-ok → 500 `server_error`, and only an ok empty array means 404.
3. Run the conditional DELETE `project_variants?id=eq.<id>&project_id=eq.<p>&status=eq.draft&is_default=eq.false` with `Prefer: return=representation`. An empty array → 409 `not_draft`. A non-ok response → 500 `server_error`.

- [ ] **Step 1: Write failing tests:**
  - one test per refusal: `not_found`, `wrong_project`, `is_default`, `not_draft`, has leads, has analytics, in a test. Each asserts the code and that there is no DELETE call.
  - `clean draft -> 200`, with exactly one DELETE whose URL contains `status=eq.draft` and `is_default=eq.false`.
  - `published between check and delete -> DELETE returns [] -> 409 not_draft`.
  - `test_variants query 500 -> 500 server_error, zero DELETE calls`. Add the same test for `leads` returning a non-array object.
- [ ] **Step 2:** `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(variants): guarded deleteDraftVariant`.

### Task 7: Route the two actions in `api/admin.js`

**Files:** Modify `api/admin.js` (header comment + `switch` + two small handlers). Test: create `api/admin-variants.test.js`.

**Interfaces:**
- Consumes: `duplicateVariant` and `deleteDraftVariant` (Tasks 5–6).
- Produces the HTTP contract the dashboard uses:
  - `POST /api/admin { action:'duplicate-variant', project_id, source_variant_id, access_token? }` → `200 { variant }` or `{ error: code }`.
  - `POST /api/admin { action:'delete-draft-variant', project_id, variant_id, access_token? }` → `200 { ok:true }` or `{ error: code }`.
  - Auth uses the Authorization header or the body `access_token`.

Each handler does three things:
1. Missing `project_id` or variant id → 400 `missing_fields`, before any auth call.
2. `const auth = await authenticateAndAuthorize(req, res, { projectId: project_id }); if (!auth) return;`
3. Call the helper and `res.status(r.status).json(r.body)`. Wrap it in try/catch: `console.error`, then 500 `server_error`.

- [ ] **Step 1: Write failing tests** (fetch-stub style; auth as in `authOkRouter`):
  - missing `project_id` → 400 `missing_fields`, with zero fetch calls
  - no token → 401
  - happy duplicate → 200 with `variant`
  - happy delete → 200
- [ ] **Step 2:** `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add both actions to the header comment's route list.
- [ ] **Step 4:** `npm test`. Expected: pass. Also check `ls api/*.js | grep -v '\.test\.js' | wc -l` → `12`.
- [ ] **Step 5: Commit** `feat(variants): admin actions duplicate-variant and delete-draft-variant`.

### Task 8: Dashboard — bar placement, labels, full reload on switch

**Files:** Modify `dashboard.html`. Test: create `api/dashboard-variants.test.js`, which uses the `extractFn` pattern from `api/dashboard-preview-parity.test.js` plus source assertions.

**Interfaces — Produces (globals in `dashboard.html`):**
- `variantDisplayLabel(v) -> string`: returns `'הדף הראשי'` when `v.is_default && (!v.variant_name || v.variant_name === 'Default')`, else `v.variant_name || v.variant_slug`.

Changes:
- Move `<div class="variant-bar" id="variant-bar">` from inside `#tab-preview` (~L1526) to immediately before `<div class="tabs-bar">` (~L1503). Adjust CSS spacing only if needed.
- `renderVariantBar` uses `variantDisplayLabel(v)`.
- `switchTab`: hide `#variant-bar` when `name === 'email'`, otherwise restore it, still subject to the existing no-variants rule. To do that, factor a `updateVariantBarVisibility()` used by both `renderVariantBar` and `switchTab`.
- `selectVariant`: also refresh the image slots when the Images tab is active (`document.getElementById('tab-images').classList.contains('active')` → `loadImageSlots()`).
- `showAddVariantModal`: replace the trailing `selectedVariant = data; renderVariantBar(); loadPreview();` with `await selectVariant(data.id);`, keeping its toast. Nothing else in that function changes.
- **Out-of-order load guard** in `loadEditableContent` (~L4516) and `loadImageSlots` (~L3758):
  - Add module-level `let editLoadSeq = 0, imgLoadSeq = 0;`.
  - At the start of each function, capture `const vid = selectedVariant?.id; const seq = ++editLoadSeq;` (use `imgLoadSeq` in `loadImageSlots`).
  - After **every** `await`, run `if (seq !== editLoadSeq || selectedVariant?.id !== vid) return;` before touching the DOM, `projectContent`, or starting the backfill save.
  - The backfill auto-save (~L4738–4746) must use the captured `vid`, not `selectedVariant`. Replace its `.catch(() => {})` with `.catch(e => console.error('backfill save failed:', e))`.

- [ ] **Step 1: Write failing tests:**
  - **Out-of-order test:** extract `loadEditableContent` with linkedom. Stub `sb.auth.getSession`, `fetch` (manually resolvable promises per variant id), `selectedProject`, `selectedVariant`, and a `#edit-fields` container. Start load for variant A, switch `selectedVariant` to B, start load for B, resolve B first, then resolve A. Assert the container shows B's values and that `projectContent` holds B's rows. If extraction needs too many helpers, extract the guard into `isStaleLoad(seq, currentSeq, vid, currentVid) -> boolean` and test that instead, then add a source assertion that both functions call it after their awaits.
  - `variantDisplayLabel` → `{is_default:true,variant_name:'Default'}` gives `'הדף הראשי'`; `{is_default:false,variant_name:null,variant_slug:'b'}` gives `'b'`; `{is_default:true,variant_name:'Main page'}` gives `'Main page'`.
  - Source assertions: `dashboard.html` has the `id="variant-bar"` index < the `class="tabs-bar"` index; the `selectVariant` body contains `loadImageSlots`; the `showAddVariantModal` body contains `selectVariant(data.id)`.
- [ ] **Step 2:** `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(variants): variant bar on every tab, Hebrew default label, full reload on switch`.

### Task 9: Dashboard — unsaved guard + Hebrew error mapping

**Files:** Modify `dashboard.html`. Test: `api/dashboard-variants.test.js` (append).

**Interfaces — Produces:**
- `let editDirty = false;`
  - Set it to `true` on any `input` event inside `#edit-fields` (one delegated listener), and in `clearEditField` (~L4973), which sets `.value` without firing `input`.
  - Set it to `false` at the **start** of `loadEditableContent`, right where `container.innerHTML` replaces the fields, and after a successful `saveContent`.
- `guardUnsaved() -> boolean`: if `editDirty`, it calls `showToast(<unsaved-changes toast>, 'error')` and returns `false`; otherwise it returns `true`.
- `variantErrorMessage(code: string|undefined, status?: number) -> string`: exactly the "Hebrew strings" table.
- `onVariantPillClick(id)`: `if (!guardUnsaved()) return; selectVariant(id);`. The pill's `onclick` calls this instead of `selectVariant`.
- A **ביטול שינויים** button next to the Edit-text save button (`#btn-save-content`, ~L1583). It is shown only while `editDirty`; clicking it calls `loadEditableContent()`, which discards the typing and clears the flag.

Changes:
- `guardUnsaved()` is called ONLY at user-initiated entry points: `onVariantPillClick`, the start of `showAddVariantModal`, `duplicateVariant()` (Task 10) and `stageDeleteVariant()` (Task 12). **`selectVariant` itself is never guarded**, because programmatic calls after async work (post-duplicate, undo, add) must always land.
- `saveContent` (~L5025): replace `'שגיאה: ' + …` with `variantErrorMessage(...)`. A 404, or a body/detail mentioning `23503`, maps to `not_found`. Keep `console.error` of the raw detail.
- `togglePublish` (~L4458): the same replacement for its error toast. Also change its variant update to `.update({ status }).eq('id', id).select()`. Zero rows → `variantErrorMessage('not_found')`, with no local status change and no `projects.status` update.

- [ ] **Step 1: Write failing tests:**
  - Extract `variantErrorMessage` and assert every row of the strings table, including `(undefined, 401)` and `(undefined, 403)`. The fallback matches `/[֐-׿]/` and contains no `[A-Za-z]`.
  - Extract `guardUnsaved` with a stubbed `showToast` and `editDirty`, and assert both branches.
  - Source assertions:
    - the `selectVariant` body does NOT contain `guardUnsaved`
    - `onVariantPillClick` does contain it
    - `renderVariantBar` pills use `onVariantPillClick(`
    - `clearEditField` sets `editDirty = true`
    - the first statements of `loadEditableContent` set `editDirty = false`
    - `togglePublish`'s variant update contains `.select()`
  - Source assertion: the `saveContent` and `togglePublish` bodies no longer contain `'שגיאה: ' +`.
- [ ] **Step 2:** `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(variants): unsaved-changes guard and Hebrew errors on variant paths`.

### Task 10: Dashboard — שכפול button

**Files:** Modify `dashboard.html`. Test: append to `api/dashboard-variants.test.js`.

**Interfaces:**
- Consumes: `POST /api/admin duplicate-variant` (Task 7), `variantErrorMessage`, `guardUnsaved`, `selectVariant`.
- Produces: `async function duplicateVariant()` (dashboard global) and `let dupInFlight = false;`.

Behavior:
- `renderVariantBar` appends `<button class="btn-add-variant" id="btn-duplicate-variant" onclick="duplicateVariant()">שכפול</button>` after `+ וריאנט`. Its `title` is a Hebrew tooltip explaining what it does. It is `disabled` when `!selectedVariant?.generated_html?.trim()` or `dupInFlight`.
- `duplicateVariant()`:
  1. If `dupInFlight` or `!guardUnsaved()`, return.
  2. Set `dupInFlight = true` synchronously, then set the button text to `משכפל…` and disable it.
  3. Get the token and POST `/api/admin` with `{ action:'duplicate-variant', project_id, source_variant_id }` and an `Authorization: Bearer` header.
  4. On OK: push `body.variant` into `projectVariants` and `await selectVariant(id)`. Only `if (selectedVariant?.id === body.variant.id)` (the user may have switched project meanwhile): `switchTab('edit', document.querySelector('[data-tab="edit"]'))`, then the duplicate success toast.
  - While `dupInFlight`, disable the `#edit-fields` inputs and textareas, and re-enable them in `finally`. That way no typing can land on the source during the copy.
  5. On non-OK or a rejected fetch: `console.error` the detail and toast `variantErrorMessage(body?.error)`.
  6. `finally`: `dupInFlight = false; renderVariantBar();`.

- [ ] **Step 1: Write failing source tests:** `renderVariantBar` contains `btn-duplicate-variant`; the `duplicateVariant` body contains `dupInFlight = true` before the first `await`, contains `'duplicate-variant'`, and contains `switchTab('edit'`.
- [ ] **Step 2:** `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(variants): duplicate button`.

### Task 11: Dashboard — rename

**Files:** Modify `dashboard.html`. Test: append.

**Interfaces — Produces:**
- `startRenameVariant()`, `endRenameVariant(commit: boolean)`, and `let renameState = null;`. While editing, `renameState` is `{ id, original }`; it is `null` otherwise.
- `normalizeVariantName(raw: string) -> string|null`: returns the trimmed name, or `null` if it is empty or longer than 40 characters.

Behavior:
- In `renderVariantBar`, the active pill gets a **sibling** `<button class="variant-rename-btn" onclick="startRenameVariant()" title="שינוי שם">✎</button>`. It must not be nested inside the pill button.
- `startRenameVariant` replaces the active pill with an `<input maxlength="40">` prefilled with `variantDisplayLabel`, focuses it, and sets `renameState`.
  - keydown Enter → `endRenameVariant(true)`
  - keydown Esc → `endRenameVariant(false)`
  - blur → `endRenameVariant(true)`
- `endRenameVariant(commit)`:
  1. If `renameState` is null, return. This makes every later event a no-op.
  2. Capture the state, then set `renameState = null`.
  3. If `commit`, the normalized name is valid, and it differs from the original: run `sb.from('project_variants').update({ variant_name }).eq('id', id).select()`. An error or zero rows → `console.error` plus a Hebrew toast and the name stays unchanged. Success → update `projectVariants` and `selectedVariant`.
  4. An invalid name → the "rename invalid" toast from the strings table.
  5. Finally, `renderVariantBar()`.
- `renderVariantBar` and `selectVariant` call `endRenameVariant(false)` first when `renameState` is set.

- [ ] **Step 1: Write failing tests:**
  - Extract `normalizeVariantName`: `'  א  '` → `'א'`, `''` → `null`, 41 chars → `null`, 40 chars → kept.
  - Source assertions: the rename button markup appears outside the pill's `</button>`; the `endRenameVariant` body sets `renameState = null` before its first `await`; the update chain contains `.select()`.
- [ ] **Step 2:** `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(variants): inline rename`.

### Task 12: Dashboard — delete draft with undo

**Files:** Modify `dashboard.html` (markup for the undo toast, CSS, JS). Test: append.

**Interfaces:**
- Consumes: `POST /api/admin delete-draft-variant` (Task 7), `variantErrorMessage`, `guardUnsaved`.
- Produces: `let pendingDelete = null;`. While a delete is pending it is `{ variant, index, prevSelectedId, projectId, token, timer }`.
- Produces: `let deleteStaging = false;`, a synchronous re-entry flag.
- Produces: `stageDeleteVariant()`, `undoDeleteVariant()`, `function flushPendingDelete({ keepalive = false } = {})`.
- Produces: `filterPending(list) -> list`, which removes `pendingDelete?.variant.id` from the list.

Behavior:
- `renderVariantBar` shows a quiet sibling control `<button class="variant-delete-btn" onclick="stageDeleteVariant()">מחיקת טיוטה</button>` only when `selectedVariant.status === 'draft' && !selectedVariant.is_default`.
- `stageDeleteVariant()`:
  1. If `deleteStaging` or `!guardUnsaved()`, return.
  2. Synchronously set `deleteStaging = true` and capture `const target = selectedVariant`. If `target` is missing, `is_default`, or not a draft, reset the flag and return. Wrap the rest in try/finally so `deleteStaging = false` always runs.
  3. If a delete is already pending, `flushPendingDelete()` it first.
  4. Capture the token (`await sb.auth.getSession()`). After that await, if `selectedVariant?.id !== target.id`, return without changes.
  5. Splice `target` (by id, never the default) out of `projectVariants` into `pendingDelete`, with `projectId: selectedProject.id`.
  5. `await selectVariant(default.id)`.
  6. Show `#undo-toast`: a dedicated element with its own CSS, Hebrew text, and a **ביטול** button calling `undoDeleteVariant()`.
  7. Set `timer = setTimeout(() => flushPendingDelete(), 6000)`.
- `undoDeleteVariant()`: clear the timer, splice the variant back in at `index`, `selectVariant(prevSelectedId)`, hide the toast, and set `pendingDelete = null`.
- `flushPendingDelete({ keepalive })`:
  1. If nothing is pending, return.
  2. Take the pending item, set `pendingDelete = null`, clear the timer, and hide the toast.
  3. `fetch('/api/admin', { method:'POST', keepalive, headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'delete-draft-variant', project_id, variant_id, access_token: token }) })`.
  4. If `keepalive` is set, do not await. Otherwise await, and when the result is not OK (or the fetch rejects):
     - `console.error` the detail.
     - **Only if `selectedProject?.id === pending.projectId`**, restore the variant at its index and run `renderVariantBar()`.
     - Always toast `variantErrorMessage(body?.error, status)`.
- Flush triggers:
  - at the top of `selectProject` → `flushPendingDelete()`
  - `window.addEventListener('pagehide', () => flushPendingDelete({ keepalive: true }))`. The handler is synchronous and has no awaits.
- `selectProject`'s `projectVariants = variants || []` becomes `projectVariants = filterPending(variants || [])`. Apply the same to any other re-fetch of the variant list in `dashboard.html`; grep `from('project_variants')` to find them.

- [ ] **Step 1: Write failing tests:**
  - Extract `filterPending` with a stubbed `pendingDelete` and assert the pending id is removed.
  - Source assertions: `#undo-toast` exists and is not `#toast`; the `pagehide` listener passes `keepalive: true`; the `flushPendingDelete` body sets `pendingDelete = null` before the `fetch`; the `selectProject` body calls `flushPendingDelete(` and `filterPending(`.
- [ ] **Step 2:** `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(variants): delete draft with undo`.

### Task 13: Final local check (builder)

- [ ] `npm test` → all pass (207 + the new tests).
- [ ] `ls api/*.js | grep -v '\.test\.js' | wc -l` → `12`.
- [ ] `git diff origin/main --stat -- api/serve-lp.js api/serve-test.js api/_lib/lp-renderer.js vercel.json` → empty.
- [ ] Open `dashboard.html` in a headless check if available. Otherwise `node -e` parse every inline `<script>` with `new Function(...)` and confirm there are no syntax errors.
- [ ] Report: the commit list, the test counts, anything skipped (e.g. Task 2), and any spec point the builder had to interpret.

### After the build (main session, NOT the builder)

The deploy order and the manual checks follow spec "Verification" 1–10:
1. Cherry-pick the Task 1 commit (and Task 2's, if A) onto a new branch from `origin/main`. Open a PR, deploy a preview, run Verification 9 (cross-tenant save → 403), merge, and confirm the production deploy.
2. **Ask the user**, then apply the migration to `uaspcafukqvgiztzdnfu`.
3. Open the feature PR, deploy a preview, and run Verification 1–8 and 10 on a test project. Then merge.
4. Before Feb 9: run the read-only check of role community vs project community for the classroom accounts (spec "Classroom readiness").

## Accepted edge cases (documented, not built)

- Rename: while the rename input is open, a click on another pill commits the rename (on blur) and re-renders the bar, so that first click is lost and the user must click again. Accepted.
