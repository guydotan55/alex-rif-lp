# CPL Per-Variant — Design (extension to test-planner-emails)

**Status:** Draft, awaiting user review
**Date:** 2026-05-05
**Branch:** `feat/test-planner-emails` (extends the same branch — ships as part of the same PR or as a follow-up commit set on top of `ad879ce`)
**Scope:** Approach A — locked decisions + spend-floor gate + three-line CR≠CPL output + Agent B's exact Hebrew copy. Kill-switch deferred to v2.

---

## 1. Goals

Add a **cost-per-lead (CPL) economic-feasibility layer** on top of the existing CR-significance Bayesian engine. The user (NGO admin) gets a TWO-LAYER verdict in the dashboard banner and summary email:

- **Layer 1 (already shipped):** "Which messaging/value-prop wins?" — Bayesian P(best) > 0.80 on conversion rate.
- **Layer 2 (NEW):** "Is the unit economics acceptable?" — leader's CPL vs project's `target_cpl`.

Three concrete behaviors:
1. **Project-level `target_cpl`** field with a smart hint anchored on average donation size.
2. **Per-variant manual spend entry** on the test analytics dashboard (inline pencil-edit) → computed CPL with green/amber/gray color tier.
3. **Summary email + dashboard banner** add an economic-verdict line below the existing winner verdict, using Agent B's Hebrew copy block.

## 2. Constraints (CLAUDE.md + base feature)

- **Vercel function ceiling:** 11/12 used. **0 new functions** — extend existing `api/test-monitor.js` and `api/send-email.js`.
- **Vanilla HTML + small Vercel functions.** No framework.
- **Public LP routes are sacred.** Don't touch `serve-lp.js` / `serve-test.js` / `vercel.json` rewrites.
- **NGO admin profile:** non-tech, Hebrew, "if it needs explaining it's broken."
- **Hebrew RTL** for all user-facing text.
- **Daily Vercel cron only** (Hobby tier).
- **Existing analytics already has `unique_visitors` / `lead_captured` events.** Use existing definitions for CPL = `spend / unique_leads`.
- **Engine stays untouched.** Bayesian decision engine receives no changes; CPL is a pure overlay computed at email-render time.

## 3. Non-goals (explicitly out of scope for v1)

- **Auto-pulling spend from Meta Marketing API.** Manual entry only (HANDOFF locked).
- **Per-test target_cpl.** Single value per project, applied to all its tests (HANDOFF locked).
- **Independent CPL kill-switch alert.** Agent A explicitly recommended deferring; instrument first, build v2 if real failure mode emerges.
- **Lead quality measurement** (downstream donation/volunteer rate). Tooltip notes CPL = "cost per form fill" only.
- **Retroactive verdict recomputation when target_cpl changes.** Future emails reflect new target; past `economic_verdict` rows are static.
- **CPL in milestone / kickoff / stall emails.** Lean — only summary email + dashboard show CPL (locked Q1).

## 4. Architecture

### 4.1 End-to-end flow

```
[per-project setup, one-time]
  Admin opens project settings → enters target_cpl → save

[per-test, while running]
  Admin opens test analytics → variant cards show 2 new rows:
    הוצאה (editable inline) + עלות לליד (computed, color-coded)
  Admin updates spend weekly-ish via pencil → PATCH test_variants

[create-test modal calculator]
  No new inputs. If project has target_cpl, append one read-only line:
  "בתקציב הזה תשיג ~21 לידים. בעלות יעד ₪40 × 21 = ₪840."

[daily Vercel cron — /api/test-monitor, EXISTING]
  for each running test:
    decideState → CR-only state (UNCHANGED)
    pickEmailAction → action (UNCHANGED)

    NEW: if action.name === 'test_summary':
      fetch test.project.target_cpl
      fetch each variant.spend, .spend_updated_at
      economicVerdict = computeEconomicVerdict({ cr_leader, variants, target_cpl })
      pass economicVerdict in send-email payload
      persist economic_verdict + cpl_leader_variant_id + oldest_spend_age_days
      to tests table (alongside existing summary_verdict)

[summary email rendering — api/send-email.js handleTestSummary]
  Reads tests row + project.target_cpl + variant spend
  Computes economicVerdict (or trusts what cron persisted)
  Renders renderSummaryEmail with both decision (CR) + economicVerdict (overlay)

[dashboard banner — _updateRecommendBanner, EXISTING + extended]
  Reads tests.summary_verdict + tests.economic_verdict
  Picks color + copy from a 5×3 matrix (CR verdict × economic verdict)
```

