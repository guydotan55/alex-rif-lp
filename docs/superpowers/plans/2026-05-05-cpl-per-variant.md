# CPL Per-Variant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cost-per-lead (CPL) economic-feasibility overlay on top of the existing CR-significance Bayesian engine — project-level `target_cpl`, per-variant spend entry on the dashboard, two-layer verdict in the summary email + dashboard banner.

**Architecture:** Engine stays untouched. CPL is computed at email-render time as a pure overlay. 6 new DB columns (3 tables). 0 new Vercel functions. Project settings field, calculator soft-enrichment line, dashboard 2 new rows per variant card, summary-email 4-way verdict switch using Agent B's exact Hebrew copy.

**Tech Stack:** Vanilla HTML+JS frontend (no framework), Vercel serverless Node functions, Supabase Postgres + RLS, Brevo for transactional email, `node --test` (built-in) for unit tests, Hebrew RTL throughout.

**Source spec:** [`docs/superpowers/specs/2026-05-05-cpl-per-variant-design.md`](../specs/2026-05-05-cpl-per-variant-design.md)

**Out of scope (per spec §3):** Meta Marketing API integration, per-test target_cpl, kill-switch alert, lead quality measurement, retroactive verdict recomputation when target changes, CPL in milestone/kickoff/stall emails.

---

## Stage 1: Schema + Contract

### Task 1: Migration — add CPL columns to 3 tables

**Files:**
- Create: `supabase/migrations/add_cpl_per_variant.sql`

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS target_cpl NUMERIC(8,2);

ALTER TABLE public.test_variants ADD COLUMN IF NOT EXISTS spend NUMERIC(10,2);
ALTER TABLE public.test_variants ADD COLUMN IF NOT EXISTS spend_updated_at TIMESTAMPTZ;

ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS economic_verdict TEXT
  CHECK (economic_verdict IS NULL OR economic_verdict IN
    ('VIABLE', 'NOT_VIABLE', 'WINNER_BUT_CHEAPER_ELSEWHERE',
     'INSUFFICIENT_SPEND', 'INSUFFICIENT_DATA'));
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS cpl_leader_variant_id UUID
  REFERENCES public.project_variants(id) ON DELETE SET NULL;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS oldest_spend_age_days INT;
```

- [ ] **Step 2: Apply via Supabase MCP**

Use `mcp__claude_ai_Supabase__apply_migration` with project_id `uaspcafukqvgiztzdnfu`, name `add_cpl_per_variant`, query = the SQL from Step 1.

- [ ] **Step 3: Verify columns exist**

Run via `mcp__claude_ai_Supabase__execute_sql`:
```sql
SELECT table_name, column_name, data_type FROM information_schema.columns
WHERE (table_name='projects' AND column_name='target_cpl')
   OR (table_name='test_variants' AND column_name IN ('spend','spend_updated_at'))
   OR (table_name='tests' AND column_name IN ('economic_verdict','cpl_leader_variant_id','oldest_spend_age_days'))
ORDER BY table_name, column_name;
```
Expected: 6 rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/add_cpl_per_variant.sql
git commit -m "feat(db): add CPL columns — projects.target_cpl, test_variants.spend/spend_updated_at, tests.economic_verdict trio"
```

### Task 2: Update cross-file contract doc

**Files:**
- Modify: `docs/test-planner-contract.md`

- [ ] **Step 1: Append CPL columns to the existing tests section**

Find the table heading `## Database — \`tests\` table additions` in `docs/test-planner-contract.md`. Add 3 new rows AFTER the existing `summary_lift_pct` row:

```markdown
| `economic_verdict` | TEXT (CHECK) | cron worker (markEmailSent) | one of `VIABLE` / `NOT_VIABLE` / `WINNER_BUT_CHEAPER_ELSEWHERE` / `INSUFFICIENT_SPEND` / `INSUFFICIENT_DATA` |
| `cpl_leader_variant_id` | UUID FK→project_variants | cron worker | NULL except for `WINNER_BUT_CHEAPER_ELSEWHERE` |
| `oldest_spend_age_days` | INT | cron worker | snapshot of staleness at email-send time |
```

- [ ] **Step 2: Add NEW sections for projects + test_variants additions**

Append AFTER the `tests` section, BEFORE the `## /api/send-email` section:

```markdown
## Database — `projects` table additions (CPL feature)

| Column | Type | Filled by | Notes |
|---|---|---|---|
| `target_cpl` | NUMERIC(8,2) | project create/edit form | Optional. NULL means CPL feature OFF for that project |

## Database — `test_variants` table additions (CPL feature)

| Column | Type | Filled by | Notes |
|---|---|---|---|
| `spend` | NUMERIC(10,2) | dashboard inline edit | Cumulative manually-entered spend |
| `spend_updated_at` | TIMESTAMPTZ | dashboard inline edit | NULL until first entry |
```

- [ ] **Step 3: Commit**

```bash
git add docs/test-planner-contract.md
git commit -m "docs: contract additions for CPL columns (projects + test_variants + tests)"
```

---

## Stage 2: Pure verdict engine (`api/lib/economic-verdict.js`)

### Task 3: TDD `computeEconomicVerdict` — all 6 paths

**Files:**
- Create: `api/lib/economic-verdict.js`
- Create: `api/lib/economic-verdict.test.js`

- [ ] **Step 1: Write the failing tests**

Create `api/lib/economic-verdict.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEconomicVerdict } from './economic-verdict.js';

const NOW = Date.UTC(2026, 4, 5, 12, 0, 0);
const fresh = (daysAgo = 1) => new Date(NOW - daysAgo * 86400e3).toISOString();

const baseVariants = [
  { variant_id: 'a', leads: 23, spend: 380, spend_updated_at: fresh(2) },
  { variant_id: 'b', leads: 8,  spend: 200, spend_updated_at: fresh(2) },
  { variant_id: 'c', leads: 17, spend: 320, spend_updated_at: fresh(2) },
];

test('VIABLE: CR winner CPL ≤ target_cpl', () => {
  const out = computeEconomicVerdict({
    cr_leader_variant_id: 'a', variants: baseVariants, target_cpl: 40, now: NOW,
  });
  assert.equal(out.verdict, 'VIABLE');
  assert.ok(Math.abs(out.cr_leader_cpl - 380/23) < 0.01);
  assert.equal(out.target_cpl, 40);
});

test('NOT_VIABLE: CR winner CPL > target AND is also CPL leader', () => {
  const out = computeEconomicVerdict({
    cr_leader_variant_id: 'a', variants: baseVariants, target_cpl: 10, now: NOW,
  });
  assert.equal(out.verdict, 'NOT_VIABLE');
  assert.ok(out.gap > 0);
});

test('WINNER_BUT_CHEAPER_ELSEWHERE: CR winner is c, but a is cheaper', () => {
  const out = computeEconomicVerdict({
    cr_leader_variant_id: 'c', variants: baseVariants, target_cpl: 10, now: NOW,
  });
  assert.equal(out.verdict, 'WINNER_BUT_CHEAPER_ELSEWHERE');
  assert.equal(out.cpl_leader_variant_id, 'a');
  assert.ok(out.cpl_leader_cpl < out.cr_leader_cpl);
});

test('INSUFFICIENT_SPEND: at least one variant below 3× target_cpl floor', () => {
  const out = computeEconomicVerdict({
    cr_leader_variant_id: 'a', variants: baseVariants, target_cpl: 200, now: NOW,
  });
  assert.equal(out.verdict, 'INSUFFICIENT_SPEND');
  assert.equal(out.spend_floor, 600);
});

test('INSUFFICIENT_DATA: stale spend > 14 days', () => {
  const stale = baseVariants.map(v => ({ ...v, spend_updated_at: fresh(15) }));
  const out = computeEconomicVerdict({
    cr_leader_variant_id: 'a', variants: stale, target_cpl: 40, now: NOW,
  });
  assert.equal(out.verdict, 'INSUFFICIENT_DATA');
  assert.equal(out.reason, 'stale_spend');
  assert.ok(out.oldest_spend_age_days >= 15);
});

test('INSUFFICIENT_DATA: no target_cpl set', () => {
  const out = computeEconomicVerdict({
    cr_leader_variant_id: 'a', variants: baseVariants, target_cpl: null, now: NOW,
  });
  assert.equal(out.verdict, 'INSUFFICIENT_DATA');
  assert.equal(out.reason, 'no_target_cpl');
});
```

