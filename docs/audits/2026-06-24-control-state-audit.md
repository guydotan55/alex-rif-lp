# Control-State Audit — Messaging Lab admin UI

**Date:** 2026-06-24 · **Branch:** `chore/control-state-audit` · **Scope:** dashboard.html, new.html, admin.html, settings.html, reports.html, feedback-widget.js

Triggered after two production bugs (planner `%`/`₪` overlap; "צור טסט" button stuck disabled). Goal: understand *why* they happened and find every sibling instance so the class can't recur.

## How this was produced

A dynamic multi-agent workflow: each (file × lens) cell got a dedicated hunter, and **every finding was adversarially re-verified** by an independent agent told to refute it (default "not a bug" unless a real broken user-flow with no compensating path was proven). 24 cells × 4 lenses, 108 agents, ~6M tokens. Raw findings 81 → survived verification **57**.

**Confirmed: 57** — 17 high, 25 medium, 15 low.

| By class | n | | By file | n |
|---|---|---|---|---|
| silent-failure | 26 | | dashboard.html | 15 |
| stuck-control | 14 | | new.html | 15 |
| stale-state | 11 | | reports.html | 9 |
| rtl-direction | 6 | | settings.html | 8 |
|  |  | | admin.html | 5 |
|  |  | | feedback-widget.js | 5 |

## Root cause — why Bug A and Bug B happened (and keep happening)

Both came from **one mistake: UI that is *derived* from some state was wired to only *some* of the events/paths that change that state.**

- **Bug A (logic):** the button's `disabled` is derived from `testModalSelectedLPs.length` via `_updateActivateGating()`. The feature wired that gate to planner-field input and modal-open, but not to `toggleTestLP()` — the one handler that actually changes the selection. State changed; the dependent control went stale.
- **Bug B (position):** a unit symbol's *position* is derived from text direction. The feature hard-coded a physical side (`left`) that's right for LTR and wrong for this `dir=rtl` page. Position was never wired to the real driver (direction).

The audit shows this is **systemic, not two one-offs.** The same shape appears 57 times in four flavours:

1. **Dropped `{error}` (26×, the biggest):** `const { data } = await sb...` discards `{error}`. A query failure (network/RLS/transient) then renders as the *wrong derived state* — "you have no permission" + logout, an empty list, "no community exists". This is Bug A from the data side: the error is an input the UI depends on, but only the `data` path is wired.
2. **Stale-success UI on the failure path (Bug A, literally):** failed image re-uploads (hero/fold2/brief-hero/brief in new.html) leave the previous success UI + stale URL in place because the `catch` doesn't reset them.
3. **No `finally{}` reset (stuck controls):** a button set `disabled`/spinner at the start of an async action is never reset on the error/early-return path → permanently stuck (saveContent, generateLP, settings login, feedback widget).
4. **RTL physical-direction (Bug B, literally):** hardcoded `left:`/`right:` overlays land on the wrong side — the new.html delete-X over the remix button, the settings select caret, the feedback widget FAB.

## Prevention — make the class hard to reintroduce

Codebase-specific, cheapest-first:

1. **One refresh function per modal/view; every mutation path calls it.** The planner fix already did this (route `toggleTestLP` → `updatePlannerResults` → the gate). Make it the rule: any handler that changes selection/inputs/mode ends by calling the single `refresh<Thing>()` that recomputes *all* derived UI (enable/disable, visibility, counts). No control recomputed in only one handler.
2. **Never write `const { data } = await sb...` without `error`.** Grep-able lint: a `const { data` from a Supabase call must be `const { data, error }` and handle `error` (Hebrew toast + keep prior state; do **not** treat a query error as "empty"/"no permission"). This single rule kills ~26 findings.
3. **Async buttons reset in `finally{}`.** Pattern: `btn.disabled=true; try{…}catch(e){showToast(...)}finally{btn.disabled=false; /* clear spinner */}`. Covers the stuck-control class.
4. **Upload `catch` must roll back its own success UI + URL var** (mirror what the success path set), so a failed re-upload can't masquerade as success.
5. **Use CSS logical properties in this `dir=rtl` app:** `inset-inline-start/end`, `padding-inline`, `margin-inline` instead of `left`/`right`/`padding-left`. Removes the whole RTL-direction class.
6. **Per-modal smoke check (manual or Playwright):** open → submit with the network forced to fail → assert the control recovers and a Hebrew error shows. This is exactly the gap that let both production bugs ship un-clicked.