### 4.2 Component boundaries

| Unit | Responsibility | Owns | Reads |
|---|---|---|---|
| Project settings UI | Capture `target_cpl` per project | `projects.target_cpl` | — |
| Variant card spend cells (in `dashboard.html`) | Display + inline edit `spend` per variant | `test_variants.spend` + `spend_updated_at` | `projects.target_cpl` (for color tier) |
| Calculator soft-enrichment line (in `dashboard.html`) | Render `target_cpl × estimated_leads` reality check | DOM only | `projects.target_cpl` + planner inputs |
| `api/lib/economic-verdict.js` (NEW) | Pure: given CR leader + variant spend/leads + target_cpl → verdict | nothing — no I/O | nothing |
| `api/send-email.js handleTestSummary` (extended) | Compute verdict at render time + render Agent B's copy + send Brevo | side-effect Brevo POST | tests + projects + test_variants |
| `api/test-monitor.js markEmailSent` (extended) | Persist `economic_verdict`, `cpl_leader_variant_id`, `oldest_spend_age_days` columns alongside existing summary_sent_at | `tests.economic_verdict` etc. | — |
| `_updateRecommendBanner` in `dashboard.html` (extended) | Read both verdicts, pick from 5×3 matrix | DOM only | `tests.summary_verdict`, `tests.economic_verdict`, `tests.cpl_leader_variant_id` |

### 4.3 Two key design choices

**Engine stays pure (Agent A validation).** `decideState` and `pickEmailAction` get **zero changes**. CPL is computed at email-render time. Reasoning: every major A/B platform (GrowthBook, Eppo, Statsig, VWO) keeps statistical decisions and business decisions in separate layers. Coupling them inflates false-positive rate and is illegible to non-technical users.

**Spend-floor gate at email-render time.** Per Agent A: suppress the CPL verdict line until per-variant spend ≥ `3 × target_cpl`. Mirrors VWO's "threshold-of-caring" pattern. Below the floor, the email shows the CR winner alone + a "spend more / update spend" CTA.

---

## 5. Data model

### 5.1 Migration: `supabase/migrations/add_cpl_per_variant.sql`

```sql
-- Project-level target CPL
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS target_cpl NUMERIC(8,2);

-- Per-variant spend (admin enters manually)
ALTER TABLE public.test_variants ADD COLUMN IF NOT EXISTS spend NUMERIC(10,2);
ALTER TABLE public.test_variants ADD COLUMN IF NOT EXISTS spend_updated_at TIMESTAMPTZ;

-- Economic verdict persisted alongside the existing summary_verdict
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS economic_verdict TEXT
  CHECK (economic_verdict IS NULL OR economic_verdict IN
    ('VIABLE', 'NOT_VIABLE', 'WINNER_BUT_CHEAPER_ELSEWHERE',
     'INSUFFICIENT_SPEND', 'INSUFFICIENT_DATA'));
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS cpl_leader_variant_id UUID
  REFERENCES public.project_variants(id) ON DELETE SET NULL;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS oldest_spend_age_days INT;
```

No new tables. No new RLS policies (existing `projects` / `test_variants` / `tests` policies cover these columns).

### 5.2 Column rationale

- `projects.target_cpl` — single value per project. Optional. NULL means CPL feature is OFF for that project — dashboard hides the rows, calculator skips the enrichment line, summary email omits the economic verdict.
- `test_variants.spend` — cumulative manually-entered spend on this variant. NULL until admin enters spend the first time.
- `test_variants.spend_updated_at` — drives the freshness tier. NULL → treated as "infinitely old."
- `tests.economic_verdict` — persisted at email-send time. Lets dashboard banner show same color/copy as the email without recomputing.
- `tests.cpl_leader_variant_id` — set only when verdict is `WINNER_BUT_CHEAPER_ELSEWHERE`. NULL otherwise.
- `tests.oldest_spend_age_days` — snapshot at send time, so banner staleness label matches email's.

### 5.3 Decision constants (in `api/lib/economic-verdict.js`)