- [ ] **Step 2: Run to verify all 6 fail**

Run: `npm test`
Expected: 6 new failures (`Cannot find module './economic-verdict.js'`).

- [ ] **Step 3: Implement `computeEconomicVerdict`**

Create `api/lib/economic-verdict.js`:

```js
// api/lib/economic-verdict.js
// Pure verdict engine: given CR leader + variant spend/leads + target_cpl → economic verdict.
// No I/O. Designed to run from cron worker AND email handler.

const SPEND_FLOOR_MULTIPLIER = 3;
const STALE_HARD_HIDE_DAYS   = 14;
const STALE_AMBER_DAYS       = 7;

export const ECONOMIC_VERDICT_CONSTANTS = {
  SPEND_FLOOR_MULTIPLIER, STALE_HARD_HIDE_DAYS, STALE_AMBER_DAYS,
};

export function computeEconomicVerdict({
  cr_leader_variant_id, variants, target_cpl, now = Date.now(),
}) {
  if (!target_cpl || target_cpl <= 0) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'no_target_cpl' };
  }

  const enriched = variants.map(v => ({
    variant_id: v.variant_id,
    cpl: (v.leads > 0 && v.spend != null) ? v.spend / v.leads : null,
    spend: v.spend ?? 0,
    spend_age_days: v.spend_updated_at
      ? Math.floor((now - new Date(v.spend_updated_at).getTime()) / 86400e3)
      : Infinity,
  }));

  const oldest_spend_age_days = Math.max(...enriched.map(e => e.spend_age_days));

  if (oldest_spend_age_days > STALE_HARD_HIDE_DAYS) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'stale_spend', oldest_spend_age_days };
  }

  const spend_floor = SPEND_FLOOR_MULTIPLIER * target_cpl;
  if (enriched.some(e => e.spend < spend_floor)) {
    return { verdict: 'INSUFFICIENT_SPEND', reason: 'below_floor', spend_floor, oldest_spend_age_days };
  }

  const cr_leader = enriched.find(e => e.variant_id === cr_leader_variant_id);
  if (!cr_leader || cr_leader.cpl == null) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'no_leader_cpl' };
  }

  if (cr_leader.cpl <= target_cpl) {
    return { verdict: 'VIABLE', cr_leader_cpl: cr_leader.cpl, target_cpl, oldest_spend_age_days };
  }

  const cpl_sorted = [...enriched].sort((a, b) => (a.cpl ?? Infinity) - (b.cpl ?? Infinity));
  const cpl_leader = cpl_sorted[0];
  if (cpl_leader && cpl_leader.variant_id !== cr_leader_variant_id && cpl_leader.cpl < cr_leader.cpl) {
    return {
      verdict: 'WINNER_BUT_CHEAPER_ELSEWHERE',
      cr_leader_cpl: cr_leader.cpl,
      cpl_leader_variant_id: cpl_leader.variant_id,
      cpl_leader_cpl: cpl_leader.cpl,
      target_cpl, gap: cr_leader.cpl - target_cpl, oldest_spend_age_days,
    };
  }

  return {
    verdict: 'NOT_VIABLE',
    cr_leader_cpl: cr_leader.cpl, target_cpl,
    gap: cr_leader.cpl - target_cpl, oldest_spend_age_days,
  };
}
```

- [ ] **Step 4: Run to verify all 6 pass**

Run: `npm test`
Expected: all tests pass (existing 33 + 6 new = 39).

- [ ] **Step 5: Commit**

```bash
git add api/lib/economic-verdict.js api/lib/economic-verdict.test.js
git commit -m "feat(stats): pure economic-verdict engine (5 verdict states + spend-floor + staleness)"
```

---

## Stage 3: Email-template extension (`api/lib/email-templates.js`)

### Task 4: TDD summary-email economic-verdict overlay

**Files:**
- Modify: `api/lib/email-templates.js`
- Modify: `api/lib/email-templates.test.js`

- [ ] **Step 1: Append failing tests**

Append to `api/lib/email-templates.test.js`:

```js
const baseSummaryVariants = [
  { label: 'A', name: 'התפתחות אישית',     visitors: 283, conversions: 23, lpUrl: 'https://example.com/lp/a', spend: 380 },
  { label: 'B', name: 'מסע אישי',          visitors: 234, conversions: 8,  lpUrl: 'https://example.com/lp/b', spend: 200 },
  { label: 'C', name: 'התפתחות נוסחה ב',   visitors: 274, conversions: 17, lpUrl: 'https://example.com/lp/c', spend: 320 },
];

test('renderSummaryEmail VIABLE — green band, scale-up CTA', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    {
      verdict: 'WINNER_FOUND', winnerLabel: 'A', winnerName: 'התפתחות אישית', liftPct: 31,
      economic: { verdict: 'VIABLE', cr_leader_cpl: 16.5, target_cpl: 40, oldest_spend_age_days: 2 },
    },
    baseSummaryVariants,
  );
  assert.match(out.subject, /יש זוכה ✓/);
  assert.match(out.html, /הגדל תקציב/);
  assert.match(out.html, /16/);
  assert.match(out.html, /עלות לליד/);
});

test('renderSummaryEmail NOT_VIABLE — amber band, two-truths copy', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    {
      verdict: 'WINNER_FOUND', winnerLabel: 'A', winnerName: 'התפתחות אישית', liftPct: 31,
      economic: { verdict: 'NOT_VIABLE', cr_leader_cpl: 28, target_cpl: 10, gap: 18, oldest_spend_age_days: 2 },
    },
    baseSummaryVariants,
  );
  assert.match(out.subject, /צריך לדבר על העלות/);
  assert.match(out.html, /איך להוזיל את הליד/);
  assert.match(out.html, /תובנת המסר שווה זהב/);
  assert.match(out.html, /המסר עצמו עובד/);
});

test('renderSummaryEmail WINNER_BUT_CHEAPER_ELSEWHERE — three-line output', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    {
      verdict: 'WINNER_FOUND', winnerLabel: 'C', winnerName: 'התפתחות נוסחה ב', liftPct: 22,
      economic: {
        verdict: 'WINNER_BUT_CHEAPER_ELSEWHERE',
        cr_leader_cpl: 18.8, cpl_leader_variant_id: 'A',
        cpl_leader_cpl: 16.5, target_cpl: 10, gap: 8.8, oldest_spend_age_days: 2,
      },
    },
    baseSummaryVariants,
  );
  assert.match(out.subject, /אבל וריאציה אחרת זולה יותר/);
  assert.match(out.html, /ניסוח מנצח/);
  assert.match(out.html, /עלות נמוכה יותר/);
});

test('renderSummaryEmail INSUFFICIENT_SPEND — show winner only + spend prompt', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    {
      verdict: 'WINNER_FOUND', winnerLabel: 'A', winnerName: 'התפתחות אישית', liftPct: 31,
      economic: { verdict: 'INSUFFICIENT_SPEND', spend_floor: 600, oldest_spend_age_days: 2 },
    },
    baseSummaryVariants,
  );
  assert.match(out.subject, /יש מנצח/);
  assert.match(out.html, /עדכן הוצאות/);
  assert.doesNotMatch(out.html, /הגדל תקציב/);
});

test('renderSummaryEmail INSUFFICIENT_DATA — same prompt-for-spend treatment', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    {
      verdict: 'WINNER_FOUND', winnerLabel: 'A', winnerName: 'התפתחות אישית', liftPct: 31,
      economic: { verdict: 'INSUFFICIENT_DATA', reason: 'stale_spend', oldest_spend_age_days: 17 },
    },
    baseSummaryVariants,
  );
  assert.match(out.subject, /יש מנצח/);
  assert.match(out.html, /עדכן הוצאות/);
});
```

- [ ] **Step 2: Run to verify 5 fail**

Run: `npm test`
Expected: 5 new failures.

- [ ] **Step 3: Replace `renderSummaryEmail` body**