## Full catalog

### Silent failure — error/empty result with no user feedback (incl. Supabase `{error}` dropped) (26)

| sev | file:lines | issue | fix |
|---|---|---|---|
| 🔴 HIGH | admin.html: admin.html:644-657, admin.html:649, admin.html:650 | loadData() swallows leads/events errors to console only, rendering a fetch failure as an empty (zero-traffic) dashboard | Surface the error in the data tab UI. Add an err element to #tab-data, and in loadData() if leadsRes.error // eventsRes.error, render a visible Hebrew banner in… |
| 🔴 HIGH | admin.html: admin.html:818-828, admin.html:820 | loadSettings() early-returns on error with no UI message, leaving the email form silently blank/stale | On error, write a visible Hebrew message into the existing cheb-email-err / alex-email-err elements (or a tab-level banner) and/or disable the שמור buttons unti… |
| 🔴 HIGH | dashboard.html: 5437-5457, 5453, 5491-5499 | searchStockManual ignores res.ok / data.error — API failure renders an empty grid with no message | Mirror generateAiManual: after const data = await res.json(), do if (!res.ok // data.error) { document.getElementById('stock-results').innerHTML = `<p style="co… |
| 🔴 HIGH | dashboard.html: 5397-5412, 5409 | selectDirection stock branch ignores res.ok / data.error — clicking a direction chip can silently show nothing | In the isStock branch, after const data = await res.json(), add if (!res.ok // data.error) { document.getElementById('stock-results').innerHTML = `<p style="col… |
| 🔴 HIGH | feedback-widget.js: feedback-widget.js:233, feedback-widget.js:235, feedback-widget.js:236-240 | Screenshot silently does nothing when canvas.toBlob() yields null | Treat a null blob as a failure, not a no-op. Either reject inside the Promise — `new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob… |
| 🔴 HIGH | new.html: 2632-2644, 2574, 2719-2720 | setupUserRole drops query {error} -> transient failure misreported as 'no permission' + force-logout (password path: app shown over dead ses… | capture {error}; distinguish PGRST116 from transient; don't signOut on transient; honor return at 2574 |
| 🔴 HIGH | settings.html: 736, 737, 738 | Real DB/RLS error on user_roles query is misread as "no role" and silently logs the admin out | Destructure the error: `const { data: roleData, error: roleErr } = await sb.from('user_roles')...`. If roleErr exists AND it is not the PostgREST 'no rows' code… |
| 🔴 HIGH | settings.html: 715, 716, 717 | doLogout() never checks signOut() result — UI shows the login screen even when the session was NOT actually destroyed | Capture and handle the result: `const { error } = await sb.auth.signOut(); if (error) { showToast('שגיאה בהתנתקות, נסו שוב','error'); return; }` and only swap t… |
| 🟠 MED | admin.html: admin.html:865-873, admin.html:867 | loadLpContent() early-returns on error with no UI message, leaving LP content fields silently empty | On error, populate the existing c-cheb-err / c-alex-err elements with a Hebrew failure message and/or block saveContent until a successful load, so a failed rea… |
| 🟠 MED | dashboard.html: 3163-3169, 3171-3175, 3165 | copyTestUrl / copyText show "הועתק!" without awaiting clipboard write — false success on failure | Await the write and branch on it: navigator.clipboard.writeText(text).then(() => { btn.textContent = 'הועתק!'; setTimeout(...); }).catch(() => { btn.textContent… |
| 🟠 MED | dashboard.html: 5540-5544, 5619-5630, 5629 | saveToLibrary swallows errors; saveBtn onclick then claims '✓ נשמר!' on failure | Make saveToLibrary return success (e.g. return !error) or throw on error, and have the onclick branch: const ok = await saveToLibrary(...); if (ok) { saveBtn.te… |
| 🟠 MED | dashboard.html: 5632-5660, 5641, 5648 | loadLibrary drops {error} — a failed query shows the 'no images yet' empty state | Destructure error too and branch: const { data: images, error } = await ...; loading.style.display='none'; if (error) { console.error('library:', error); empty.… |
| 🟠 MED | dashboard.html: 2462-2477, 2467, 2472-2476 | toggleTestLP drops {error} — query failure shows 'this project has no published variants' | Destructure error and surface it distinctly: const { data: variants, error } = await ...; if (error) { checkbox.checked=false; console.error('toggleTestLP:', er… |
| 🟠 MED | dashboard.html: 4290-4309, 4299, 3570-3576 | loadEditableContent fetch has no try/catch — a rejected fetch leaves a permanent spinner and rejects selectProject's Promise.all | Wrap the fetch/parse in try/catch (like loadAnalytics does): on catch, set #edit-fields to a Hebrew error with a retry, console.error, and return. Separately, g… |
| 🟠 MED | dashboard.html: 4749-4789, 4756, 4770 | saveContent fetch path has no try/catch / finally — a rejected fetch leaves the Save button permanently disabled | Wrap the fetch+parse in try/catch and move btn.disabled = false into a finally. In catch, show #save-content-err with a Hebrew message (e.g. 'שגיאת רשת — נסה שו… |
| 🟠 MED | new.html: 2428-2431, 2480-2488 | Remix 'שפר' failure shows only 2s ❌; server error discarded | showToast('שגיאה בשיפור: '+err.message) |
| 🟠 MED | new.html: 2494-2506, 2511-2524 | .txt brief read outside try/catch -> label stuck at 📄, brief submitted without file content | wrap .txt branch in try/catch mirroring PDF/DOCX else-branch |
| 🟠 MED | new.html: 2107-2118 | generateSlug ignores {error} -> base+'-1', unique-constraint collision shown as raw Postgres error | capture {error}; throw Hebrew message |
| 🟠 MED | reports.html: 120, 121, 122 | Role query drops {error}: a transient/RLS failure renders the super-admin's own page as access-denied | Capture the error and fail loud + distinguish it from a true denial: `const { data: role, error: roleErr } = await sb.from('user_roles')...single();` then `if (… |
| 🟠 MED | reports.html: 100, 115, 116 | init() IIFE has no try/catch around getSession()/role query: a rejection leaves the page stuck on 'טוען…' forever | Wrap the IIFE body in try/catch and surface a loud error: on catch, replace the placeholder with a visible message ('שגיאה בטעינת הדף. רענן ונסה שוב.') and `con… |
| 🟠 MED | reports.html: 145, 146, 148 | Signed-URL failure is logged but gives the admin no feedback: attachments silently vanish from the bug report | When attachments exist but their URLs failed, show a visible hint instead of nothing: track whether any attachment had a path but no signedUrl and append a smal… |
| 🟡 LOW | admin.html: admin.html:614-618, admin.html:616-617 | showDash() runs Promise.all of 5 loaders with no try/catch after the dashboard is already displayed | Wrap the Promise.all in try/catch (or use Promise.allSettled so one failing loader can't abort the others) and surface a visible Hebrew error toast/banner; each… |
| 🟡 LOW | dashboard.html: 3339-3357, 3349-3352, 3354-3356 | Kickoff-email catch in toggleTestStatus is silent (no user feedback on a thrown/rejected send) | Mirror the else branch inside the catch: alert/toast 'הטסט פעיל. שליחת מייל פתיחה נכשלה — בדוק לוגים.' in addition to console.error, so both failure modes infor… |
| 🟡 LOW | new.html: 2218-2223, 2303-2308 | fallback-community lookup drops {error} -> mislabeled 'no community exists' | capture {error}; throw real message |
| 🟡 LOW | new.html: 2582-2597 | check-email gate empty catch (no log) -> silently bypassed on outage | keep fail-open but console.warn |
| 🟡 LOW | settings.html: 680, 685, 686 | doLogin() empty catch swallows the email-allowlist check failure with no log and no user signal | At minimum log it: `catch (e) { console.error('check-email failed, proceeding fail-open', e); }` so the deliberate fail-open is observable. Keep the proceed-any… |

### Stuck / unrecoverable control — disabled/spinner/overlay with no path out (14)

| sev | file:lines | issue | fix |
|---|---|---|---|
| 🔴 HIGH | admin.html: admin.html:643-657, admin.html:644, admin.html:655 | Data-tab loading spinners (funnel + both leads tables) spin forever when the leads/events query rejects — loadData has no try/catch and only… | Wrap loadData's body in try/catch. In catch, replace each spinner container's innerHTML with a human Hebrew error + a retry control (e.g. a 'נסו שוב' button cal… |
| 🔴 HIGH | dashboard.html: 1540-1544, 4126-4127, 4137 | 20-60s generateLP() is a bare spinner: no cancel, no AbortController/timeout, no changing progress, no ETA | Wrap the two fetches in an AbortController with a timeout (e.g. 90s -> abort + Hebrew 'נתקענו, נסו שוב' + retry). Add a 'ביטול' button to #gen-progress that cal… |
| 🔴 HIGH | dashboard.html: 4756, 4769-4780, 4783-4789 | saveContent() save button permanently stuck disabled on any network/JSON error (no try/catch around fetch) | Wrap the fetch/json in try/catch (or add a finally that does btn.disabled=false). On catch, show errEl with a human Hebrew message and re-enable the button so t… |
| 🔴 HIGH | reports.html: 120, 121, 122 | Transient role-query error renders as a permanent "super-admin only" lockout (drops {error} trigger) | Capture and branch on the error: `const { data: role, error: roleErr } = await sb.from('user_roles').select('role').eq('user_id', session.user.id).maybeSingle()… |
| 🔴 HIGH | settings.html: 671, 677, 692-694 | Login button stays permanently disabled showing 'שולח...' if signInWithOtp throws | Wrap the signInWithOtp call in try/catch (or move the whole OTP block into the existing try, or add a finally). On any thrown error, run the same recovery as th… |
| 🔴 HIGH | settings.html: 705 | Login form is destroyed on send, leaving no recovery if the magic link never works | Instead of replacing the whole form, show the confirmation message ALONGSIDE a 'שלח שוב' / 'כתובת שגויה? נסו שוב' link/button that restores the email field and … |
| 🟠 MED | dashboard.html: 1966, 2678-2745 | createTest() submit button never disabled during multi-step async insert — double-click creates duplicate tests | At the top of createTest(), capture btn = document.getElementById('btn-create-test-submit'), set btn.disabled=true, and re-enable it in a finally (or before eve… |
| 🟠 MED | feedback-widget.js: 228-241, 229, 231 | Screenshot hides the panel before an un-timed CDN load; if html2canvas never loads, the panel stays invisible forever | Add a timeout (and AbortController-style guard) to ensureHtml2canvas so the await always settles: in the returned Promise, start `var to = setTimeout(function()… |
| 🟠 MED | new.html: new.html:2046-2052, new.html:1851-1856, new.html:1898-1903 | Image-upload failure leaves the progress bar full and visible forever, and re-picking the SAME file does nothing — the only escape is choosi… | In every upload catch block: reset the input so a retry of the same file works (e.g. input.value='' after handling), set fillEl.style.width='0%' (or hide progre… |
| 🟠 MED | new.html: new.html:2503-2506, new.html:2499, new.html:2511-2524 | brief_file .txt branch has no try/catch — a failed file.text() read leaves the document-icon label with no error and no recovery | Wrap the .txt branch in try/catch mirroring the else-branch: on success set the ✅ label, on failure show '❌ שגיאה בקריאת הקובץ' and clear the input (this.value=… |
| 🟡 LOW | dashboard.html: 1756-1763, 1843-1847, 5300 | Image-picker and create-test modals cannot be dismissed by Escape or backdrop click — X button only | Add a document keydown listener that closes whichever modal is open on Escape, and a click handler on each modal's backdrop element (e.target === modalRoot) tha… |
| 🟡 LOW | dashboard.html: 1686, 3299-3361 | Activate/Pause test button not guarded during slow per-variant check + kickoff email — double-fire | Disable #btn-test-activate at the start of toggleTestStatus() and re-enable in a finally, mirroring the busy-guard pattern, so the slow activation can't be doub… |
| 🟡 LOW | reports.html: 100, 115, 116 | Unhandled rejection in init() leaves the page stuck on 'טוען…' forever with no error or retry | Wrap the body of init() in try/catch (or append `.catch(...)` to the IIFE). In the catch, clear #tickets-list and render a visible, console-logged error with a … |
| 🟡 LOW | reports.html: 296, 303, 313 | Action buttons have no double-submit guard during the slow await loadTickets() re-render | At the top of each handler set the clicked button's disabled=true (and optionally change its text to a 'מעדכן…' state); since loadTickets() re-renders fresh car… |

### Stale derived state — UI computed from state, not refreshed on a mutation path (Bug A's class) (11)

| sev | file:lines | issue | fix |
|---|---|---|---|
| 🔴 HIGH | new.html: 1881 (filePath new each call), 1890 (heroImageUrl set on success only), 1896-1897 (success-only UI reveal) | Failed hero re-upload leaves stale success UI + stale heroImageUrl (mode panel stays open, skip hint stays hidden, old URL still submitted) | In the catch block (and at the top of handleHeroUpload before the async work), reset the derived UI: heroImageUrl = null; document.getElementById('heroModeChoic… |
| 🔴 HIGH | new.html: 1986-1992 (preview.src set BEFORE upload, unconditionally), 2030-2034 (URL set on success only), 2046-2052 (catch: no URL reset) | Failed main brand-image re-upload leaves stale uploadedImageUrl/briefUploadedImageUrl; required-image validation passes on a dead URL | In uploadToStorage catch, set uploadedImageUrl=null / briefUploadedImageUrl=null (matching isQuestionnaire), and re-show the relevant err-image element so requi… |
| 🟠 MED | feedback-widget.js: 194, 350, 351 | close() forgets to reset the send-button spinner, so closing mid-submit leaves a permanent spinning loader with an enabled "שליחה" button | Make close() reset the full button visual state, mirroring submit's error branch: in close() add `planeIcon.className = ''; planeIcon.textContent = '➤';` alongs… |
| 🟠 MED | feedback-widget.js: 194, 195, 347 | Successful submit reaches resetForm()+close() but a close() that races a pending submit can re-enable send while uploadAttachments still hol… | Introduce an explicit `var submitting = false;` flag. Set it true at the top of submit() and bail if already true (`if (submitting) return;`), set it false in a… |
| 🟠 MED | new.html: 1843 (briefHeroImageUrl set on success only), 1849-1850 (success-only UI reveal), 1851-1856 (catch: no reset) | Failed brief-hero re-upload leaves stale success UI + stale briefHeroImageUrl | Reset briefHeroImageUrl=null and restore briefHeroModeChoice (display:none) / briefHeroSkipHint (display:'') in the catch block, and clear them at the start of … |
| 🟠 MED | new.html: 1937 (fold2ImageUrl set on success only), 1943 (fold2ModeChoice shown on success), 1944-1949 (catch: no reset) | Failed fold2 re-upload leaves stale success UI + stale fold2ImageUrl | In the catch block reset fold2ImageUrl=null and document.getElementById('fold2ModeChoice').style.display='none'; also reset at the start of handleFold2Upload. |
| 🟠 MED | new.html: 2519 (dataset.uploadedUrl set on success only), 2521-2524 (catch: no dataset reset, only label), 2270-2274 (submitBrief reads dataset.uploadedUrl) | Brief-file (PDF/DOCX) failed re-upload keeps stale dataset.uploadedUrl from a prior success | In the catch block, delete document.getElementById('brief_file').dataset.uploadedUrl (and ideally at the start of the handler before re-uploading) so a failed r… |
| 🟠 MED | reports.html: reports.html:160, reports.html:129-140, reports.html:130-131 | #count badge goes stale on the loadTickets() error path (and stays stale during reload) — only renderList() ever writes it | Make the count a function of the SAME state transitions as the list. Clear/replace #count on every non-success branch of loadTickets: in the error branch (after… |
| 🟠 MED | settings.html: settings.html:812, settings.html:814, settings.html:862 | communities/users arrays left stale after a failed reload — invite-modal community <select> is then built from data the table just declared … | In both catch blocks, decide on one consistent policy and apply it to BOTH the array and the derived UI: simplest is to reset the array to [] on error (`communi… |
| 🟡 LOW | dashboard.html: 5297-5306, 5313-5319, 5501-5509 | Image-picker apply bar + selectedPickerImage not reset when switching picker tabs (stale selection survives tab change) | In switchPickerTab(), before showing the new panel, clear the cross-tab selection: set selectedPickerImage = null and document.getElementById('picker-apply-bar'… |
| 🟡 LOW | settings.html: settings.html:1011, settings.html:1013, settings.html:999 | Manager invite is unrecoverably blocked when communities failed/empty — validation derives an error but the dropdown it points at has no opt… | Make the derived UI reflect the empty/failed source: when role becomes manager and communities.length === 0, show an inline hint ('צרו קהילה קודם' / 'הקהילות לא… |

### RTL physical-direction — hardcoded left/right in a dir=rtl app (Bug B's class) (6)

| sev | file:lines | issue | fix |
|---|---|---|---|
| 🔴 HIGH | new.html: new.html:346-351, new.html:1679-1695, new.html:1682-1684 | Feature-card delete X (left:12px) lands on top of the '✨ שפר' remix button that RTL flex-space-between also pushes to the top-left | Stop pinning the remove-btn to the same corner RTL uses for the remix button. Either (a) move the remove X to the logical start corner with inset-inline-start:1… |
| 🟠 MED | settings.html: settings.html:150-167, settings.html:152, settings.html:166 | Custom select caret pinned to physical left with no matching left padding — collides with right-aligned Hebrew text | Reserve space on the caret's side. Add an asymmetric padding so the caret never overlaps text, e.g. change padding to '12px 16px 12px 36px' (extra left padding)… |
| 🟡 LOW | feedback-widget.js: feedback-widget.js:298, feedback-widget.js:299, feedback-widget.js:84-86 | Locate-on-page pick label positioned with LTR-only math (anchors to element's physical-left, clamps only the right edge) | Align the label to the element's start edge in a direction-aware way: detect host direction (getComputedStyle(document.documentElement).direction) and anchor to… |
| 🟡 LOW | new.html: feedback-widget.js:287-299, feedback-widget.js:84-86 | feedback-widget element-picker label always anchors to r.left and only clamps on the right edge — never flips to the RTL/logical start of th… | Anchor the label to the logical start of the element in RTL: use r.right - lbl.offsetWidth (clamped to the viewport) when the host/element direction is rtl, or … |
| 🟡 LOW | reports.html: reports.html:2, reports.html:324, feedback-widget.js:41 | FAB and panel hardcoded to physical-left, ignoring host page dir (RTL-start corner is the right) | Anchor the FAB and panel to the leading inline side using logical positioning: replace `left:22px` with `inset-inline-start:22px` (resolves to right under dir=r… |
| 🟡 LOW | reports.html: reports.html:324, feedback-widget.js:84-86, feedback-widget.js:293-299 | Locate-mode pick-label anchored to element's physical-left edge, drifts to the wrong end of wide RTL elements | Anchor the label to the element's leading edge in RTL: prefer `r.right - lbl.offsetWidth` (clamped to >=8) when the page is RTL, or compute the start edge via g… |

---

_Note: a few `reports.html` RTL/stuck entries are really `feedback-widget.js` issues surfaced because reports.html loads that widget — counted once at the widget where the fix belongs._