```js
const SPEND_FLOOR_MULTIPLIER = 3;     // require ≥ 3 × target_cpl per variant before showing verdict
const STALE_HARD_HIDE_DAYS   = 14;    // > 14d → hide verdict, prompt for spend update
const STALE_AMBER_DAYS       = 7;     // 7-14d → amber inline warning
```

---

## 6. Verdict computation (pure function)

### 6.1 `computeEconomicVerdict` in `api/lib/economic-verdict.js`

```js
export function computeEconomicVerdict({
  cr_leader_variant_id,        // from decideState's leader.variant_id
  variants,                     // [{variant_id, leads, spend, spend_updated_at}]
  target_cpl,                   // from projects.target_cpl
  now = Date.now(),
}) {
  if (!target_cpl || target_cpl <= 0) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'no_target_cpl' };
  }

  const enriched = variants.map(v => ({
    variant_id: v.variant_id,
    cpl: v.leads > 0 && v.spend != null ? v.spend / v.leads : null,
    spend: v.spend ?? 0,
    spend_age_days: v.spend_updated_at
      ? Math.floor((now - new Date(v.spend_updated_at).getTime()) / 86400e3)
      : Infinity,
  }));

  const oldest_spend_age_days = Math.max(...enriched.map(e => e.spend_age_days));

  if (oldest_spend_age_days > STALE_HARD_HIDE_DAYS) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'stale_spend',
             oldest_spend_age_days };
  }

  const spend_floor = SPEND_FLOOR_MULTIPLIER * target_cpl;
  if (enriched.some(e => e.spend < spend_floor)) {
    return { verdict: 'INSUFFICIENT_SPEND', reason: 'below_floor',
             spend_floor, oldest_spend_age_days };
  }

  const cr_leader = enriched.find(e => e.variant_id === cr_leader_variant_id);
  if (!cr_leader || cr_leader.cpl == null) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'no_leader_cpl' };
  }

  if (cr_leader.cpl <= target_cpl) {
    return { verdict: 'VIABLE', cr_leader_cpl: cr_leader.cpl, target_cpl,
             oldest_spend_age_days };
  }

  const cpl_sorted = [...enriched].sort((a, b) =>
    (a.cpl ?? Infinity) - (b.cpl ?? Infinity));
  const cpl_leader = cpl_sorted[0];
  if (cpl_leader && cpl_leader.variant_id !== cr_leader_variant_id
      && cpl_leader.cpl < cr_leader.cpl) {
    return { verdict: 'WINNER_BUT_CHEAPER_ELSEWHERE',
             cr_leader_cpl: cr_leader.cpl,
             cpl_leader_variant_id: cpl_leader.variant_id,
             cpl_leader_cpl: cpl_leader.cpl,
             target_cpl, gap: cr_leader.cpl - target_cpl,
             oldest_spend_age_days };
  }

  return { verdict: 'NOT_VIABLE',
           cr_leader_cpl: cr_leader.cpl, target_cpl,
           gap: cr_leader.cpl - target_cpl,
           oldest_spend_age_days };
}
```

### 6.2 5 verdict states

| State | Trigger | Email behavior | Banner color |
|---|---|---|---|
| `VIABLE` | CR winner's CPL ≤ target_cpl | Green band, "scale up" CTA | 🟢 green |
| `NOT_VIABLE` | CR winner's CPL > target, also CPL leader (or no other variant cheaper) | Amber band, "how to reduce CPL" CTA, two-truths copy | 🟡 amber |
| `WINNER_BUT_CHEAPER_ELSEWHERE` | CR winner's CPL > target AND another variant has lower CPL | Amber, three-line output (CR winner / CPL winner / recommend) | 🟡 amber |
| `INSUFFICIENT_SPEND` | Any variant's spend < 3 × target_cpl | Show CR verdict only + "spend more / update" CTA | (existing CR color) |
| `INSUFFICIENT_DATA` | Spend > 14d stale OR no target_cpl set OR no leader CPL | Show CR verdict only + "update spend" CTA | (existing CR color) |

### 6.3 CR-loser-is-CPL-winner case (Agent A's pattern)

Per Adalysis & Eppo, **never shift the displayed winner**. The `WINNER_BUT_CHEAPER_ELSEWHERE` state explicitly preserves the CR winner as the recommended ship, but surfaces the CPL leader's existence so the admin can borrow its audience/creative for ad-side optimization.