In `api/lib/email-templates.js`, find `export function renderSummaryEmail(test, decision, variantCounts)`. Replace its body with:

```js
export function renderSummaryEmail(test, decision, variantCounts) {
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard`;
  const newTestUrl   = `${process.env.APP_URL || ''}/dashboard`;

  const economic = decision.economic;
  const showCplColumn = economic && ['VIABLE', 'NOT_VIABLE', 'WINNER_BUT_CHEAPER_ELSEWHERE'].includes(economic.verdict);
  const target_cpl = economic?.target_cpl;

  const sorted = [...variantCounts].sort((a, b) => (b.conversions / Math.max(1, b.visitors)) - (a.conversions / Math.max(1, a.visitors)));
  const standingsRows = sorted.map(v => {
    const cvr = v.visitors ? (v.conversions / v.visitors * 100).toFixed(1) : '0.0';
    const safeName = escapeHtml(v.name || v.label);
    const nameCell = v.lpUrl
      ? `<a href="${escapeAttr(v.lpUrl)}" style="color:#0d2240;text-decoration:underline;">${safeName}</a> <a href="${escapeAttr(v.lpUrl)}" style="color:#999;text-decoration:none;font-size:11px;">↗</a>`
      : safeName;
    let cplCell = '';
    if (showCplColumn) {
      const cpl = (v.spend != null && v.conversions > 0) ? v.spend / v.conversions : null;
      const cplColor = cpl == null ? '#999' : (cpl <= target_cpl ? '#059669' : '#F59E0B');
      const cplText = cpl == null ? '—' : `₪${cpl.toFixed(1)}`;
      cplCell = `<td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:${cplColor};font-size:13px;font-weight:600;text-align:left;"><span dir="ltr">${cplText}</span></td>`;
    }
    return `<tr>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#1a1a1a;font-size:13px;">${nameCell}</td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#666;font-size:13px;text-align:left;"><span dir="ltr">${fmtN(v.visitors)}</span></td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#666;font-size:13px;text-align:left;"><span dir="ltr">${v.conversions}</span></td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#0d2240;font-size:13px;font-weight:600;text-align:left;"><span dir="ltr">${cvr}%</span></td>
      ${cplCell}
    </tr>`;
  }).join('');

  const standingsTable = `<table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;">
    <thead><tr>
      <th dir="rtl" style="padding:8px;text-align:right;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">וריאציה</th>
      <th dir="rtl" style="padding:8px;text-align:left;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">מבקרים</th>
      <th dir="rtl" style="padding:8px;text-align:left;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">לידים</th>
      <th dir="rtl" style="padding:8px;text-align:left;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">המרה</th>
      ${showCplColumn ? `<th dir="rtl" style="padding:8px;text-align:left;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">עלות לליד</th>` : ''}
    </tr></thead>
    <tbody>${standingsRows}</tbody>
  </table>`;

  let subject, headline, body, cta;
  const isInsufficient = economic && ['INSUFFICIENT_SPEND', 'INSUFFICIENT_DATA'].includes(economic.verdict);

  if (decision.verdict === 'WINNER_FOUND' && economic?.verdict === 'VIABLE') {
    const winnerNameRaw = decision.winnerName || decision.winnerLabel || '';
    const winnerNameHtml = escapeHtml(winnerNameRaw);
    subject = `יש זוכה ✓ והעלות לליד עומדת ביעד שלך | ${test.name}`;
    headline = `<div style="background:#e8f5e9;border-right:4px solid #059669;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#2e7d32;font-size:18px;font-weight:700;margin-bottom:4px;">🏆 ${winnerNameHtml} מנצחת</div>
      <div style="color:#388e3c;font-size:14px;">הווריאנט המנצח עולה לך <span dir="ltr">₪${economic.cr_leader_cpl.toFixed(1)}</span> לליד — מתחת ליעד של <span dir="ltr">₪${economic.target_cpl}</span>. אפשר להעלות תקציב בביטחון.</div>
    </div>`;
    body = `<p style="margin:0 0 12px;color:#444;font-size:14px;">שיפור של <span dir="ltr">+${Math.floor(decision.liftPct)}%</span> מעל הוורסיה השנייה.</p>`;
    cta = btn('הגדל תקציב לקמפיין הזוכה ←', dashboardUrl);
  } else if (decision.verdict === 'WINNER_FOUND' && economic?.verdict === 'NOT_VIABLE') {
    const winnerNameRaw = decision.winnerName || decision.winnerLabel || '';
    const winnerNameHtml = escapeHtml(winnerNameRaw);
    subject = `מצאנו ניסוח מנצח — צריך לדבר על העלות | ${test.name}`;
    headline = `<div style="background:#fff8e1;border-right:4px solid #F59E0B;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#e65100;font-size:18px;font-weight:700;margin-bottom:4px;">יש לנו זוכה בהמרה</div>
      <div style="color:#ef6c00;font-size:14px;">הניסוח של ${winnerNameHtml} ממיר טוב יותר ב-<span dir="ltr">${Math.floor(decision.liftPct)}%</span>, אבל בעלות של <span dir="ltr">₪${economic.cr_leader_cpl.toFixed(1)}</span> לליד — <span dir="ltr">₪${economic.gap.toFixed(1)}</span> מעל היעד שלך. תובנת המסר שווה זהב; השאלה היא איך להוזיל את הליד עצמו.</div>
    </div>`;
    body = ``;
    cta = btn('איך להוזיל את הליד הזה — 4 רעיונות ←', dashboardUrl)
        + `<p style="margin:0 0 12px;color:#666;font-size:12px;text-align:right;">המסר עצמו עובד — שמור עליו לטסט הבא עם הצעה אחרת.</p>`;
  } else if (decision.verdict === 'WINNER_FOUND' && economic?.verdict === 'WINNER_BUT_CHEAPER_ELSEWHERE') {
    const crWinnerName = escapeHtml(decision.winnerName || decision.winnerLabel || '');
    const cplWinnerVar = variantCounts.find(v => v.label === economic.cpl_leader_variant_id || v.variant_id === economic.cpl_leader_variant_id);
    const cplWinnerName = escapeHtml(cplWinnerVar?.name || cplWinnerVar?.label || economic.cpl_leader_variant_id);
    subject = `מצאנו זוכה — אבל וריאציה אחרת זולה יותר לליד | ${test.name}`;
    headline = `<div style="background:#fff8e1;border-right:4px solid #F59E0B;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#e65100;font-size:16px;font-weight:700;margin-bottom:6px;">🏆 ניסוח מנצח: ${crWinnerName}</div>
      <div style="color:#e65100;font-size:14px;margin-bottom:6px;">💰 עלות נמוכה יותר: ${cplWinnerName} (<span dir="ltr">₪${economic.cpl_leader_cpl.toFixed(1)}</span> מול <span dir="ltr">₪${economic.cr_leader_cpl.toFixed(1)}</span>)</div>
      <div style="color:#ef6c00;font-size:14px;">המלצה: השק את ${crWinnerName}, אבל קח את הקריאייטיב/אאודיינס של ${cplWinnerName} ב-Meta כדי להוזיל גם את ה-CPC.</div>
    </div>`;
    body = ``;
    cta = btn('פתח לוח בקרה לפרטים מלאים ←', dashboardUrl);
  } else if (decision.verdict === 'WINNER_FOUND' && isInsufficient) {
    const winnerNameRaw = decision.winnerName || decision.winnerLabel || '';
    const winnerNameHtml = escapeHtml(winnerNameRaw);
    subject = `יש מנצח: ${winnerNameRaw} (+${Math.floor(decision.liftPct)}% שיפור) | ${test.name}`;
    headline = `<div style="background:#e8f5e9;border-right:4px solid #43a047;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#2e7d32;font-size:18px;font-weight:700;margin-bottom:4px;">🏆 ${winnerNameHtml} מנצחת</div>
      <div style="color:#388e3c;font-size:14px;">שיפור של <span dir="ltr">+${Math.floor(decision.liftPct)}%</span> מעל הוורסיה השנייה.</div>
    </div>`;
    body = `<div style="background:#F3F4F6;border-radius:8px;padding:14px;margin:14px 0;">
      <div style="font-weight:700;color:#0d2240;font-size:14px;margin-bottom:6px;">כדי לראות מסקנה כלכלית — צריך מספרי הוצאה עדכניים</div>
      <div style="color:#444;font-size:13px;">ברגע שתעדכני, נחשב מחדש את העלות לליד ונציג את המסקנה המלאה.</div>
    </div>`;
    cta = btn('עדכן הוצאות עכשיו ←', dashboardUrl);
  } else if (decision.verdict === 'WINNER_FOUND') {
    // Existing back-compat path (no economic data)
    const winnerNameRaw = decision.winnerName || decision.winnerLabel || '';
    const winnerNameHtml = escapeHtml(winnerNameRaw);
    subject = `יש מנצח: ${winnerNameRaw} (+${Math.floor(decision.liftPct)}% שיפור) | ${test.name}`;
    headline = `<div style="background:#e8f5e9;border-right:4px solid #43a047;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#2e7d32;font-size:18px;font-weight:700;margin-bottom:4px;">🏆 ${winnerNameHtml} מנצחת</div>
      <div style="color:#388e3c;font-size:14px;">שיפור של <span dir="ltr">+${Math.floor(decision.liftPct)}%</span> מעל הוורסיה השנייה.</div>
    </div>`;
    body = `<p style="margin:0 0 12px;color:#444;font-size:14px;">המלצה: החלף את ה-LP במטא ל-${winnerNameHtml} ועצור את הטסט.</p>`;
    cta = btn('הכרז מנצח ועצור את הטסט', dashboardUrl);
  } else if (decision.verdict === 'PRACTICAL_TIE') {
    subject = `הטסט הסתיים — אין הבדל מובהק בין הוורסיות | ${test.name}`;
    headline = `<div style="background:#fafafa;border-right:4px solid #9e9e9e;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#424242;font-size:18px;font-weight:700;margin-bottom:4px;">אין מנצח ברור</div>
      <div style="color:#616161;font-size:14px;">הוורסיות הניבו ביצועים דומים בטווח השונות הסטטיסטית.</div>
    </div>`;
    body = `<p style="margin:0 0 12px;color:#444;font-size:14px;">מה זה כן אומר: ה-LP הקיים שלך עומד בפני וריאציות גסות. בטסט הבא, נסה שינוי גדול יותר.</p>`;
    cta = btn('צור טסט חדש', newTestUrl);
  } else {
    // TRENDING_UNDERPOWERED
    const winnerName = escapeHtml(decision.winnerName || decision.winnerLabel || '');
    subject = `${winnerName} מוביל אך לא מובהק — להאריך או להחליט? | ${test.name}`;
    headline = `<div style="background:#fff8e1;border-right:4px solid #ffa000;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#e65100;font-size:18px;font-weight:700;margin-bottom:4px;">${winnerName} מוביל — אך לא מובהק</div>
      <div style="color:#ef6c00;font-size:14px;">המגמה ברורה אבל אין מספיק נתונים לקבוע סופית.</div>
    </div>`;
    body = `<p style="margin:0 0 12px;color:#444;font-size:14px;">אפשרויות:</p>
      <ul style="margin:0 0 14px;padding-right:18px;color:#444;font-size:13px;line-height:1.7;">
        <li>להאריך את הטסט ב-50% נוספים מהדגימה.</li>
        <li>להחליט לפי המגמה ולעלות עם ${winnerName} עכשיו.</li>
        <li>לעצור ולנסות וריאציה חדשה לגמרי.</li>
      </ul>`;
    cta = btn('פתח את לוח הבקרה', dashboardUrl);
  }

  const html = SHELL_OPEN + headline + body + standingsTable + cta + SHELL_CLOSE;
  const text = `${subject}\n\n${dashboardUrl}`;
  return { subject, html, text };
}
```

- [ ] **Step 4: Run to verify**

Run: `npm test`
Expected: all tests pass (39 prior + 5 new = 44).

- [ ] **Step 5: Commit**

```bash
git add api/lib/email-templates.js api/lib/email-templates.test.js
git commit -m "feat(email): summary email — 5-way economic-verdict overlay using Agent B Hebrew copy"
```

---

## Stage 4: Project settings UI (`new.html` + `dashboard.html`)

### Task 5: Add `target_cpl` field to project create form (`new.html`)

**Files:**
- Modify: `new.html`

- [ ] **Step 1: Locate the price field**

Run `grep -n 'id="price"' new.html` to find the price input (~line 1131). Find the surrounding `<div>` block (the field wrapper).

- [ ] **Step 2: Insert the target_cpl field block**

After the price field's closing `</div>`, insert:

```html
      <!-- Target CPL (CPL feature) -->
      <div class="field-group" style="margin-top:14px;">
        <label class="field-label">עלות מקסימלית לליד (אופציונלי)</label>
        <div style="position:relative;">
          <input type="number" class="field-input" id="targetCpl" min="0" max="10000" step="0.5" placeholder="40" dir="ltr" style="text-align:left;padding-left:28px;">
          <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-dim,#999);font-size:14px;">₪</span>
        </div>
        <div class="field-hint" style="font-size:12px;color:var(--text-dim,#888);margin-top:6px;line-height:1.5;">
          מעל זה, ליד עולה יותר ממה שהוא שווה. כלל אצבע: 1/3 עד 1/2 מהתרומה הממוצעת. למשל: תרומה ממוצעת ₪120 → CPL ₪40-60.
        </div>
      </div>