---

## 7. UI surfaces

### 7.1 Project settings — `target_cpl` field

Single number input, optional, with smart hint:

```
עלות מקסימלית לליד (₪)
[   40   ] ₪
↑ מעל זה, ליד עולה יותר ממה שהוא שווה.
   כלל אצבע: 1/3 עד 1/2 מהתרומה הממוצעת.
   למשל: תרומה ממוצעת ₪120 → CPL ₪40-60.
```

Stored on `projects.target_cpl`. NULL by default.

### 7.2 Create-test modal calculator — soft enrichment line

Existing planner block stays untouched. If `project.target_cpl` exists, append one read-only line below the existing budget output:

```
↪ בתקציב הזה תשיג ~21 לידים. בעלות יעד ₪{target_cpl} × 21 = ₪{X}.
   {if budget < target × leads: "בגדר היעד"} else "מעל יעד CPL"}
```

Where `leads_estimate = target_sample_size × num_variants × baseline_cvr`.

### 7.3 Test analytics dashboard — variant cards get 2 new rows

When `project.target_cpl` is set, every variant card gets two rows beneath the existing metrics:

```
הוצאה             ₪380 ✏️
                   עודכן לפני 3 ימים    ← gray (0-7d) / amber (7-14d) / amber+icon (14d+)
עלות לליד         ₪16.5  🟢
                   מתחת ליעד ₪40        ← color-tiered vs target_cpl
```

**Spend cell**:
- `₪{spend} ✏️` (pencil = inline edit)
- Click pencil → input becomes editable → Enter saves → PATCH `test_variants` (sets `spend` + `spend_updated_at = now()`)
- First-use tooltip on pencil: `עדכן פעם בשבוע — זה מספיק` (dismissible, stored in `localStorage`)

**CPL cell**:
- Display `₪{cpl}` with color tier:
  - 🟢 Green if `cpl <= target_cpl`
  - 🟡 Amber if `cpl > target_cpl`
  - ⚪ Gray "אין מספיק נתונים" if `spend < 3 × target_cpl`
- Sub-line: `מתחת ליעד ₪{target}` / `₪{gap} מעל היעד` / nothing if gray
- Tooltip on row label: `עלות לליד = הוצאה ÷ לידים שמילאו טופס. לא מודד איכות לידים — רק כמות.`

If `project.target_cpl` is NULL, both rows are hidden entirely. CPL is purely additive — base feature still works without it.

### 7.4 Recommend-stop banner — extended for new verdicts

Existing banner reads `summary_sent_at` + `summary_verdict`. Now also reads `economic_verdict` + `cpl_leader_variant_id` + `oldest_spend_age_days`. Banner copy/color picked from this matrix:

| `summary_verdict` | `economic_verdict` | Color | Copy (trim) | CTA |
|---|---|---|---|---|
| `WINNER_FOUND` | `VIABLE` | 🟢 green | "מצאנו מנצח — והעלות לליד מתאימה. אפשר להגדיל תקציב." | "הכרז מנצח ועצור" |
| `WINNER_FOUND` | `NOT_VIABLE` | 🟡 amber | "מצאנו מנצח, אבל העלות לליד מעל היעד. תובנת המסר שווה — ההצעה צריכה לעבוד שונה." | "איך להוזיל את הליד" |
| `WINNER_FOUND` | `WINNER_BUT_CHEAPER_ELSEWHERE` | 🟡 amber | "מצאנו מנצח (וריאציה X), אבל וריאציה Y עולה פחות לליד. שקול לשלב — הצעת X, אאודיינס של Y." | "פתח לוח בקרה" |
| `WINNER_FOUND` | `INSUFFICIENT_SPEND` / `INSUFFICIENT_DATA` | 🟢 green | "מצאנו מנצח. עדכן את ההוצאות לקבל מסקנה כלכלית." | "עדכן הוצאות" |
| `PRACTICAL_TIE` / `TRENDING_UNDERPOWERED` | (any) | (existing) | (existing copy) | (existing CTA) |

---

## 8. Email content (Agent B's copy)

Stored as JS constants in `api/lib/email-templates.js`. The summary renderer's WINNER_FOUND branch becomes a 4-way switch on `economicVerdict`.