```

- [ ] **Step 3: Add target_cpl to project insert payloads**

Run `grep -n "from('projects').insert" new.html` to find the insert call sites (typically 2: questionnaire flow + brief flow). For each, find the `insertData` (or equivalent) object and add this field:

```js
      target_cpl: (() => { const v = parseFloat(document.getElementById('targetCpl').value); return v > 0 ? v : null; })(),
```

- [ ] **Step 4: Verify with grep**

```bash
grep -c 'id="targetCpl"' new.html        # expect 1
grep -c 'target_cpl:' new.html             # expect 2 (one per insert payload)
grep -c 'עלות מקסימלית לליד' new.html  # expect 1
```

- [ ] **Step 5: Commit**

```bash
git add new.html
git commit -m "feat(ui): target_cpl input + hint on project create form"
```

### Task 6: Add `target_cpl` field to project settings tab (`dashboard.html`)

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Locate the existing email-settings section**

Run `grep -n "id=\"email-enabled\"" dashboard.html`. The project's email-settings UI lives near that element.

- [ ] **Step 2: Insert the markup BEFORE the email-settings block**

```html
        <!-- Target CPL (CPL feature) -->
        <div style="margin-bottom:18px; padding:14px; background:var(--navy); border-radius:var(--radius-sm); border:1px solid var(--border);">
          <label style="display:block; color:var(--gold); font-size:13px; font-weight:600; margin-bottom:6px;">עלות מקסימלית לליד (אופציונלי)</label>
          <div style="position:relative; max-width:200px;">
            <input type="number" id="settings-target-cpl" min="0" max="10000" step="0.5" placeholder="40" dir="ltr"
              style="width:100%; padding:8px 28px 8px 10px; background:var(--navy-card); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--white); font-family:'Heebo',sans-serif; font-size:14px; box-sizing:border-box; text-align:left;">
            <span style="position:absolute; left:10px; top:8px; color:var(--text-dim); font-size:14px;">₪</span>
          </div>
          <div style="color:var(--text-dim); font-size:11px; margin-top:6px; line-height:1.5;">
            מעל זה, ליד עולה יותר ממה שהוא שווה. כלל אצבע: 1/3 עד 1/2 מהתרומה הממוצעת. למשל: תרומה ממוצעת ₪120 → CPL ₪40-60.
          </div>
          <button id="btn-save-target-cpl" onclick="saveTargetCpl()" style="margin-top:10px; padding:6px 14px; background:var(--gold-dim); border:1px solid var(--gold); border-radius:var(--radius-sm); color:var(--gold); cursor:pointer; font-family:'Heebo',sans-serif; font-size:12px;">שמור</button>
          <span id="target-cpl-saved" style="display:none; margin-right:8px; color:#81c784; font-size:12px;">נשמר ✓</span>
        </div>
```

- [ ] **Step 3: Add `saveTargetCpl()` and populate the input on settings tab show**

Place near `saveProjectEmail` (or any existing save-settings function):

```js
async function saveTargetCpl() {
  if (!selectedProject) return;
  const raw = document.getElementById('settings-target-cpl').value.trim();
  const value = raw === '' ? null : parseFloat(raw);
  if (raw !== '' && (!Number.isFinite(value) || value < 0 || value > 10000)) {
    alert('נא להזין מספר תקין בין 0 ל-10,000');
    return;
  }
  const btn = document.getElementById('btn-save-target-cpl');
  btn.disabled = true;
  const { error } = await sb.from('projects').update({ target_cpl: value }).eq('id', selectedProject.id);
  btn.disabled = false;
  if (error) { console.error('saveTargetCpl error:', error); alert('שגיאה בשמירה'); return; }
  selectedProject.target_cpl = value;
  const ok = document.getElementById('target-cpl-saved');
  ok.style.display = '';
  setTimeout(() => ok.style.display = 'none', 2500);
}
```

Find the function that loads project settings into the form (search for `email-enabled` checked + `email-subject` value setters). Add this line near where email fields are populated:

```js
  document.getElementById('settings-target-cpl').value = selectedProject?.target_cpl ?? '';
```

- [ ] **Step 4: Verify with grep**

```bash
grep -c 'id="settings-target-cpl"' dashboard.html  # expect 1
grep -c 'function saveTargetCpl' dashboard.html    # expect 1
grep -c 'target_cpl: value' dashboard.html         # expect 1
```

- [ ] **Step 5: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): target_cpl input + save in dashboard project settings tab"
```

---

## Stage 5: Dashboard CPL UI (`dashboard.html` variant cards + calculator + banner)

### Task 7: Add 2 new rows to variant cards (spend + CPL display)

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Locate the variant card render**

Run `grep -n "variant-compare-column\|המרה כוללת\|renderTestAnalytics" dashboard.html | head -10`. Find the function that builds the per-variant card HTML (around line 2917 area where existing metrics are computed).

- [ ] **Step 2: Add the 2 new rows in the card template**

Inside the variant card render code, immediately AFTER the existing metric rows are computed but BEFORE the closing `</div>` of the card markup, add:

```js
      const targetCpl = selectedProject?.target_cpl;
      let spendCplBlock = '';
      if (targetCpl != null && targetCpl > 0) {
        const tv = testVariants.find(t => t.variant_id === m.vid);
        const spend = tv?.spend != null ? Number(tv.spend) : null;
        const spendUpdatedAt = tv?.spend_updated_at;
        const ageDays = spendUpdatedAt ? Math.floor((Date.now() - new Date(spendUpdatedAt).getTime()) / 86400e3) : null;
        const ageColor = ageDays == null ? '#999' : (ageDays > 7 ? '#F59E0B' : '#999');
        const ageLabel = ageDays == null ? 'טרם עודכן' : (ageDays === 0 ? 'עודכן היום' : `עודכן לפני ${ageDays} ימים`);

        const spendFloor = 3 * targetCpl;
        const cpl = (spend != null && m.lc > 0) ? spend / m.lc : null;
        let cplDisplay, cplColor, cplSubLabel;
        if (spend == null || spend < spendFloor) {
          cplDisplay = '—'; cplColor = '#999';
          cplSubLabel = `אין מספיק נתונים (צריך ₪${spendFloor.toFixed(0)} לפחות)`;
        } else if (cpl == null) {
          cplDisplay = '—'; cplColor = '#999'; cplSubLabel = '';
        } else if (cpl <= targetCpl) {
          cplDisplay = `₪${cpl.toFixed(1)}`; cplColor = '#43a047';
          cplSubLabel = `מתחת ליעד ₪${targetCpl}`;
        } else {
          cplDisplay = `₪${cpl.toFixed(1)}`; cplColor = '#F59E0B';
          cplSubLabel = `₪${(cpl - targetCpl).toFixed(1)} מעל היעד`;
        }

        spendCplBlock = `
          <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
              <span style="color:var(--text-dim);font-size:12px;">הוצאה</span>
              <span style="color:var(--white);font-size:13px;font-weight:600;">
                <span dir="ltr">₪${spend != null ? spend.toFixed(0) : '—'}</span>
                <button onclick="editVariantSpend('${m.vid}', ${spend ?? 'null'})" title="עדכן הוצאה" style="background:none;border:none;color:var(--gold);cursor:pointer;font-size:12px;margin-right:4px;">✏️</button>
              </span>
            </div>
            <div style="color:${ageColor};font-size:10px;text-align:left;margin-bottom:8px;">${ageLabel}</div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;" title="עלות לליד = הוצאה ÷ לידים שמילאו טופס. לא מודד איכות לידים — רק כמות.">
              <span style="color:var(--text-dim);font-size:12px;">עלות לליד</span>
              <span style="color:${cplColor};font-size:13px;font-weight:600;"><span dir="ltr">${cplDisplay}</span></span>
            </div>
            <div style="color:var(--text-dim);font-size:10px;text-align:left;margin-top:2px;">${cplSubLabel}</div>
          </div>
        `;
      }
```

Then in the card HTML template string, interpolate `${spendCplBlock}` AT THE END of the card body.

- [ ] **Step 3: Verify with grep**

```bash
grep -c "editVariantSpend(" dashboard.html         # expect 1+ (call site)
grep -c "spendCplBlock" dashboard.html              # expect 2 (definition + interpolation)
grep -c "אין מספיק נתונים" dashboard.html          # expect 1
grep -c "עלות לליד = הוצאה ÷ לידים" dashboard.html # expect 1 (tooltip)
```

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): variant cards show spend + CPL rows when project has target_cpl"
```

### Task 8: Inline edit handler for spend (`editVariantSpend`)

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Add the function**

Place near `_updateRecommendBanner`:

```js
async function editVariantSpend(variantId, currentSpend) {
  const promptText = currentSpend != null
    ? `עדכן הוצאה לוריאנט (₪). ערך נוכחי: ${currentSpend}`
    : 'הזן הוצאה לוריאנט (₪):';
  const raw = window.prompt(promptText, currentSpend ?? '');
  if (raw === null) return;
  const value = parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    alert('נא להזין מספר תקין בין 0 ל-1,000,000');
    return;
  }
  const tv = testVariants.find(t => t.variant_id === variantId);
  if (!tv) { alert('לא נמצאה רשומת וריאנט'); return; }
  const { error } = await sb.from('test_variants')
    .update({ spend: value, spend_updated_at: new Date().toISOString() })
    .eq('id', tv.id);
  if (error) { console.error('editVariantSpend error:', error); alert('שגיאה בעדכון'); return; }
  tv.spend = value;
  tv.spend_updated_at = new Date().toISOString();
  if (typeof renderTestAnalytics === 'function') renderTestAnalytics();
}
```

- [ ] **Step 2: First-use tooltip on the pencil**

Add this once-only init helper and call it from inside the variant-card render function after the cards are appended:

```js
function maybeShowSpendTooltip() {
  if (localStorage.getItem('seen-spend-tooltip')) return;
  setTimeout(() => {
    const pencil = document.querySelector('button[onclick^="editVariantSpend"]');
    if (!pencil) return;
    const tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;background:#0d2240;color:#fff;padding:8px 12px;border-radius:6px;font-size:12px;z-index:9999;box-shadow:0 2px 12px rgba(0,0,0,0.3);';
    tip.textContent = 'עדכן פעם בשבוע — זה מספיק';
    const rect = pencil.getBoundingClientRect();
    tip.style.top = (rect.top - 36 + window.scrollY) + 'px';
    tip.style.right = (window.innerWidth - rect.right - 12) + 'px';
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 4500);
    localStorage.setItem('seen-spend-tooltip', '1');
  }, 800);
}
```

In the variant-card render function, after the cards are written into the DOM, add `maybeShowSpendTooltip();`.

- [ ] **Step 3: Verify**

```bash
grep -c 'function editVariantSpend' dashboard.html       # expect 1
grep -c 'function maybeShowSpendTooltip' dashboard.html  # expect 1
grep -c 'seen-spend-tooltip' dashboard.html              # expect 2
```

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): inline edit for variant spend + first-use tooltip"
```