### 8.1 Subject lines

- `VIABLE`: `יש זוכה ✓ והעלות לליד עומדת ביעד שלך`
- `NOT_VIABLE`: `מצאנו ניסוח מנצח — צריך לדבר על העלות`
- `WINNER_BUT_CHEAPER_ELSEWHERE`: `מצאנו זוכה — אבל וריאציה אחרת זולה יותר לליד`
- `INSUFFICIENT_SPEND` / `INSUFFICIENT_DATA`: subject stays as today (`יש מנצח: {name} (+{lift}%)`)

### 8.2 Body verdict lines

- `VIABLE` (green band):
  > הווריאנט המנצח עולה לך ₪{cpl} לליד — מתחת ליעד של ₪{target}. אפשר להעלות תקציב בביטחון.
- `NOT_VIABLE` (amber band, two-truths):
  > הניסוח של {variant_name} ממיר טוב יותר ב-{lift}%, אבל בעלות של ₪{cpl} לליד — ₪{gap} מעל היעד שלך. תובנת המסר שווה זהב; השאלה היא איך להוזיל את הליד עצמו.
- `WINNER_BUT_CHEAPER_ELSEWHERE` (amber, three lines):
  > 🏆 ניסוח מנצח: {cr_winner_name}
  > 💰 עלות נמוכה יותר: {cpl_winner_name} (₪{cpl_winner_cpl} מול ₪{cr_leader_cpl})
  > המלצה: השק את {cr_winner_name}, אבל קח את הקריאייטיב/אאודיינס של {cpl_winner_name} ב-Meta כדי להוזיל גם את ה-CPC.
- `INSUFFICIENT_SPEND` / `INSUFFICIENT_DATA` — bottom card:
  > כדי לראות מסקנה כלכלית — צריך מספרי הוצאה עדכניים. נתוני ההוצאה האחרונים שלך מ-{date}. ברגע שתעדכני, נחשב מחדש את העלות לליד ונציג את המסקנה המלאה.

### 8.3 CTAs

- `VIABLE`: `הגדל תקציב לקמפיין הזוכה ←` → links to dashboard
- `NOT_VIABLE`: `איך להוזיל את הליד הזה — 4 רעיונות ←` → v1 links to dashboard; v2 may link to a help page
- `WINNER_BUT_CHEAPER_ELSEWHERE`: `פתח לוח בקרה לפרטים מלאים ←` → dashboard
- `INSUFFICIENT_*`: `עדכן הוצאות עכשיו ←` → dashboard

### 8.4 Footnote (only on NOT_VIABLE)

Below CTA:
> המסר עצמו עובד — שמור עליו לטסט הבא עם הצעה אחרת.

### 8.5 Standings table extended

Existing 4 columns (וריאציה / מבקרים / לידים / המרה) → add 5th `עלות לליד` column when verdict is `VIABLE` / `NOT_VIABLE` / `WINNER_BUT_CHEAPER_ELSEWHERE`. Hide column when `INSUFFICIENT_*`.

### 8.6 Stale spend inline warnings

Per Agent B (in the standings table CPL column):
- 0–3 days: nothing
- 3–7 days (gray): `מבוסס על נתוני הוצאה שעודכנו לפני {N} ימים`
- 7–14 days (amber): `נתוני ההוצאה לא עודכנו כבר {N} ימים — ייתכן שהמסקנה הכלכלית כבר לא מדויקת. שווה לרענן ולוודא.`
- 14+ days: hide CPL column entirely; replace with "update spend" card above standings

### 8.7 Color tokens

```
color_winner_viable_band:    #059669  (solid green)
color_winner_not_viable_band: #F59E0B  (amber, NOT red)
color_no_winner_band:        #6B7280  (neutral gray, existing)
color_stale_7_to_14:         #F59E0B  (amber)
color_stale_14plus_card_bg:  #F3F4F6  (neutral light gray, not amber)
```

PRACTICAL_TIE / TRENDING_UNDERPOWERED branches stay UNCHANGED — economic verdict only attaches to WINNER_FOUND.

---

## 9. Multi-agent dispatch (5 agents, 3 stages)

### 9.1 Stage 1 (serial): `migration-architect`
- Writes `supabase/migrations/add_cpl_per_variant.sql` per §5.1.
- Updates `docs/test-planner-contract.md` with the 6 new columns + new send-email payload field shape.
- **Gate**: parent applies the migration via `mcp__claude_ai_Supabase__apply_migration` to project `uaspcafukqvgiztzdnfu`.

### 9.2 Stage 2 (parallel)
- **2a `verdict-engine-coder`** — owns `api/lib/economic-verdict.js` (NEW) + `api/lib/economic-verdict.test.js` (NEW, ~6 TDD tests). Pure function, no I/O.
- **2b `dashboard-cpl-ui-coder`** — owns `dashboard.html` (only the regions: variant card metrics rendering, planner block enrichment line, banner switch). Other regions forbidden.
- **2c `project-settings-coder`** — owns the project settings/edit form (verify file in `new.html` / `admin.html`). Adds `target_cpl` field with hint copy.
- **2d `email-templates-extender`** — owns `api/lib/email-templates.js` (extend `renderSummaryEmail` with 4 new sub-branches per §8) + `api/lib/email-templates.test.js` (~5 new tests).

### 9.3 Stage 3 (serial): `integrator-qa`
- Wires `api/test-monitor.js markEmailSent` to write `economic_verdict`, `cpl_leader_variant_id`, `oldest_spend_age_days`.
- Wires `api/send-email.js handleTestSummary` to fetch `projects.target_cpl` + `test_variants.spend/updated_at`, call `computeEconomicVerdict`, pass result to `renderSummaryEmail`.
- Adds the spend PATCH endpoint logic (probably extends `api/admin.js` or `api/save-content.js` if applicable — verify which existing endpoint owns `test_variants` writes).
- Smoke test on Vercel preview per §12.

### 9.4 File ownership matrix (collision-proof)

| File | Stage 1 | 2a | 2b | 2c | 2d | Stage 3 |
|---|---|---|---|---|---|---|
| `supabase/migrations/add_cpl_per_variant.sql` | **W** | r | r | r | r | r |
| `docs/test-planner-contract.md` | **W** | r | r | r | r | r |
| `api/lib/economic-verdict.js` (NEW) | — | **W** | — | — | r | r |
| `api/lib/economic-verdict.test.js` (NEW) | — | **W** | — | — | — | r |
| `dashboard.html` (variant cards + planner enrichment + banner) | r | — | **W** | — | — | r |
| `new.html` (project create form) + `dashboard.html` (project edit, lines 3316/3867 area) | r | — | — | **W** | — | r |
| `api/lib/email-templates.js` | r | — | — | — | **W** | r |
| `api/lib/email-templates.test.js` | r | — | — | — | **W** | r |
| `api/test-monitor.js` (markEmailSent extension) | r | r | — | — | r | **W** |
| `api/send-email.js` (handleTestSummary extension + spend PATCH) | r | r | — | — | r | **W** |

### 9.5 Tooling

Plain `Task` subagents (`subagent_type: "general-purpose"`). No claude-flow MCP needed.

### 9.6 Function-count budget

**0 new functions**. Stays at 11/12 under Vercel Hobby ceiling.

---

## 10. Error handling

Per CLAUDE.md "fail loud":

- **`computeEconomicVerdict`** is pure — never throws. Returns `INSUFFICIENT_DATA` on any unexpected input shape.
- **Cron worker**: economic-verdict computation wrapped in try/catch — if it throws, log + send the existing CR-only summary (the email still goes out, the verdict layer just degrades silently). User experience: same as today, no regression.
- **Spend PATCH endpoint**: validates `spend >= 0` and `spend < 1_000_000` and `typeof spend === 'number'`. Bad input = 400 with Hebrew alert.
- **Frontend**: if PATCH fails, alert in Hebrew + log to console. Do not silently lose user input.

---

## 11. Testing

Per CLAUDE.md "tests for your own changes only — co-locate":

- `api/lib/economic-verdict.test.js` — table-driven tests for each verdict path:
  1. VIABLE (CR winner CPL ≤ target)
  2. NOT_VIABLE (CR winner CPL > target, also CPL leader)
  3. WINNER_BUT_CHEAPER_ELSEWHERE (CR winner ≠ CPL winner)
  4. INSUFFICIENT_SPEND (any variant below 3× target)
  5. INSUFFICIENT_DATA (stale 14d+)
  6. INSUFFICIENT_DATA (no target_cpl set)