### Task 9: Calculator soft-enrichment line

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Update `updatePlannerResults()` to append the CPL reality-check line**

Find `async function updatePlannerResults()`. Locate the lines that set `planner-required-n`, `planner-budget`, `planner-days`. Just AFTER `planner-velocity-note` is set, append (this uses safe DOM methods only — no `innerHTML`):

```js
  const targetCpl = selectedProject?.target_cpl;
  const cplNoteEl = document.getElementById('planner-cpl-note');
  if (cplNoteEl && targetCpl != null && targetCpl > 0) {
    const leadsEstimate = Math.round(totalVisitors * baselineCr);
    const targetBudget = Math.round(targetCpl * leadsEstimate);
    const verdict = budget <= targetBudget ? 'בגדר היעד' : 'מעל יעד CPL';
    const verdictColor = budget <= targetBudget ? '#43a047' : '#F59E0B';

    // Build with createElement / textContent to satisfy security guards
    cplNoteEl.textContent = '';
    cplNoteEl.appendChild(document.createTextNode(
      `↪ בתקציב הזה תשיג ~${leadsEstimate.toLocaleString('he-IL')} לידים. בעלות יעד ₪${targetCpl} × ${leadsEstimate} = `
    ));
    const budgetSpan = document.createElement('span');
    budgetSpan.dir = 'ltr';
    budgetSpan.textContent = `₪${targetBudget.toLocaleString('he-IL')}`;
    cplNoteEl.appendChild(budgetSpan);
    cplNoteEl.appendChild(document.createTextNode('. '));
    const verdictSpan = document.createElement('span');
    verdictSpan.style.color = verdictColor;
    verdictSpan.style.fontWeight = '600';
    verdictSpan.textContent = verdict;
    cplNoteEl.appendChild(verdictSpan);

    cplNoteEl.style.display = '';
  } else if (cplNoteEl) {
    cplNoteEl.style.display = 'none';
  }
```

- [ ] **Step 2: Add the `<div id="planner-cpl-note">` to the planner results panel markup**

Find the existing `<div id="planner-results">...</div>` block. Inside it, AFTER the `<div id="planner-velocity-note">...</div>` line, add:

```html
        <div id="planner-cpl-note" style="display:none; color:var(--text-dim); font-size:11px; margin-top:6px; text-align:right;"></div>
```

- [ ] **Step 3: Verify**

```bash
grep -c 'id="planner-cpl-note"' dashboard.html        # expect 1
grep -c 'planner-cpl-note' dashboard.html              # expect 2 (markup + JS)
grep -c 'בגדר היעד\|מעל יעד CPL' dashboard.html      # expect 2
```

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): calculator soft-enrichment line — target_cpl × leads_estimate sanity check"
```

### Task 10: Extend recommend-stop banner for new economic verdicts

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Replace `_updateRecommendBanner` body**

Find `function _updateRecommendBanner()`. Replace its body with:

```js
function _updateRecommendBanner() {
  const banner = document.getElementById('test-recommend-banner');
  if (!banner || !selectedTest) return;

  const fired = selectedTest.summary_sent_at && selectedTest.status === 'running';
  if (!fired) { banner.style.display = 'none'; return; }

  const headlineEl = document.getElementById('test-recommend-headline');
  const bodyEl = document.getElementById('test-recommend-body');
  const ctaEl = document.getElementById('test-recommend-cta');
  banner.style.display = '';

  const verdict = selectedTest.summary_verdict || 'WINNER_FOUND';
  const econ    = selectedTest.economic_verdict;

  const setColors = (border, bg, headlineColor, ctaBg, ctaColor, ctaBorder) => {
    banner.style.borderRightColor = border;
    banner.style.background = bg;
    headlineEl.style.color = headlineColor;
    ctaEl.style.background = ctaBg;
    ctaEl.style.color = ctaColor;
    ctaEl.style.borderColor = ctaBorder;
  };

  if (verdict === 'WINNER_FOUND' && econ === 'VIABLE') {
    setColors('#43a047', 'rgba(67,160,71,0.12)', '#81c784',
              'rgba(76,175,80,0.2)', '#81c784', '#81c784');
    headlineEl.textContent = '🟢 מצאנו מנצח — והעלות לליד מתאימה';
    bodyEl.textContent = 'אפשר להגדיל תקציב על הוורסיה הזו.';
    ctaEl.textContent = 'הכרז מנצח ועצור';
    ctaEl.style.display = '';
  } else if (verdict === 'WINNER_FOUND' && econ === 'NOT_VIABLE') {
    setColors('#F59E0B', 'rgba(245,158,11,0.12)', '#ffb74d',
              'rgba(245,158,11,0.2)', '#ffb74d', '#ffb74d');
    headlineEl.textContent = '🟡 מצאנו מנצח, אבל העלות לליד מעל היעד';
    bodyEl.textContent = 'תובנת המסר שווה — ההצעה צריכה לעבוד שונה. בדוק את המייל לפרטים.';
    ctaEl.textContent = 'איך להוזיל את הליד';
    ctaEl.style.display = '';
  } else if (verdict === 'WINNER_FOUND' && econ === 'WINNER_BUT_CHEAPER_ELSEWHERE') {
    setColors('#F59E0B', 'rgba(245,158,11,0.12)', '#ffb74d',
              'rgba(245,158,11,0.2)', '#ffb74d', '#ffb74d');
    headlineEl.textContent = '🟡 מצאנו מנצח, אבל וריאציה אחרת זולה יותר לליד';
    bodyEl.textContent = 'שקול לשלב — הצעת המנצח, אאודיינס/קריאייטיב של הזולה. בדוק את המייל.';
    ctaEl.textContent = 'פתח לוח בקרה';
    ctaEl.style.display = '';
  } else if (verdict === 'WINNER_FOUND') {
    setColors('#43a047', 'rgba(67,160,71,0.12)', '#81c784',
              'rgba(76,175,80,0.2)', '#81c784', '#81c784');
    headlineEl.textContent = '🟢 מצאנו מנצח';
    bodyEl.textContent = econ === 'INSUFFICIENT_SPEND'
      ? 'עדכן את ההוצאות כדי לקבל מסקנה כלכלית מלאה.'
      : econ === 'INSUFFICIENT_DATA'
        ? 'נתוני ההוצאה לא עדכניים — עדכן כדי לראות מסקנה כלכלית.'
        : 'שלחנו לך מייל עם פירוט. אפשר לעצור את הטסט.';
    ctaEl.textContent = (econ === 'INSUFFICIENT_SPEND' || econ === 'INSUFFICIENT_DATA') ? 'עדכן הוצאות' : 'הכרז מנצח ועצור';
    ctaEl.style.display = '';
  } else if (verdict === 'TRENDING_UNDERPOWERED') {
    setColors('#ffa000', 'rgba(255,160,0,0.12)', '#ffb74d',
              'rgba(255,160,0,0.2)', '#ffb74d', '#ffb74d');
    headlineEl.textContent = '🟡 מוביל אך לא מובהק';
    bodyEl.textContent = 'יש מגמה ברורה אבל אין מובהקות סטטיסטית. בדוק במייל את ההמלצות.';
    ctaEl.textContent = 'הכרז מנצח בכל זאת';
    ctaEl.style.display = '';
  } else {
    setColors('#9e9e9e', 'rgba(158,158,158,0.12)', '#bdbdbd', '', '', '');
    headlineEl.textContent = '⚪ אין הבדל מובהק';
    bodyEl.textContent = 'הוורסיות הניבו ביצועים דומים. בחר על פי שיקולים אחרים.';
    ctaEl.style.display = 'none';
  }
}
```

- [ ] **Step 2: Update CTA dispatch helper**

Add this function near the banner code:

```js
function _onRecommendBannerCta() {
  const ctaEl = document.getElementById('test-recommend-cta');
  if (ctaEl.textContent.includes('עדכן הוצאות')) {
    const firstCard = document.querySelector('.variant-compare-column, [class*="variant"]');
    if (firstCard) firstCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (ctaEl.textContent.includes('פתח לוח')) return;
  showDeclareWinnerModal();
}
```

In the banner markup (find `id="test-recommend-cta"`), change `onclick="showDeclareWinnerModal()"` to `onclick="_onRecommendBannerCta()"`.

- [ ] **Step 3: Verify**

```bash
grep -c 'function _updateRecommendBanner' dashboard.html       # expect 1
grep -c 'function _onRecommendBannerCta' dashboard.html        # expect 1
grep -c 'WINNER_BUT_CHEAPER_ELSEWHERE' dashboard.html          # expect 1
grep -c 'אין הבדל מובהק' dashboard.html                        # expect 1
```

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): banner extended for 5×3 verdict matrix (CR × economic)"
```

---

## Stage 6: Cron + handler wiring

### Task 11: Extend `fetchTestWithCreatorAndVariants` to include project.target_cpl + variant.spend

**Files:**
- Modify: `api/send-email.js`

- [ ] **Step 1: Update the test_variants SELECT**

Find the line containing `select=id,variant_id,label,projects(name,slug),project_variants(variant_slug,is_default)` (in `fetchTestWithCreatorAndVariants`). Change it to include spend + target_cpl:

```js
  const tvRes = await fetch(
    `${SUPABASE_URL}/rest/v1/test_variants?test_id=eq.${testId}&select=id,variant_id,label,spend,spend_updated_at,projects(name,slug,target_cpl),project_variants(variant_slug,is_default)`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
```

- [ ] **Step 2: Return target_cpl alongside the existing return**

Find the return at the end of `fetchTestWithCreatorAndVariants`:
```js
  return { test, creatorEmail: creator.email, testVariants };
```
Replace with:
```js
  return {
    test,
    creatorEmail: creator.email,
    testVariants,
    target_cpl: testVariants[0]?.projects?.target_cpl ?? null,
  };
```

- [ ] **Step 3: Verify**

```bash
grep -c 'spend,spend_updated_at,projects(name,slug,target_cpl)' api/send-email.js  # expect 1
node --check api/send-email.js  # exit 0
npm test  # 44 still passing
```

- [ ] **Step 4: Commit**

```bash
git add api/send-email.js
git commit -m "feat(email): fetchTestWithCreatorAndVariants includes target_cpl + spend per variant"
```

### Task 12: Wire `handleTestSummary` to compute and pass economic verdict

**Files:**
- Modify: `api/send-email.js`

- [ ] **Step 1: Import `computeEconomicVerdict`**

Near the top of `api/send-email.js`, add to the existing import block:

```js
import { computeEconomicVerdict } from "./lib/economic-verdict.js";
```

- [ ] **Step 2: Use target_cpl from the helper return + compute verdict before rendering**

Find `async function handleTestSummary(req, res)`. Update the destructure:
```js
    const { test, creatorEmail, testVariants, target_cpl, error } = await fetchTestWithCreatorAndVariants(test_id);
```

After `variantCountsWithName` is built, insert BEFORE the existing `decision = {...}` build:

```js
    let economic = null;
    try {
      const variantsForVerdict = testVariants.map(tv => {
        const c = counts.find(x => x.variant_id === tv.variant_id) || { conversions: 0 };
        return {
          variant_id: tv.variant_id,
          leads: c.conversions,
          spend: tv.spend != null ? Number(tv.spend) : null,
          spend_updated_at: tv.spend_updated_at,
        };
      });
      economic = computeEconomicVerdict({
        cr_leader_variant_id: test.summary_winner_variant_id,
        variants: variantsForVerdict,
        target_cpl: target_cpl != null ? Number(target_cpl) : null,
      });
    } catch (err) {
      console.error('computeEconomicVerdict failed:', err);
      economic = null;
    }

    const variantCountsWithSpend = variantCountsWithName.map(v => {
      const tv = testVariants.find(t => t.variant_id === v.variant_id || (t.label === v.label));
      return { ...v, spend: tv?.spend != null ? Number(tv.spend) : null };
    });
```

Then update the `decision = {...}` to include `economic`, and pass `variantCountsWithSpend`:

```js
    const decision = {
      verdict: test.summary_verdict,
      winnerLabel,
      winnerName,
      liftPct: test.summary_lift_pct != null ? Number(test.summary_lift_pct) : 0,
      economic,
    };
    const { subject, html, text } = renderSummaryEmail(test, decision, variantCountsWithSpend);
```

- [ ] **Step 3: Verify**

```bash
grep -c 'computeEconomicVerdict' api/send-email.js  # expect 2 (import + call)
grep -c 'variantCountsWithSpend' api/send-email.js   # expect 2
node --check api/send-email.js                        # exit 0
npm test                                               # 44 still passing
```

- [ ] **Step 4: Commit**

```bash
git add api/send-email.js
git commit -m "feat(email): handleTestSummary computes + passes economic verdict to renderer"
```

### Task 13: Wire `markEmailSent` to persist economic verdict columns

**Files:**
- Modify: `api/test-monitor.js`

- [ ] **Step 1: Import `computeEconomicVerdict`**

```js
import { computeEconomicVerdict } from './lib/economic-verdict.js';
```

- [ ] **Step 2: Extend the `'test_summary'` branch in `markEmailSent`**

Find `async function markEmailSent(test, actionName, payload)`. Find the `if (actionName === 'test_summary')` branch. Replace its body with:

```js
  if (actionName === 'test_summary') {
    updates.summary_sent_at = new Date().toISOString();
    updates.summary_verdict = payload.verdict;
    if (payload.winnerVariantId) updates.summary_winner_variant_id = payload.winnerVariantId;
    if (typeof payload.liftPct === 'number') updates.summary_lift_pct = payload.liftPct;

    // CPL feature: also compute and persist the economic verdict
    try {
      const tvRes = await fetch(
        `${SUPABASE_URL}/rest/v1/test_variants?test_id=eq.${test.id}&select=variant_id,spend,spend_updated_at,projects(target_cpl)`,
        { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const tvs = await tvRes.json();
      const target_cpl = tvs[0]?.projects?.target_cpl ?? null;

      const variantCounts = await fetchTestVariantsAndCounts(test);
      const variantsForVerdict = tvs.map(tv => {
        const c = variantCounts.find(x => x.variant_id === tv.variant_id) || { conversions: 0 };
        return {
          variant_id: tv.variant_id,
          leads: c.conversions,
          spend: tv.spend != null ? Number(tv.spend) : null,
          spend_updated_at: tv.spend_updated_at,
        };
      });
      const econ = computeEconomicVerdict({
        cr_leader_variant_id: payload.winnerVariantId,
        variants: variantsForVerdict,
        target_cpl: target_cpl != null ? Number(target_cpl) : null,
      });
      updates.economic_verdict = econ.verdict;
      if (econ.cpl_leader_variant_id) updates.cpl_leader_variant_id = econ.cpl_leader_variant_id;
      if (typeof econ.oldest_spend_age_days === 'number' && Number.isFinite(econ.oldest_spend_age_days)) {
        updates.oldest_spend_age_days = econ.oldest_spend_age_days;
      }
    } catch (err) {
      console.error('markEmailSent: economic-verdict computation failed:', err);
    }
  }
```

- [ ] **Step 3: Verify**

```bash
grep -c 'computeEconomicVerdict' api/test-monitor.js     # expect 2 (import + call)
grep -c 'updates.economic_verdict' api/test-monitor.js   # expect 1
node --check api/test-monitor.js                          # exit 0
npm test                                                   # 44 still passing
```

- [ ] **Step 4: Commit**

```bash
git add api/test-monitor.js
git commit -m "feat(cron): markEmailSent computes + persists economic_verdict columns"
```

---

## Stage 7: Smoke test on Vercel preview

### Task 14: End-to-end smoke test

**Files:** none modified — verification only.

- [ ] **Step 1: Push branch + wait for preview deploy**

```bash
git push
```

Wait ~1 min for the Vercel preview to rebuild:
```bash
until curl -sS "https://messaginglab-git-feat-test-planner-emails-guydotan55s-projects.vercel.app/api/test-monitor" -H "Authorization: Bearer noop" -o /dev/null; do sleep 5; done
```

- [ ] **Step 2: Verify the public LP route still works** (CLAUDE.md sacred check)

```bash
curl -sI "https://messaginglab-git-feat-test-planner-emails-guydotan55s-projects.vercel.app/lp/lipaz-ela-1" | head -1
```
Expected: `HTTP/2 200`. If 500: STOP — investigate.

- [ ] **Step 3: Set target_cpl = 40 on the live customer's projects**

Use Supabase MCP `mcp__claude_ai_Supabase__execute_sql` against project_id `uaspcafukqvgiztzdnfu`:

```sql
UPDATE projects SET target_cpl = 40
WHERE id IN (
  SELECT pv.project_id FROM project_variants pv
  JOIN test_variants tv ON tv.variant_id = pv.id
  WHERE tv.test_id = '2db7b8d7-e9d8-47d1-a431-4d30f7281970'
)
RETURNING id, name, target_cpl;
```

- [ ] **Step 4: Backfill spend on each variant**

```sql
UPDATE test_variants SET spend = 380, spend_updated_at = now()
  WHERE variant_id = '56ba2d1a-3637-4117-9084-768620f1c03c'
    AND test_id = '2db7b8d7-e9d8-47d1-a431-4d30f7281970';
UPDATE test_variants SET spend = 200, spend_updated_at = now()
  WHERE variant_id = '0a66a85b-cbdb-483a-8c65-46946e6e3a6c'
    AND test_id = '2db7b8d7-e9d8-47d1-a431-4d30f7281970';
UPDATE test_variants SET spend = 320, spend_updated_at = now()
  WHERE variant_id = '67ce1c49-0f62-4688-9a17-4f7164a7ddc6'
    AND test_id = '2db7b8d7-e9d8-47d1-a431-4d30f7281970';
```

- [ ] **Step 5: Trigger the summary email send (impersonate libby for review)**

```sql
UPDATE tests SET created_by='f22ac213-974c-40a4-afe0-fe154e2517f6', summary_verdict='WINNER_FOUND', summary_winner_variant_id='56ba2d1a-3637-4117-9084-768620f1c03c', summary_lift_pct=31.0, summary_sent_at=NULL, economic_verdict=NULL WHERE id='2db7b8d7-e9d8-47d1-a431-4d30f7281970';
```

```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -d '{"action":"test_summary","test_id":"2db7b8d7-e9d8-47d1-a431-4d30f7281970"}' \
  "https://messaginglab-git-feat-test-planner-emails-guydotan55s-projects.vercel.app/api/send-email"
```

Expected: `{"success":true,"messageId":"<...>"}`. Email arrives at libby.negev.ai@gmail.com with subject `יש זוכה ✓ והעלות לליד עומדת ביעד שלך | ליפז אלה - בדיקת מסרים והתכנות`.

- [ ] **Step 6: Restore test row + verify dashboard banner**

```sql
UPDATE tests SET created_by='7b549370-9e16-480e-9c74-1d4d1fe84fc2' WHERE id='2db7b8d7-e9d8-47d1-a431-4d30f7281970';
```

In the dashboard preview, select that test → green "מצאנו מנצח — והעלות לליד מתאימה" banner with the "הכרז מנצח ועצור" CTA.

- [ ] **Step 7: Test NOT_VIABLE path**

```sql
UPDATE projects SET target_cpl = 10 WHERE id IN (SELECT pv.project_id FROM project_variants pv JOIN test_variants tv ON tv.variant_id = pv.id WHERE tv.test_id = '2db7b8d7-e9d8-47d1-a431-4d30f7281970');
UPDATE tests SET created_by='f22ac213-974c-40a4-afe0-fe154e2517f6', summary_sent_at=NULL, economic_verdict=NULL WHERE id='2db7b8d7-e9d8-47d1-a431-4d30f7281970';
```
Re-fire the curl. Expected: subject becomes `מצאנו ניסוח מנצח — צריך לדבר על העלות` OR `מצאנו זוכה — אבל וריאציה אחרת זולה יותר לליד`. Restore creator after.

- [ ] **Step 8: Test INSUFFICIENT_SPEND path**

```sql
UPDATE projects SET target_cpl = 200 WHERE id IN (SELECT pv.project_id FROM project_variants pv JOIN test_variants tv ON tv.variant_id = pv.id WHERE tv.test_id = '2db7b8d7-e9d8-47d1-a431-4d30f7281970');
UPDATE tests SET created_by='f22ac213-974c-40a4-afe0-fe154e2517f6', summary_sent_at=NULL, economic_verdict=NULL WHERE id='2db7b8d7-e9d8-47d1-a431-4d30f7281970';
```
Re-fire. Expected: subject reverts to `יש מנצח: ...` + body shows "update spend" prompt card.

- [ ] **Step 9: Restore everything**

```sql
UPDATE projects SET target_cpl = NULL WHERE id IN (SELECT pv.project_id FROM project_variants pv JOIN test_variants tv ON tv.variant_id = pv.id WHERE tv.test_id = '2db7b8d7-e9d8-47d1-a431-4d30f7281970');
UPDATE test_variants SET spend = NULL, spend_updated_at = NULL WHERE test_id = '2db7b8d7-e9d8-47d1-a431-4d30f7281970';
UPDATE tests SET created_by='7b549370-9e16-480e-9c74-1d4d1fe84fc2', economic_verdict=NULL, cpl_leader_variant_id=NULL, oldest_spend_age_days=NULL, summary_sent_at=NULL WHERE id='2db7b8d7-e9d8-47d1-a431-4d30f7281970';
```

- [ ] **Step 10: Verify Vercel function count is still 11/12**

Vercel dashboard → project → Functions tab. Confirm count is 11.

---

## Self-Review

**Spec coverage check** — every spec section maps to one or more tasks:

| Spec § | Topic | Task |
|---|---|---|
| §1 Goals: calc enrichment | Task 9 |
| §1 Goals: dashboard CPL | Tasks 7, 8 |
| §1 Goals: summary verdict | Task 4 |
| §4 Architecture | Tasks 11-13 |
| §5 Data model | Task 1 |
| §6 Verdict computation | Task 3 |
| §7.1 Project settings target_cpl | Tasks 5, 6 |
| §7.2 Calculator soft enrichment | Task 9 |
| §7.3 Variant cards | Tasks 7, 8 |
| §7.4 Banner extension | Task 10 |
| §8 Email content | Task 4 |
| §9 Dispatch (5 agents, 3 stages) | Implicit task ordering |
| §10 Error handling (try/catch graceful degrade) | Tasks 4, 12, 13 |
| §11 Testing (verdict + email tests) | Tasks 3, 4 |
| §12 Verification | Task 14 |

**Placeholder scan:** Every step has executable code or commands. No "TBD" / "TODO" / "implement later" present.

**Type consistency check:**
- `computeEconomicVerdict` returns `{verdict, ...}` where verdict ∈ `{VIABLE, NOT_VIABLE, WINNER_BUT_CHEAPER_ELSEWHERE, INSUFFICIENT_SPEND, INSUFFICIENT_DATA}` — used identically across email-templates renderSummaryEmail switch (Task 4), send-email handleTestSummary decision payload (Task 12), test-monitor markEmailSent persistence (Task 13), dashboard banner switch (Task 10).
- `decision.economic.verdict` is the discriminator the renderer reads. ✓
- DB column `economic_verdict` matches the verdict string values via CHECK constraint. ✓
- `target_cpl` is `NUMERIC(8,2)` in DB → `Number(target_cpl)` coercion in JS. ✓
- `spend` / `spend_updated_at` consistent across DB schema (Task 1), fetchTestWithCreatorAndVariants (Task 11), computeEconomicVerdict input (Task 3), dashboard editVariantSpend write (Task 8). ✓

No inconsistencies found.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-05-cpl-per-variant.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best fit because Tasks 3 (verdict engine), 4 (email templates), 5 (project create form) and 6 (project settings tab) touch different files and can each be a tight subagent dispatch.

**2. Inline Execution** — Work through tasks in this same session using executing-plans, batch execution with checkpoints. Simpler to watch live.

**Which approach?**