- `api/lib/email-templates.test.js` — 5 new tests for the 5 verdict branches in `renderSummaryEmail`.
- No automated UI test — visual diff isn't worth automating; smoke-test on Vercel preview verifies.

---

## 12. Verification before declaring v1 done

1. Migration applied to Supabase → 6 new columns visible.
2. Set `target_cpl = 40` on the live customer's project via SQL or settings UI.
3. Test analytics page → spend rows visible on each variant card; pencil edit works; PATCH lands; spend_updated_at populated.
4. Backfill the live customer test's spend (e.g., A=₪380, B=₪200, C=₪320 → CPL ≈ ₪16/₪25/₪19).
5. Manually invoke `/api/test-monitor` (with CRON_SECRET) → verify `economic_verdict='VIABLE'` persists; summary email arrives with green band + viable copy.
6. Bump `target_cpl` down to ₪10 → re-invoke cron → verify `NOT_VIABLE` (or `WINNER_BUT_CHEAPER_ELSEWHERE`) → amber email arrives.
7. Set one variant's spend to ₪5 (below 3× target floor) → verify `INSUFFICIENT_SPEND` → email shows winner only + spend prompt.
8. Visit `/lp/lipaz-ela-1` → confirms public LP routes still work (CLAUDE.md sacred check).
9. Confirm Vercel function count is still 11/12.
10. Confirm at least one 3-variant scenario covered (existing live test fits).

---

## 13. Open risks and notes

- **Project settings form** lives in two places: `new.html` (project creation form, line ~2100) and `dashboard.html` (project edit, lines 3316 + 3867 area). Stage 2c adds the `target_cpl` input + hint to BOTH; reuses the same Hebrew copy in each.
- **Spend PATCH endpoint**: simplest path is for `dashboard.html` to call `sb.from('test_variants').update({ spend, spend_updated_at }).eq('id', tv.id)` directly via the existing Supabase client. RLS already covers this (existing `test_variants_via_test` policy lets anyone with test access write). No new function endpoint needed; saves the function-count budget.
- **`leads` field in `computeEconomicVerdict` input** — depends on the same `unique_leads` definition the dashboard uses. Reuse the existing aggregation, don't reinvent.
- **CPL leader = CR leader (tied)**. The verdict logic correctly falls through to `NOT_VIABLE`; tested in path #2.
- **Race condition: admin updates spend WHILE cron is running.** Cron uses a snapshot at fetch time; if admin updates spend mid-run, next cron tick picks it up. Acceptable.
- **Two implementations of `target_cpl × leads_estimate`** (calculator JS in dashboard + verdict engine in api/lib). Acceptable code duplication for v1 — same precision, different contexts.
- **Kill-switch deferred.** Per Agent A: instrument first (count tests where CR is "no winner" but CPL > 2× target), build v2 only if real failure mode emerges.
- **No UI for setting `target_cpl` on existing projects** in v1 — admin uses SQL or whatever existing edit-project UI supports it. Verify Stage 2c; if no UI exists, add a minimal field.

---

## 14. References

- Agent A — A/B test economics + CPL methodology research (2026-05-05). Sources: GrowthBook docs, Eppo Protocols, Statsig Ship Decision Framework, VWO winner logic, Adalysis CPA filter pattern, Stucchio threshold-of-caring, Variance Explained on Bayesian peeking.
- Agent B — Lifecycle email UX research (2026-05-05). Sources: Optimizely / VWO / GrowthBook / Statsig email patterns, Princeton "Bad News Sandwich," Bri Williams on bad news, Prosemedia empathetic microcopy, Kinneret Yifrah (Nemala) microcopy book, Meta Learning Limited explainer.
- Agent C — Multi-agent orchestration patterns (2026-05-05). Sources: Anthropic multi-agent research, Simon Willison parallel coding lifestyle, Cognition/LangChain on read-vs-write tasks, Augment on multi-agent failure rates, Multi-Agent Debate for LLM Judges.
- Internal: `docs/feature-summary-test-planner-emails.md`, `docs/superpowers/specs/2026-05-03-test-planner-emails-design.md`, `CLAUDE.md`, `.claude/rules/admin-ux.md`, `.claude/HANDOFF.md`.
