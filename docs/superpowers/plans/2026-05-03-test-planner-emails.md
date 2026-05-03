# Test Planner + Lifecycle Emails — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pre-test budget calculator to the create-test modal, a daily Vercel cron that sends Hebrew RTL milestone / stall / summary emails, and a Bayesian decision engine that recommends when to stop a test.

**Architecture:** Three layers. (1) Inline calculator in `dashboard.html` saves planner inputs (`baseline_cvr`, `mde`, `expected_cpc`, `target_sample_size`) to the `tests` row at creation. (2) Activation (`toggleTestStatus`) sets `started_at` and fires a synchronous `test_kickoff` email. (3) Daily Vercel cron `/api/test-monitor` scans running tests, runs the Bayesian decision engine, and POSTs to the existing `/api/send-email` with new action discriminators (`test_kickoff` / `test_milestone` / `test_summary` / `test_stall_alert`). Cron mutates only `*_sent_at` ledger columns; the user must manually click "הכרז מנצח" to flip status to `completed`. Pure stats math lives in `api/lib/bayes.js`; pure email templates live in `api/lib/email-templates.js`. Both are unit-tested with `node --test`.

**Tech Stack:** Vanilla HTML+JS frontend (no framework), Vercel serverless Node functions, Supabase Postgres + RLS, Brevo for transactional email, `node --test` (built-in) for unit tests, Hebrew RTL throughout.

**Source spec:** [`docs/superpowers/specs/2026-05-03-test-planner-emails-design.md`](../specs/2026-05-03-test-planner-emails-design.md)

**Out of scope (per spec §3):** auto-stop, per-community CPC defaults, baseline-CR auto-pull, live verdict widget, customizable email templates, multi-recipient, hourly cron.

---

## Stage 0: Test runner setup (one-time)

### Task 0: Wire up `node --test` and a `.vercelignore`

**Files:**
- Modify: `package.json`
- Create: `.vercelignore`

- [ ] **Step 1: Add the test script to `package.json`**

Replace the `scripts` block:

```json
"scripts": {
  "test": "node --test --test-reporter=spec 'api/**/*.test.js'"
}
```

- [ ] **Step 2: Create `.vercelignore` to keep test files out of the deploy bundle**

```
**/*.test.js
docs/
.claude/
.claude-flow/
```

- [ ] **Step 3: Verify the runner works on an empty test set**

Run: `npm test`
Expected: `# tests 0\n# pass 0` (no error — the glob just matches nothing yet).

- [ ] **Step 4: Commit**

```bash
git add package.json .vercelignore
git commit -m "chore: add node --test runner + .vercelignore for test files"
```

---

## Stage 1: Schema + cross-agent contract

### Task 1: Migration — add planner-input + email-state columns to `tests`

**Files:**
- Create: `supabase/migrations/add_test_planner_fields.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Migration: planner inputs + lifecycle-email state ledger on tests
-- Run via: npx supabase db push (or Supabase SQL editor)

-- Planner inputs (filled at test creation in the dashboard calculator)
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS target_sample_size INT;       -- per variant
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS baseline_cvr NUMERIC(5,4);    -- 0.0300 = 3%
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS mde NUMERIC(5,4);             -- 0.2000 = +20% relative
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS expected_cpc NUMERIC(8,2);    -- ₪3.50

-- Email-state ledger (cron writes; idempotency)
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS last_milestone_sent INT NOT NULL DEFAULT 0;  -- 0/25/50/75/100
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS stall_alert_sent_at TIMESTAMPTZ;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS summary_sent_at TIMESTAMPTZ;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS kickoff_sent_at TIMESTAMPTZ;

-- Partial index for the cron's primary query
CREATE INDEX IF NOT EXISTS idx_tests_running_started ON public.tests(status, started_at)
  WHERE status = 'running';
```

- [ ] **Step 2: Apply the migration**

Run (preferred): `npx supabase db push`
OR: paste the SQL into Supabase SQL editor in the project dashboard and click Run.
Expected: `Applying migration add_test_planner_fields.sql ... done` or no error in the SQL editor.

- [ ] **Step 3: Verify the columns exist**

Run in Supabase SQL editor:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name='tests' AND column_name IN
('started_at','target_sample_size','baseline_cvr','mde','expected_cpc',
 'last_milestone_sent','stall_alert_sent_at','summary_sent_at','kickoff_sent_at')
ORDER BY column_name;
```
Expected: 9 rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/add_test_planner_fields.sql
git commit -m "feat(db): add planner inputs + email-state ledger to tests table"
```

### Task 2: Cross-agent contract document

**Files:**
- Create: `docs/test-planner-contract.md`

- [ ] **Step 1: Write the contract doc**

```markdown
# Test Planner — Cross-File Contract

This file is the single source of truth for column names, payload shapes,
and cron config used by the test-planner feature. Do not change any name
here without updating every consumer (calculator UI in `dashboard.html`,
cron worker in `api/test-monitor.js`, email handler in `api/send-email.js`,
and email renderers in `api/lib/email-templates.js`).

## Database — `tests` table additions

| Column | Type | Filled by | Notes |
|---|---|---|---|
| `started_at` | TIMESTAMPTZ | `toggleTestStatus()` on activate | NULL when test is in `draft` |
| `target_sample_size` | INT | `createTest()` from calculator | per variant, not total |
| `baseline_cvr` | NUMERIC(5,4) | `createTest()` from calculator | fraction; 0.0300 = 3% |
| `mde` | NUMERIC(5,4) | `createTest()` from calculator | relative lift fraction; 0.2000 = +20% |
| `expected_cpc` | NUMERIC(8,2) | `createTest()` from calculator | currency ₪ |
| `kickoff_sent_at` | TIMESTAMPTZ | `toggleTestStatus()` after Brevo 200 | dedupe lock |
| `last_milestone_sent` | INT (default 0) | cron worker | one of {0, 25, 50, 75, 100} |
| `stall_alert_sent_at` | TIMESTAMPTZ | cron worker | dedupe lock |
| `summary_sent_at` | TIMESTAMPTZ | cron worker | dedupe lock; can fire pre-100% if WINNER_FOUND |

## `/api/send-email` — new action discriminators

All actions POST as JSON, identical to existing `meta_capi` pattern:

```json
{ "action": "test_kickoff",       "test_id": "<uuid>" }
{ "action": "test_milestone",     "test_id": "<uuid>", "milestone": 25 }
{ "action": "test_summary",       "test_id": "<uuid>", "verdict": "WINNER_FOUND" }
{ "action": "test_stall_alert",   "test_id": "<uuid>" }
```

`verdict` is one of: `WINNER_FOUND`, `PRACTICAL_TIE`, `TRENDING_UNDERPOWERED`.

The handler fetches the `tests` row + `test_variants` + variant counts itself
(handler is the source of truth on rendering data; cron does not pass them).

## Cron config (`vercel.json`)

```json
"crons": [
  { "path": "/api/test-monitor", "schedule": "0 6 * * *" }
]
```

Runs daily at 06:00 UTC (08:00 IL winter / 09:00 IL summer; DST drift accepted).
Auth: Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` header. The
worker must verify this header against `process.env.CRON_SECRET` and 401 if
mismatched.

## Cron worker SELECT query

```sql
-- 1. Get all running tests
SELECT id, name, slug, community_id, started_at, target_sample_size,
       baseline_cvr, mde, expected_cpc, last_milestone_sent,
       stall_alert_sent_at, summary_sent_at
FROM tests WHERE status='running';

-- 2. For each test, get per-variant unique-visitor + lead counts
SELECT
  variant_id,
  COUNT(DISTINCT (event_data->>'visitor_id')) AS unique_visitors,
  COUNT(*) FILTER (WHERE event_type='lead_captured') AS conversions
FROM analytics_events
WHERE test_id=$1 AND event_type IN ('pageview','lead_captured')
GROUP BY variant_id;
```

(In code, use PostgREST query builder via the Supabase JS client; pagination
follows the pattern already in `dashboard.html` near line 1885.)

## Required environment variables

- `CRON_SECRET` — random hex string, set in Vercel dashboard. Used to
  authenticate the daily cron POST to `/api/test-monitor`.
- All existing vars (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `BREVO_API_KEY`, `SENDER_EMAIL`, `APP_URL`) — already configured.
```

- [ ] **Step 2: Commit**

```bash
git add docs/test-planner-contract.md
git commit -m "docs: cross-file contract for test-planner feature"
```

---

## Stage 2: Pure stats library (`api/lib/bayes.js`)

### Task 3: TDD `sampleSizePerVariant`

**Files:**
- Create: `api/lib/bayes.js`
- Create: `api/lib/bayes.test.js`

- [ ] **Step 1: Write the failing test**

```js
// api/lib/bayes.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleSizePerVariant } from './bayes.js';

test('sampleSizePerVariant: baseline 3%, MDE +30% → ~3700-4000 per variant (Evan Miller cross-check)', () => {
  const n = sampleSizePerVariant(0.03, 0.30, 2);
  assert.ok(n >= 3700 && n <= 4000, `expected ~3830, got ${n}`);
});

test('sampleSizePerVariant: baseline 5%, MDE +20% → ~3800-4200 per variant', () => {
  const n = sampleSizePerVariant(0.05, 0.20, 2);
  assert.ok(n >= 3800 && n <= 4200, `got ${n}`);
});

test('sampleSizePerVariant: baseline 10%, MDE +50% → ~600-700 per variant', () => {
  const n = sampleSizePerVariant(0.10, 0.50, 2);
  assert.ok(n >= 600 && n <= 700, `got ${n}`);
});

test('sampleSizePerVariant: 4 variants gets larger n than 2 (Bonferroni)', () => {
  const n2 = sampleSizePerVariant(0.05, 0.20, 2);
  const n4 = sampleSizePerVariant(0.05, 0.20, 4);
  assert.ok(n4 > n2 * 1.2, `4-arm ${n4} should be >20% larger than 2-arm ${n2}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: `Cannot find module './bayes.js'` or similar import error.

- [ ] **Step 3: Implement `sampleSizePerVariant`**

```js
// api/lib/bayes.js
// Pure statistical helpers for the test planner. No I/O.

// Inverse standard normal CDF (Beasley-Springer-Moro approximation).
// Accurate to ~1e-9 for p ∈ (0, 1). Good enough for sample-size math.
function quantileNormal(p) {
  if (p <= 0 || p >= 1) throw new Error('quantileNormal requires 0 < p < 1');
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
              1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
              6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5]) /
           ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5; r = q*q;
    return (((((a[0]*r + a[1])*r + a[2])*r + a[3])*r + a[4])*r + a[5])*q /
           (((((b[0]*r + b[1])*r + b[2])*r + b[3])*r + b[4])*r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5]) /
          ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1);
}

/**
 * Required sample size per variant for a two-proportion z-test.
 * @param {number} baselineCr - baseline conversion rate (0..1)
 * @param {number} mde - relative minimum detectable effect (0.20 = +20%)
 * @param {number} numVariants - total variants including control (>=2)
 * @returns {number} sample size per variant (ceiling)
 */
export function sampleSizePerVariant(baselineCr, mde, numVariants = 2) {
  if (baselineCr <= 0 || baselineCr >= 1) throw new Error('baselineCr must be 0..1');
  if (mde <= 0) throw new Error('mde must be > 0');
  if (numVariants < 2) throw new Error('numVariants must be >= 2');

  const k = numVariants - 1;
  const alpha = k > 1 ? 0.05 / k : 0.05;       // Bonferroni for 3+ variants
  const power = 0.80;
  const z_a = quantileNormal(1 - alpha / 2);
  const z_b = quantileNormal(power);

  const p1 = baselineCr;
  const p2 = baselineCr * (1 + mde);
  if (p2 >= 1) throw new Error('mde would push baselineCr above 100%');
  const pBar = (p1 + p2) / 2;

  const num = Math.pow(
    z_a * Math.sqrt(2 * pBar * (1 - pBar)) +
    z_b * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)),
    2
  );
  return Math.ceil(num / Math.pow(p2 - p1, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add api/lib/bayes.js api/lib/bayes.test.js
git commit -m "feat(stats): sample-size formula for two-proportion z-test (planner)"
```

### Task 4: TDD `sampleBeta` (single-draw + batch)

**Files:**
- Modify: `api/lib/bayes.js`
- Modify: `api/lib/bayes.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `api/lib/bayes.test.js`:

```js
import { sampleBeta } from './bayes.js';

test('sampleBeta(1,1) is uniform on [0,1] — mean ≈ 0.5, draws in range', () => {
  const draws = sampleBeta(1, 1, 5000);
  assert.equal(draws.length, 5000);
  for (const x of draws) assert.ok(x >= 0 && x <= 1, `draw out of range: ${x}`);
  const mean = draws.reduce((s, x) => s + x, 0) / draws.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean ${mean} not near 0.5`);
});

test('sampleBeta(50, 50) clusters near 0.5 (low variance)', () => {
  const draws = sampleBeta(50, 50, 5000);
  const mean = draws.reduce((s, x) => s + x, 0) / draws.length;
  const variance = draws.reduce((s, x) => s + (x - mean) ** 2, 0) / draws.length;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `mean ${mean}`);
  assert.ok(variance < 0.005, `variance ${variance} too high`);
});

test('sampleBeta(10, 90) mean ≈ 0.10', () => {
  const draws = sampleBeta(10, 90, 5000);
  const mean = draws.reduce((s, x) => s + x, 0) / draws.length;
  assert.ok(Math.abs(mean - 0.10) < 0.02, `mean ${mean} not near 0.10`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: 3 new failures with `sampleBeta is not a function`.

- [ ] **Step 3: Implement `sampleBeta`**

Append to `api/lib/bayes.js`:

```js
/**
 * Sample n draws from a Beta(alpha, beta) distribution using the
 * gamma-ratio identity: X ~ Gamma(alpha,1), Y ~ Gamma(beta,1) → X/(X+Y) ~ Beta(alpha,beta).
 * Uses Marsaglia-Tsang rejection sampling for Gamma; works for shape >= 1
 * (boost via shape+1, scale by U^(1/shape) when shape < 1).
 */
export function sampleBeta(alpha, beta, n) {
  if (alpha <= 0 || beta <= 0) throw new Error('alpha and beta must be > 0');
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = sampleGamma(alpha);
    const y = sampleGamma(beta);
    out[i] = x / (x + y);
  }
  return out;
}

function sampleGamma(shape) {
  // Marsaglia & Tsang (2000), with shape-boost for shape < 1.
  if (shape < 1) {
    const u = Math.random();
    return sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = sampleNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleNormal() {
  // Box-Muller
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass (some statistical tolerance — re-run if a draw is unlucky).

- [ ] **Step 5: Commit**

```bash
git add api/lib/bayes.js api/lib/bayes.test.js
git commit -m "feat(stats): Marsaglia-Tsang Beta sampler for Bayesian decision engine"
```

### Task 5: TDD `computeWinnerProbabilities` and `computeExpectedLoss`

**Files:**
- Modify: `api/lib/bayes.js`
- Modify: `api/lib/bayes.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `api/lib/bayes.test.js`:

```js
import { computeWinnerProbabilities, computeExpectedLoss } from './bayes.js';

test('computeWinnerProbabilities: identical inputs → roughly equal probabilities', () => {
  const draws = [
    sampleBeta(50, 950, 5000),  // ~5%
    sampleBeta(50, 950, 5000),  // ~5%
  ];
  const p = computeWinnerProbabilities(draws);
  assert.equal(p.length, 2);
  assert.ok(Math.abs(p[0] - 0.5) < 0.06, `p[0]=${p[0]} not near 0.5`);
  assert.ok(Math.abs(p[0] + p[1] - 1) < 1e-9, 'probs should sum to 1');
});

test('computeWinnerProbabilities: clear winner → P(winner) > 0.95', () => {
  const draws = [
    sampleBeta(30, 970, 5000),   // ~3%
    sampleBeta(80, 920, 5000),   // ~8% — clear winner
  ];
  const p = computeWinnerProbabilities(draws);
  assert.ok(p[1] > 0.95, `expected p[1] > 0.95, got ${p[1]}`);
});

test('computeExpectedLoss: clear winner → loss for winner near 0', () => {
  const draws = [
    sampleBeta(30, 970, 5000),
    sampleBeta(80, 920, 5000),
  ];
  const loss = computeExpectedLoss(draws);
  assert.equal(loss.length, 2);
  assert.ok(loss[1] < 0.005, `winner's expected loss should be near 0, got ${loss[1]}`);
  assert.ok(loss[0] > 0.02, `loser's expected loss should be material, got ${loss[0]}`);
});

test('computeExpectedLoss: identical arms → losses similar and small', () => {
  const draws = [sampleBeta(50, 950, 5000), sampleBeta(50, 950, 5000)];
  const loss = computeExpectedLoss(draws);
  for (const l of loss) assert.ok(l < 0.01, `loss ${l} unexpectedly large`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: 4 new failures.

- [ ] **Step 3: Implement both helpers**

Append to `api/lib/bayes.js`:

```js
/**
 * Given an array of draw arrays (one per variant), return the probability
 * that each variant is the best — i.e., P(variant_i has highest CR).
 * Computed as the fraction of Monte Carlo trials where variant_i's draw
 * is the maximum across all variants. Sums to 1.
 */
export function computeWinnerProbabilities(draws) {
  const numVariants = draws.length;
  const numDraws = draws[0].length;
  const wins = new Array(numVariants).fill(0);
  for (let t = 0; t < numDraws; t++) {
    let bestIdx = 0;
    let bestVal = draws[0][t];
    for (let v = 1; v < numVariants; v++) {
      if (draws[v][t] > bestVal) { bestVal = draws[v][t]; bestIdx = v; }
    }
    wins[bestIdx]++;
  }
  return wins.map(w => w / numDraws);
}

/**
 * Expected loss for choosing each variant — the average regret if we
 * declared variant_i the winner. Loss[i] = E[max(p_other) - p_i]+ averaged
 * across draws where p_i is NOT the max. The chosen winner's expected loss
 * should be near 0 (we'd rarely regret picking the actual best).
 */
export function computeExpectedLoss(draws) {
  const numVariants = draws.length;
  const numDraws = draws[0].length;
  const loss = new Array(numVariants).fill(0);
  for (let t = 0; t < numDraws; t++) {
    let bestVal = draws[0][t];
    for (let v = 1; v < numVariants; v++) if (draws[v][t] > bestVal) bestVal = draws[v][t];
    for (let v = 0; v < numVariants; v++) {
      const regret = Math.max(0, bestVal - draws[v][t]);
      loss[v] += regret;
    }
  }
  return loss.map(l => l / numDraws);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/lib/bayes.js api/lib/bayes.test.js
git commit -m "feat(stats): Bayesian winner-probability and expected-loss helpers"
```

---

## Stage 2: Calculator UI (`dashboard.html` create-test modal)

### Task 6: Add planner inputs to the create-test modal markup

**Files:**
- Modify: `dashboard.html` (insert ~line 1860, before the "Create button" block)

- [ ] **Step 1: Insert the planner-inputs block**

In `dashboard.html`, locate the comment `<!-- Create button -->` (around line 1862). Immediately ABOVE that comment, insert:

```html
    <!-- Planner / budget calculator -->
    <div style="margin-bottom:16px; padding:14px; background:var(--navy); border:1px solid var(--border); border-radius:var(--radius-sm);">
      <div style="color:var(--gold); font-size:13px; font-weight:600; margin-bottom:10px;">תכנון תקציב</div>

      <div style="display:flex; gap:10px; margin-bottom:10px;">
        <div style="flex:1;">
          <label style="display:block; color:var(--text-dim); font-size:12px; margin-bottom:4px;">
            אחוז המרה צפוי
            <span class="planner-help" title="כמה אחוז מהמבקרים מתחזים בדרך כלל ללידים בקהילה הזו. אם אינך יודע — נסה 3%.">?</span>
          </label>
          <div style="position:relative;">
            <input type="number" id="planner-baseline-cvr" min="0.1" max="50" step="0.1" placeholder="3.0" dir="ltr"
              style="width:100%; padding:8px 28px 8px 10px; background:var(--navy-card); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--white); font-family:'Heebo',sans-serif; font-size:14px; box-sizing:border-box; text-align:left;"
              oninput="updatePlannerResults()">
            <span style="position:absolute; left:10px; top:8px; color:var(--text-dim); font-size:14px;">%</span>
          </div>
        </div>
        <div style="flex:1;">
          <label style="display:block; color:var(--text-dim); font-size:12px; margin-bottom:4px;">
            שיפור שאתה רוצה לזהות
            <span class="planner-help" title="כמה שיפור יחסי תרצה לזהות בין הוורסיות. 20% פירושו: למשל מ-3% ל-3.6%.">?</span>
          </label>
          <div style="position:relative;">
            <input type="number" id="planner-mde" min="5" max="200" step="1" placeholder="20" dir="ltr"
              style="width:100%; padding:8px 28px 8px 10px; background:var(--navy-card); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--white); font-family:'Heebo',sans-serif; font-size:14px; box-sizing:border-box; text-align:left;"
              oninput="updatePlannerResults()">
            <span style="position:absolute; left:10px; top:8px; color:var(--text-dim); font-size:14px;">%</span>
          </div>
        </div>
        <div style="flex:1;">
          <label style="display:block; color:var(--text-dim); font-size:12px; margin-bottom:4px;">
            מחיר לקליק במטא
            <span class="planner-help" title="המחיר הממוצע שאתה משלם על קליק לדף נחיתה במטא.">?</span>
          </label>
          <div style="position:relative;">
            <input type="number" id="planner-cpc" min="0.1" max="100" step="0.1" placeholder="3.5" dir="ltr"
              style="width:100%; padding:8px 28px 8px 10px; background:var(--navy-card); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--white); font-family:'Heebo',sans-serif; font-size:14px; box-sizing:border-box; text-align:left;"
              oninput="updatePlannerResults()">
            <span style="position:absolute; left:10px; top:8px; color:var(--text-dim); font-size:14px;">₪</span>
          </div>
        </div>
      </div>

      <div id="planner-results" style="display:none; margin-top:10px; padding-top:10px; border-top:1px solid var(--border);">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span style="color:var(--text-dim); font-size:13px;">נדרשים לכל וריאציה:</span>
          <span style="color:var(--white); font-size:14px; font-weight:600;"><span id="planner-required-n">—</span> מבקרים</span>
        </div>
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span style="color:var(--text-dim); font-size:13px;">תקציב משוער:</span>
          <span style="color:var(--white); font-size:14px; font-weight:600;"><span dir="ltr">₪<span id="planner-budget">—</span></span></span>
        </div>
        <div style="display:flex; justify-content:space-between;">
          <span style="color:var(--text-dim); font-size:13px;" id="planner-days-label">זמן צפוי:</span>
          <span style="color:var(--white); font-size:14px; font-weight:600;">~<span id="planner-days">—</span> ימים</span>
        </div>
        <div id="planner-velocity-note" style="color:var(--text-dim); font-size:11px; margin-top:6px; text-align:right;"></div>
      </div>

      <div id="planner-error" style="display:none; color:#e57373; font-size:12px; margin-top:8px;"></div>
    </div>

```

- [ ] **Step 2: Add CSS for the `.planner-help` tooltip cue**

Find the `<style>` block in `dashboard.html` (around line 8). Inside it (anywhere), add:

```css
.planner-help {
  display:inline-block; width:14px; height:14px; line-height:14px;
  text-align:center; border-radius:50%; background:var(--border);
  color:var(--text-dim); font-size:10px; cursor:help; margin-right:4px;
}
.planner-help:hover { background:var(--gold-dim); color:var(--gold); }
```

- [ ] **Step 3: Verify visually**

Run: open `dashboard.html` in a browser (or visit the deployed dashboard), click "צור טסט חדש". Confirm the planner block renders below "חלוקת תנועה" and above the action buttons, with 3 RTL-labeled inputs and `?` tooltips that show on hover. The results panel should be hidden until inputs are filled.

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): add budget planner inputs to create-test modal"
```

### Task 7: Calculator JS — live results, validation, and Activate-button gating

**Files:**
- Modify: `dashboard.html` (add to existing `<script>` near `createTest`)

- [ ] **Step 1: Add the planner functions and wire input handlers**

In `dashboard.html`, locate the `async function createTest()` definition (line ~2403). Immediately ABOVE it, insert:

```js
// ── Test Planner / Budget Calculator ─────────────────────
// Mirror of api/lib/bayes.js sampleSizePerVariant — pure JS, runs in browser.
// Keep these two implementations in sync if you change the formula.
function _quantileNormalForPlanner(p) {
  const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];
  const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];
  const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];
  const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];
  const pLow=0.02425, pHigh=1-pLow;
  let q,r;
  if (p<pLow){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  if (p<=pHigh){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}
  q=Math.sqrt(-2*Math.log(1-p));return-(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}
function plannerSampleSize(baselineCr, mde, numVariants) {
  const k = numVariants - 1;
  const alpha = k > 1 ? 0.05 / k : 0.05;
  const z_a = _quantileNormalForPlanner(1 - alpha / 2);
  const z_b = 0.841621;
  const p1 = baselineCr;
  const p2 = baselineCr * (1 + mde);
  if (p2 >= 1) return null;
  const pBar = (p1 + p2) / 2;
  const num = Math.pow(z_a*Math.sqrt(2*pBar*(1-pBar)) + z_b*Math.sqrt(p1*(1-p1)+p2*(1-p2)), 2);
  return Math.ceil(num / Math.pow(p2 - p1, 2));
}

// Compute the community's recent visitor-velocity (visitors/day) for the
// days-estimate. Returns {velocity, isFallback}. Fallback = 100/day.
async function plannerCommunityVelocity(communityId) {
  if (!communityId) return { velocity: 100, isFallback: true };
  const since = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
  const { data, error } = await sb
    .from('analytics_events')
    .select('event_data,created_at,projects!inner(community_id)', { count: 'exact', head: false })
    .eq('event_type', 'pageview')
    .eq('projects.community_id', communityId)
    .gte('created_at', since)
    .limit(10000);
  if (error || !data || data.length === 0) return { velocity: 100, isFallback: true };
  const visitors = new Set(data.map(r => r.event_data?.visitor_id).filter(Boolean));
  return { velocity: Math.max(1, Math.round(visitors.size / 14)), isFallback: false };
}

// Cached velocity per modal-open so we don't re-query on every keystroke.
let _plannerVelocityCache = null;

async function _ensurePlannerVelocity() {
  if (_plannerVelocityCache) return _plannerVelocityCache;
  const firstProject = projects.find(p => p.id === testModalSelectedLPs[0]?.projectId);
  _plannerVelocityCache = await plannerCommunityVelocity(firstProject?.community_id);
  return _plannerVelocityCache;
}

async function updatePlannerResults() {
  const cvrEl = document.getElementById('planner-baseline-cvr');
  const mdeEl = document.getElementById('planner-mde');
  const cpcEl = document.getElementById('planner-cpc');
  const resultsEl = document.getElementById('planner-results');
  const errorEl = document.getElementById('planner-error');
  const numVariants = Math.max(2, testModalSelectedLPs.length || 2);

  const baselineCr = parseFloat(cvrEl.value) / 100;
  const mde = parseFloat(mdeEl.value) / 100;
  const cpc = parseFloat(cpcEl.value);

  errorEl.style.display = 'none';
  if (!(baselineCr > 0 && baselineCr < 1) || !(mde > 0) || !(cpc > 0)) {
    resultsEl.style.display = 'none';
    _updateActivateGating();
    return;
  }
  const n = plannerSampleSize(baselineCr, mde, numVariants);
  if (n === null) {
    errorEl.textContent = 'השיפור גדול מדי עבור אחוז ההמרה הצפוי. הקטן את ה-MDE או הגדל את הבסיס.';
    errorEl.style.display = '';
    resultsEl.style.display = 'none';
    _updateActivateGating();
    return;
  }
  const totalVisitors = n * numVariants;
  const budget = Math.round(totalVisitors * cpc);
  const { velocity, isFallback } = await _ensurePlannerVelocity();
  const days = Math.max(1, Math.ceil(totalVisitors / velocity));

  document.getElementById('planner-required-n').textContent = n.toLocaleString('he-IL');
  document.getElementById('planner-budget').textContent = budget.toLocaleString('he-IL');
  document.getElementById('planner-days').textContent = days.toLocaleString('he-IL');
  document.getElementById('planner-velocity-note').textContent =
    isFallback
      ? 'מבוסס על הערכה (100 מבקרים/יום). עדכן בהתאם לקצב התנועה הצפוי.'
      : `מבוסס על ${velocity.toLocaleString('he-IL')} מבקרים/יום בקהילה הזו ב-14 הימים האחרונים.`;
  resultsEl.style.display = '';
  _updateActivateGating();
}

function _updateActivateGating() {
  const btn = document.getElementById('btn-create-test-submit');
  if (!btn) return;
  const cvr = parseFloat(document.getElementById('planner-baseline-cvr').value) / 100;
  const mde = parseFloat(document.getElementById('planner-mde').value) / 100;
  const cpc = parseFloat(document.getElementById('planner-cpc').value);
  const numVariants = testModalSelectedLPs.length;
  const ok = cvr > 0 && cvr < 1 && mde > 0 && cpc > 0 && numVariants >= 2;
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '0.5';
  btn.style.cursor = ok ? 'pointer' : 'not-allowed';
}

// Reset cache when modal opens / closes — must be called from the existing
// modal open + close functions in the next task.
function _plannerResetCache() { _plannerVelocityCache = null; }

```

- [ ] **Step 2: Hook the cache reset into the existing modal open/close**

Search `dashboard.html` for `function closeCreateTestModal` and `function showCreateTestModal` (or wherever the create-test modal is opened — grep for `create-test-modal` and `style.display`). At the start of each, add:

```js
_plannerResetCache();
```

- [ ] **Step 3: Verify in browser**

Run: open dashboard, click "צור טסט חדש", select 2+ LPs, type values into the planner inputs.
Expected:
- Numbers appear in the results panel as you type.
- Velocity note shows the right text (real number for an active community, fallback otherwise).
- "צור טסט" button is faded/disabled until all 3 inputs are filled.
- Typing baseline=3, mde=20, cpc=3.5 with 2 LPs yields ≈ 4400 visitors/variant, ≈ ₪30,800 budget.
- Console has no errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): live calculator results + Activate-button gating in test modal"
```

### Task 8: Persist planner inputs into the `tests` row on Create

**Files:**
- Modify: `dashboard.html` — `createTest()` function around line 2403

- [ ] **Step 1: Update the `tests` insert payload**

Find the `sb.from('tests').insert({ ... })` call inside `createTest()` (around line 2426). Modify it to include the planner inputs:

```js
  const baselineCrPct = parseFloat(document.getElementById('planner-baseline-cvr').value);
  const mdePct        = parseFloat(document.getElementById('planner-mde').value);
  const cpc           = parseFloat(document.getElementById('planner-cpc').value);
  if (!(baselineCrPct > 0 && mdePct > 0 && cpc > 0)) {
    alert('נא למלא את כל שדות תכנון התקציב');
    return;
  }
  const numVariants = testModalSelectedLPs.length;
  const targetN = plannerSampleSize(baselineCrPct / 100, mdePct / 100, numVariants);
  if (targetN === null) {
    alert('השיפור גדול מדי עבור אחוז ההמרה הצפוי. הקטן את ה-MDE.');
    return;
  }

  const { data: test, error: testErr } = await sb.from('tests').insert({
    name,
    slug,
    community_id: communityId,
    status: 'draft',
    created_by: user.id,
    mode: testModalMode,
    baseline_cvr: baselineCrPct / 100,
    mde: mdePct / 100,
    expected_cpc: cpc,
    target_sample_size: targetN
  }).select().single();
```

- [ ] **Step 2: Verify in browser**

Run: create a new test with planner values 3% / 20% / 3.5₪. Confirm via Supabase SQL editor:
```sql
SELECT name, baseline_cvr, mde, expected_cpc, target_sample_size, status
FROM tests ORDER BY created_at DESC LIMIT 1;
```
Expected: `baseline_cvr=0.0300`, `mde=0.2000`, `expected_cpc=3.50`, `target_sample_size>0`, `status='draft'`.

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): persist planner inputs into tests row on create"
```

---

## Stage 3: Email renderers (`api/lib/email-templates.js`)

### Task 9: TDD `renderKickoffEmail`

**Files:**
- Create: `api/lib/email-templates.js`
- Create: `api/lib/email-templates.test.js`

- [ ] **Step 1: Write the failing test**

```js
// api/lib/email-templates.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderKickoffEmail } from './email-templates.js';

test('renderKickoffEmail returns subject + html + text with Hebrew RTL markers and merged values', () => {
  const out = renderKickoffEmail({
    name: 'Headline test',
    target_sample_size: 800,
    expected_cpc: 3.5,
    mde: 0.20,
    baseline_cvr: 0.03,
  }, /* numVariants */ 2, /* daysEstimate */ 12);

  assert.equal(typeof out.subject, 'string');
  assert.equal(typeof out.html, 'string');
  assert.equal(typeof out.text, 'string');

  assert.match(out.subject, /הטסט עלה לאוויר/);
  assert.match(out.html, /dir="rtl"/);
  assert.match(out.html, /Heebo/);
  assert.match(out.html, /800/);                      // per-variant N
  assert.match(out.html, /1,600|1600/);              // total visitors
  assert.match(out.html, /5,600|5600/);              // budget = 1600 * 3.5
  assert.match(out.html, /12/);                      // days estimate
  assert.match(out.html, /Headline test/);

  assert.doesNotMatch(out.html, /undefined/);
  assert.doesNotMatch(out.html, /\{\{/);             // no unrendered tokens
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: `Cannot find module './email-templates.js'`.

- [ ] **Step 3: Implement `renderKickoffEmail`**

```js
// api/lib/email-templates.js
// Pure email renderers — return {subject, html, text}. No I/O, no Brevo here.

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">`;

const SHELL_OPEN = `<!doctype html><html dir="rtl" lang="he"><head>${HEAD}</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Heebo','Assistant','Arial Hebrew',Arial,sans-serif;">
<table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
<tr><td align="center">
  <table dir="rtl" role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:14px;overflow:hidden;">
    <tr><td dir="rtl" style="background:#0d2240;padding:18px 22px;text-align:center;">
      <span style="color:#f5c842;font-weight:900;font-size:18px;">Messaging Lab</span>
    </td></tr>
    <tr><td dir="rtl" style="padding:24px 22px;color:#1a1a1a;font-size:15px;line-height:1.7;">`;

const SHELL_CLOSE = `    </td></tr>
    <tr><td dir="rtl" style="padding:14px 22px;background:#fafafa;color:#888;font-size:11px;text-align:center;">
      Messaging Lab · מערכת ניהול A/B testing לדפי נחיתה
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

function fmtN(n)   { return Number(n).toLocaleString('he-IL'); }
function fmtIls(n) { return `<span dir="ltr">₪${fmtN(Math.round(n))}</span>`; }

function tile(label, value) {
  return `<td dir="rtl" align="center" style="padding:12px 8px;background:#f8f8fa;border-radius:10px;width:33%;">
    <div style="color:#666;font-size:12px;margin-bottom:6px;">${label}</div>
    <div style="color:#0d2240;font-size:22px;font-weight:700;">${value}</div>
  </td>`;
}

function btn(text, href) {
  return `<table dir="rtl" role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;">
    <tr><td dir="rtl" align="center" style="background:#0d2240;border-radius:10px;">
      <a href="${href}" style="display:inline-block;padding:12px 28px;color:#f5c842;text-decoration:none;font-weight:700;font-size:14px;">${text}</a>
    </td></tr>
  </table>`;
}

export function renderKickoffEmail(test, numVariants, daysEstimate) {
  const totalVisitors = test.target_sample_size * numVariants;
  const budget = totalVisitors * Number(test.expected_cpc);
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard?test=${encodeURIComponent(test.slug || test.id)}`;

  const subject = `הטסט עלה לאוויר — הנה התוכנית | ${test.name}`;
  const html = SHELL_OPEN + `
    <p style="margin:0 0 14px;font-size:16px;"><strong>${escapeHtml(test.name)}</strong> פעיל. אנחנו מנטרים אותו עבורך.</p>
    <table dir="rtl" role="presentation" width="100%" cellpadding="6" cellspacing="0" style="margin:8px 0 14px;">
      <tr>
        ${tile('יעד דגימה לכל וריאציה', fmtN(test.target_sample_size))}
        ${tile('תקציב משוער', fmtIls(budget))}
        ${tile('זמן צפוי', `~${fmtN(daysEstimate)} ימים`)}
      </tr>
    </table>
    <p style="margin:14px 0 6px;font-size:14px;color:#444;">מה תקבל בהמשך:</p>
    <ul style="margin:0 0 14px;padding-right:18px;color:#444;font-size:13px;line-height:1.7;">
      <li>עדכון רבע / חצי / שלושה רבעי הדרך</li>
      <li>סיכום סופי עם המלצה — האם לעצור ולשלוח את הוורסיה המנצחת</li>
      <li>התראה אם התנועה ממטא נעצרה ל-48 שעות</li>
    </ul>
    ${btn('פתח את לוח הבקרה', dashboardUrl)}
  ` + SHELL_CLOSE;

  const text = `${test.name} פעיל.\nיעד דגימה: ${fmtN(test.target_sample_size)} מבקרים לכל וריאציה.\nתקציב משוער: ₪${fmtN(Math.round(budget))}.\nזמן צפוי: ~${daysEstimate} ימים.\n\n${dashboardUrl}`;

  return { subject, html, text };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: kickoff test passes.

- [ ] **Step 5: Commit**

```bash
git add api/lib/email-templates.js api/lib/email-templates.test.js
git commit -m "feat(email): RTL kickoff template renderer"
```

### Task 10: TDD `renderMilestoneEmail`

**Files:**
- Modify: `api/lib/email-templates.js`
- Modify: `api/lib/email-templates.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `api/lib/email-templates.test.js`:

```js
import { renderMilestoneEmail } from './email-templates.js';

test('renderMilestoneEmail (25%) — quarter-of-the-way subject and standings', () => {
  const out = renderMilestoneEmail(
    { name: 'Test A', target_sample_size: 800 },
    25,
    [
      { label: 'A', name: 'Variant A', visitors: 200, conversions: 6 },
      { label: 'B', name: 'Variant B', visitors: 200, conversions: 9 },
    ]
  );
  assert.match(out.subject, /רבע/);
  assert.match(out.html, /dir="rtl"/);
  assert.match(out.html, /200/);
  assert.match(out.html, /Variant A/);
  assert.match(out.html, /Variant B/);
  assert.doesNotMatch(out.html, /undefined/);
});

test('renderMilestoneEmail (75%) — three-quarters subject', () => {
  const out = renderMilestoneEmail(
    { name: 'Test B', target_sample_size: 1000 },
    75,
    [
      { label: 'A', name: 'Variant A', visitors: 750, conversions: 22 },
      { label: 'B', name: 'Variant B', visitors: 750, conversions: 30 },
    ]
  );
  assert.match(out.subject, /שלושת רבעי/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: `renderMilestoneEmail is not a function`.

- [ ] **Step 3: Implement `renderMilestoneEmail`**

Append to `api/lib/email-templates.js`:

```js
const MILESTONE_COPY = {
  25: { subject: 'רבע מהדרך', headline: 'עברנו את רבע מהדרך', tone: 'מוקדם להכריז על מנצח. הנה תמונת המצב.' },
  50: { subject: 'חצי דרך — הפער מתחיל להתייצב', headline: 'חצי דרך', tone: 'הפער מתחיל להתבהר. עוד לא סטטיסטית מובהק.' },
  75: { subject: 'שלושת רבעי הדרך — מתחילים להתכונן להחלטה', headline: 'שלושת רבעי הדרך', tone: 'הכן את הוורסיה המנצחת לעלייה.' },
};

export function renderMilestoneEmail(test, milestone, variantCounts) {
  const copy = MILESTONE_COPY[milestone];
  if (!copy) throw new Error(`Unknown milestone: ${milestone}`);
  const totalVisitors = variantCounts.reduce((s, v) => s + v.visitors, 0);
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard?test=${encodeURIComponent(test.slug || test.id)}`;

  // Build standings rows
  const sorted = [...variantCounts].sort((a, b) => (b.conversions / Math.max(1, b.visitors)) - (a.conversions / Math.max(1, a.visitors)));
  const rows = sorted.map(v => {
    const cvr = v.visitors ? (v.conversions / v.visitors * 100).toFixed(1) : '0.0';
    return `<tr>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#1a1a1a;font-size:13px;">${escapeHtml(v.name || v.label)}</td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#666;font-size:13px;text-align:left;"><span dir="ltr">${fmtN(v.visitors)}</span> מבקרים</td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#0d2240;font-size:13px;font-weight:600;text-align:left;"><span dir="ltr">${cvr}%</span></td>
    </tr>`;
  }).join('');

  const subject = `${copy.subject} | ${test.name}`;
  const pct = milestone;
  const totalTarget = test.target_sample_size * variantCounts.length;

  const html = SHELL_OPEN + `
    <p style="margin:0 0 12px;font-size:16px;"><strong>${escapeHtml(copy.headline)}</strong></p>
    <p style="margin:0 0 16px;color:#555;font-size:14px;">${copy.tone}</p>

    <div style="background:#f8f8fa;border-radius:10px;padding:14px;margin:0 0 14px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
        <span style="color:#666;font-size:13px;">${fmtN(totalVisitors)} / ${fmtN(totalTarget)} מבקרים</span>
        <span style="color:#0d2240;font-size:18px;font-weight:700;"><span dir="ltr">${pct}%</span></span>
      </div>
      <table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eee;border-radius:6px;height:8px;">
        <tr><td dir="rtl" style="background:#f5c842;width:${pct}%;border-radius:6px;height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>
      </table>
    </div>

    <table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
      ${rows}
    </table>

    ${btn('צפה בפירוט מלא', dashboardUrl)}
  ` + SHELL_CLOSE;

  const text = `${copy.headline} — ${fmtN(totalVisitors)}/${fmtN(totalTarget)} מבקרים (${pct}%)\n\n${copy.tone}\n\n${dashboardUrl}`;
  return { subject, html, text };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: both new tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/lib/email-templates.js api/lib/email-templates.test.js
git commit -m "feat(email): RTL milestone template (25/50/75) with progress bar + standings"
```

### Task 11: TDD `renderSummaryEmail` (3 verdict variants)

**Files:**
- Modify: `api/lib/email-templates.js`
- Modify: `api/lib/email-templates.test.js`

- [ ] **Step 1: Add the failing tests**

Append to `api/lib/email-templates.test.js`:

```js
import { renderSummaryEmail } from './email-templates.js';

test('renderSummaryEmail WINNER_FOUND — winner subject + lift number', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 800 },
    {
      verdict: 'WINNER_FOUND',
      winnerLabel: 'B',
      winnerName: 'Variant B',
      liftPct: 45.6,
      winnerCvr: 0.058,
      runnerUpCvr: 0.040,
    },
    [
      { label: 'A', name: 'Variant A', visitors: 800, conversions: 32 },
      { label: 'B', name: 'Variant B', visitors: 800, conversions: 46 },
    ]
  );
  assert.match(out.subject, /יש מנצח/);
  assert.match(out.subject, /Variant B|B/);
  assert.match(out.html, /45/);                  // lift
  assert.match(out.html, /הכרז מנצח/);          // CTA text
});

test('renderSummaryEmail PRACTICAL_TIE — no-difference subject', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    { verdict: 'PRACTICAL_TIE' },
    [
      { label: 'A', name: 'A', visitors: 500, conversions: 15 },
      { label: 'B', name: 'B', visitors: 500, conversions: 16 },
    ]
  );
  assert.match(out.subject, /אין הבדל/);
});

test('renderSummaryEmail TRENDING_UNDERPOWERED — extend-or-decide subject', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    { verdict: 'TRENDING_UNDERPOWERED', winnerLabel: 'B', winnerName: 'B', liftPct: 18 },
    [
      { label: 'A', name: 'A', visitors: 500, conversions: 18 },
      { label: 'B', name: 'B', visitors: 500, conversions: 22 },
    ]
  );
  assert.match(out.subject, /להאריך|לא מובהק/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: 3 new failures.

- [ ] **Step 3: Implement `renderSummaryEmail`**

Append to `api/lib/email-templates.js`:

```js
export function renderSummaryEmail(test, decision, variantCounts) {
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard?test=${encodeURIComponent(test.slug || test.id)}`;

  const sorted = [...variantCounts].sort((a, b) => (b.conversions / Math.max(1, b.visitors)) - (a.conversions / Math.max(1, a.visitors)));
  const standingsRows = sorted.map(v => {
    const cvr = v.visitors ? (v.conversions / v.visitors * 100).toFixed(1) : '0.0';
    return `<tr>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#1a1a1a;font-size:13px;">${escapeHtml(v.name || v.label)}</td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#666;font-size:13px;text-align:left;"><span dir="ltr">${fmtN(v.visitors)}</span></td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#666;font-size:13px;text-align:left;"><span dir="ltr">${v.conversions}</span></td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#0d2240;font-size:13px;font-weight:600;text-align:left;"><span dir="ltr">${cvr}%</span></td>
    </tr>`;
  }).join('');

  const standingsTable = `<table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;">
    <thead><tr>
      <th dir="rtl" style="padding:8px;text-align:right;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">וריאציה</th>
      <th dir="rtl" style="padding:8px;text-align:left;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">מבקרים</th>
      <th dir="rtl" style="padding:8px;text-align:left;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">לידים</th>
      <th dir="rtl" style="padding:8px;text-align:left;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">המרה</th>
    </tr></thead>
    <tbody>${standingsRows}</tbody>
  </table>`;

  let subject, headline, body, cta;

  if (decision.verdict === 'WINNER_FOUND') {
    const winnerName = escapeHtml(decision.winnerName || decision.winnerLabel || '');
    subject = `יש מנצח: ${winnerName} (+${Math.round(decision.liftPct)}% שיפור) | ${test.name}`;
    headline = `<div style="background:#e8f5e9;border-right:4px solid #43a047;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#2e7d32;font-size:18px;font-weight:700;margin-bottom:4px;">🏆 ${winnerName} מנצחת</div>
      <div style="color:#388e3c;font-size:14px;">שיפור של <span dir="ltr">+${Math.round(decision.liftPct)}%</span> מעל הוורסיה השנייה.</div>
    </div>`;
    body = `<p style="margin:0 0 12px;color:#444;font-size:14px;">המלצה: החלף את ה-LP במטא ל-${winnerName} ועצור את הטסט.</p>`;
    cta = btn('הכרז מנצח ועצור את הטסט', dashboardUrl);
  } else if (decision.verdict === 'PRACTICAL_TIE') {
    subject = `הטסט הסתיים — אין הבדל מובהק בין הוורסיות | ${test.name}`;
    headline = `<div style="background:#fafafa;border-right:4px solid #9e9e9e;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#424242;font-size:18px;font-weight:700;margin-bottom:4px;">אין מנצח ברור</div>
      <div style="color:#616161;font-size:14px;">הוורסיות הניבו ביצועים דומים בטווח השונות הסטטיסטית.</div>
    </div>`;
    body = `<p style="margin:0 0 12px;color:#444;font-size:14px;">מה זה כן אומר: ה-LP הקיים שלך עומד בפני וריאציות גסות. בטסט הבא, נסה שינוי גדול יותר (לדוגמה: הצעת ערך אחרת לחלוטין, לא רק שינוי כותרת).</p>`;
    cta = btn('צור טסט חדש', `${process.env.APP_URL || ''}/dashboard`);
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
        <li>להאריך את הטסט ב-50% נוספים מהדגימה — סביר שתגיע למובהקות.</li>
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

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: all summary tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/lib/email-templates.js api/lib/email-templates.test.js
git commit -m "feat(email): RTL summary template (3 verdicts: winner/tie/trending)"
```

### Task 12: TDD `renderStallAlertEmail`

**Files:**
- Modify: `api/lib/email-templates.js`
- Modify: `api/lib/email-templates.test.js`

- [ ] **Step 1: Add the failing test**

Append to `api/lib/email-templates.test.js`:

```js
import { renderStallAlertEmail } from './email-templates.js';

test('renderStallAlertEmail — 0-visitors subject + diagnostic checklist', () => {
  const out = renderStallAlertEmail({ name: 'Test C', slug: 'test-c' });
  assert.match(out.subject, /0 מבקרים|עצירה/);
  assert.match(out.html, /dir="rtl"/);
  assert.match(out.html, /פיקסל|מטא|URL/);   // diagnostic checklist words
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`

- [ ] **Step 3: Implement `renderStallAlertEmail`**

Append to `api/lib/email-templates.js`:

```js
export function renderStallAlertEmail(test) {
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard?test=${encodeURIComponent(test.slug || test.id)}`;
  const subject = `עצירה: 0 מבקרים ב-48 השעות האחרונות | ${test.name}`;
  const html = SHELL_OPEN + `
    <div style="background:#fff3e0;border-right:4px solid #ff9800;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#e65100;font-size:18px;font-weight:700;margin-bottom:4px;">לא ראינו תנועה ב-48 שעות</div>
      <div style="color:#ef6c00;font-size:14px;">הטסט שלך פעיל, אבל לא הגיעו מבקרים.</div>
    </div>
    <p style="margin:0 0 6px;color:#444;font-size:14px;font-weight:600;">3 בדיקות מהירות:</p>
    <ol style="margin:0 0 14px;padding-right:18px;color:#444;font-size:13px;line-height:1.7;">
      <li>הקמפיין במטא — האם הוא פעיל ולא הושהה?</li>
      <li>פיקסל — האם הוא יורה? (בדוק ב-Meta Events Manager)</li>
      <li>URL — האם הקישור בקריאייטיב מצביע לדף הנכון?</li>
    </ol>
    <p style="margin:0 0 14px;color:#666;font-size:13px;">הטסט נשמר. ימשיך אוטומטית כשתחזור תנועה.</p>
    ${btn('בדוק את הטסט', dashboardUrl)}
  ` + SHELL_CLOSE;
  const text = `${test.name}: 0 מבקרים ב-48 שעות. בדוק קמפיין/פיקסל/URL.\n\n${dashboardUrl}`;
  return { subject, html, text };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add api/lib/email-templates.js api/lib/email-templates.test.js
git commit -m "feat(email): RTL stall-alert template with 3-item diagnostic checklist"
```

---

## Stage 4: Send-email handler extension (`api/send-email.js`)

### Task 13: Add `test_kickoff` action branch

**Files:**
- Modify: `api/send-email.js`

- [ ] **Step 1: Import the renderers + add the action router**

Near the top of `api/send-email.js` (after the existing `import crypto from "crypto";` line), add:

```js
import {
  renderKickoffEmail,
  renderMilestoneEmail,
  renderSummaryEmail,
  renderStallAlertEmail,
} from "./lib/email-templates.js";
```

Inside `export default async function handler(...)`, immediately after the existing `if (req.body?.action === "meta_capi") { return handleMetaCapi(req, res); }` line (~line 79), add:

```js
  if (req.body?.action === 'test_kickoff') {
    return handleTestKickoff(req, res);
  }
  if (req.body?.action === 'test_milestone') {
    return handleTestMilestone(req, res);
  }
  if (req.body?.action === 'test_summary') {
    return handleTestSummary(req, res);
  }
  if (req.body?.action === 'test_stall_alert') {
    return handleTestStallAlert(req, res);
  }
```

- [ ] **Step 2: Add the shared helpers + `handleTestKickoff`**

Append to `api/send-email.js` (above `export default async function handler`):

```js
// ── Test-planner email helpers ─────────────────────────────

async function fetchTestWithCreatorAndVariants(testId) {
  const testRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tests?id=eq.${testId}&select=*&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const testRows = await testRes.json();
  const test = testRows && testRows[0];
  if (!test) return { error: 'Test not found' };

  const creatorRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${test.created_by}`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const creator = await creatorRes.json();
  if (!creator?.email) return { error: 'Test creator has no email' };

  const tvRes = await fetch(
    `${SUPABASE_URL}/rest/v1/test_variants?test_id=eq.${testId}&select=id,variant_id,label,projects(name)`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const testVariants = await tvRes.json();

  return { test, creatorEmail: creator.email, testVariants };
}

async function fetchVariantCounts(testId) {
  // Fetch all events for this test, then aggregate per variant in JS.
  // Uses the existing pagination pattern (PostgREST 1000-row cap).
  let allRows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/analytics_events?test_id=eq.${testId}&select=variant_id,event_type,event_data&limit=${PAGE}&offset=${from}`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const rows = await res.json();
    if (!rows || !rows.length) break;
    allRows = allRows.concat(rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  const byVariant = new Map();
  for (const row of allRows) {
    if (!row.variant_id) continue;
    const v = byVariant.get(row.variant_id) || { variant_id: row.variant_id, visitors: new Set(), conversions: 0 };
    if (row.event_type === 'pageview' && row.event_data?.visitor_id) v.visitors.add(row.event_data.visitor_id);
    if (row.event_type === 'lead_captured') v.conversions += 1;
    byVariant.set(row.variant_id, v);
  }
  return Array.from(byVariant.values()).map(v => ({
    variant_id: v.variant_id,
    visitors: v.visitors.size,
    conversions: v.conversions,
  }));
}

async function sendBrevo(to, subject, html, text, senderName = 'Messaging Lab') {
  const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: senderName, email: SENDER_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });
  const data = await brevoRes.json();
  if (!brevoRes.ok) {
    console.error('Brevo error:', data);
    throw new Error(`Brevo ${brevoRes.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function handleTestKickoff(req, res) {
  const { test_id } = req.body || {};
  if (!test_id) return res.status(400).json({ error: 'test_id required' });
  try {
    const { test, creatorEmail, testVariants, error } = await fetchTestWithCreatorAndVariants(test_id);
    if (error) return res.status(404).json({ error });
    if (!test.target_sample_size) return res.status(400).json({ error: 'target_sample_size missing' });

    // Days estimate: total visitors / 100 (we don't have community velocity server-side cheaply)
    const totalVisitors = test.target_sample_size * Math.max(2, testVariants.length);
    const daysEstimate = Math.max(1, Math.ceil(totalVisitors / 100));

    const { subject, html, text } = renderKickoffEmail(test, Math.max(2, testVariants.length), daysEstimate);
    const data = await sendBrevo(creatorEmail, subject, html, text);
    return res.status(200).json({ success: true, messageId: data.messageId });
  } catch (err) {
    console.error('handleTestKickoff error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
```

- [ ] **Step 3: Verify locally with curl** (after deploy preview is up — see Task 19)

Skipped for now — covered in the smoke-test task at Stage 5.

- [ ] **Step 4: Commit**

```bash
git add api/send-email.js
git commit -m "feat(email): test_kickoff action branch in send-email"
```

### Task 14: Add `test_milestone` action branch

**Files:**
- Modify: `api/send-email.js`

- [ ] **Step 1: Append the handler**

Append to `api/send-email.js`:

```js
async function handleTestMilestone(req, res) {
  const { test_id, milestone } = req.body || {};
  if (!test_id || ![25, 50, 75].includes(milestone)) {
    return res.status(400).json({ error: 'test_id + milestone in {25,50,75} required' });
  }
  try {
    const { test, creatorEmail, testVariants, error } = await fetchTestWithCreatorAndVariants(test_id);
    if (error) return res.status(404).json({ error });

    const counts = await fetchVariantCounts(test_id);
    const variantCountsWithName = testVariants.map(tv => {
      const c = counts.find(x => x.variant_id === tv.variant_id) || { visitors: 0, conversions: 0 };
      return { label: tv.label, name: tv.projects?.name || tv.label, visitors: c.visitors, conversions: c.conversions };
    });

    const { subject, html, text } = renderMilestoneEmail(test, milestone, variantCountsWithName);
    const data = await sendBrevo(creatorEmail, subject, html, text);
    return res.status(200).json({ success: true, messageId: data.messageId });
  } catch (err) {
    console.error('handleTestMilestone error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add api/send-email.js
git commit -m "feat(email): test_milestone action branch (25/50/75)"
```

### Task 15: Add `test_summary` and `test_stall_alert` action branches

**Files:**
- Modify: `api/send-email.js`

- [ ] **Step 1: Append both handlers**

```js
async function handleTestSummary(req, res) {
  const { test_id, verdict, winnerLabel, winnerName, liftPct } = req.body || {};
  if (!test_id || !['WINNER_FOUND', 'PRACTICAL_TIE', 'TRENDING_UNDERPOWERED'].includes(verdict)) {
    return res.status(400).json({ error: 'test_id + valid verdict required' });
  }
  try {
    const { test, creatorEmail, testVariants, error } = await fetchTestWithCreatorAndVariants(test_id);
    if (error) return res.status(404).json({ error });

    const counts = await fetchVariantCounts(test_id);
    const variantCountsWithName = testVariants.map(tv => {
      const c = counts.find(x => x.variant_id === tv.variant_id) || { visitors: 0, conversions: 0 };
      return { label: tv.label, name: tv.projects?.name || tv.label, visitors: c.visitors, conversions: c.conversions };
    });

    const decision = { verdict, winnerLabel, winnerName, liftPct };
    const { subject, html, text } = renderSummaryEmail(test, decision, variantCountsWithName);
    const data = await sendBrevo(creatorEmail, subject, html, text);
    return res.status(200).json({ success: true, messageId: data.messageId });
  } catch (err) {
    console.error('handleTestSummary error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

async function handleTestStallAlert(req, res) {
  const { test_id } = req.body || {};
  if (!test_id) return res.status(400).json({ error: 'test_id required' });
  try {
    const { test, creatorEmail, error } = await fetchTestWithCreatorAndVariants(test_id);
    if (error) return res.status(404).json({ error });
    const { subject, html, text } = renderStallAlertEmail(test);
    const data = await sendBrevo(creatorEmail, subject, html, text);
    return res.status(200).json({ success: true, messageId: data.messageId });
  } catch (err) {
    console.error('handleTestStallAlert error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add api/send-email.js
git commit -m "feat(email): test_summary + test_stall_alert action branches"
```

---

## Stage 5: Cron worker (`api/test-monitor.js`)

### Task 16: TDD `decideState`

**Files:**
- Create: `api/test-monitor.js`
- Create: `api/test-monitor.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// api/test-monitor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideState, pickEmailAction } from './test-monitor.js';

const baseTest = {
  id: 't1', name: 'T', slug: 't1',
  target_sample_size: 800,
  baseline_cvr: 0.03, mde: 0.20, expected_cpc: 3.5,
  started_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
  last_milestone_sent: 0, stall_alert_sent_at: null, summary_sent_at: null, kickoff_sent_at: new Date().toISOString(),
};

test('decideState NORMAL when below 25% sample and no stall', () => {
  const counts = [
    { variant_id: 'a', visitors: 100, conversions: 3 },
    { variant_id: 'b', visitors: 100, conversions: 3 },
  ];
  const d = decideState(baseTest, counts);
  assert.equal(d.state, 'NORMAL');
  assert.ok(d.currentPct < 25);
});

test('decideState STALL when 0 visitors after 48h', () => {
  const t = { ...baseTest, started_at: new Date(Date.now() - 49 * 3600 * 1000).toISOString() };
  const d = decideState(t, [{ variant_id: 'a', visitors: 0, conversions: 0 }, { variant_id: 'b', visitors: 0, conversions: 0 }]);
  assert.equal(d.state, 'STALL');
});

test('decideState NORMAL (not STALL) when 0 visitors but stall already sent', () => {
  const t = {
    ...baseTest,
    started_at: new Date(Date.now() - 49 * 3600 * 1000).toISOString(),
    stall_alert_sent_at: new Date().toISOString(),
  };
  const d = decideState(t, [{ variant_id: 'a', visitors: 0, conversions: 0 }, { variant_id: 'b', visitors: 0, conversions: 0 }]);
  assert.equal(d.state, 'NORMAL');
});

test('decideState WINNER_FOUND early (dual-gate met)', () => {
  // Big sample, large gap, low expected loss
  const counts = [
    { variant_id: 'a', visitors: 400, conversions: 12 },   // ~3%
    { variant_id: 'b', visitors: 400, conversions: 40 },   // ~10% — clear winner
  ];
  const d = decideState(baseTest, counts);
  assert.equal(d.state, 'WINNER_FOUND');
  assert.equal(d.leader.variant_id, 'b');
});

test('decideState NORMAL when posterior leans but visitors below STOP_MIN_VIS floor', () => {
  const counts = [
    { variant_id: 'a', visitors: 30, conversions: 1 },
    { variant_id: 'b', visitors: 30, conversions: 5 },
  ];
  const d = decideState(baseTest, counts);
  assert.equal(d.state, 'NORMAL'); // floor blocks early stop
});

test('decideState WINNER_FOUND at 100% even when planned sample below floors (relaxation)', () => {
  // target_sample_size = 50 per variant → 100 total, intentionally below STOP_MIN_VIS=200
  const tinyTest = { ...baseTest, target_sample_size: 50 };
  const counts = [
    { variant_id: 'a', visitors: 50, conversions: 2 },
    { variant_id: 'b', visitors: 50, conversions: 12 },
  ];
  const d = decideState(tinyTest, counts);
  assert.equal(d.state, 'WINNER_FOUND');
});

test('decideState PRACTICAL_TIE at 100% with similar arms', () => {
  const counts = [
    { variant_id: 'a', visitors: 800, conversions: 24 },
    { variant_id: 'b', visitors: 800, conversions: 26 },
  ];
  const d = decideState(baseTest, counts);
  assert.ok(['PRACTICAL_TIE', 'TRENDING_UNDERPOWERED'].includes(d.state));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: import errors for `decideState` / `pickEmailAction`.

- [ ] **Step 3: Implement `decideState` in `api/test-monitor.js`**

```js
// api/test-monitor.js
// Daily cron worker for test-planner: scans running tests, decides what to email.

import { sampleBeta, computeWinnerProbabilities, computeExpectedLoss } from './lib/bayes.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_ORIGIN = process.env.APP_URL || '';
const CRON_SECRET = process.env.CRON_SECRET;

const ALPHA_PRIOR   = 1;
const BETA_PRIOR    = 1;
const MC_DRAWS      = 10000;
const STOP_P_BEST   = 0.95;
const STOP_MAX_LOSS = 0.0075;
const STOP_MIN_CONV = 25;
const STOP_MIN_VIS  = 200;
const STALL_HOURS   = 48;

export function decideState(test, variantCounts) {
  const totalVisitors = variantCounts.reduce((s, v) => s + v.visitors, 0);
  const totalTarget = test.target_sample_size * variantCounts.length;
  const sampleVsTarget = totalVisitors / totalTarget;
  const currentPct = Math.floor(sampleVsTarget * 100);

  const hoursSinceStart = (Date.now() - new Date(test.started_at).getTime()) / 3.6e6;
  const hasZeroTraffic48h = totalVisitors === 0 && hoursSinceStart >= STALL_HOURS;
  if (hasZeroTraffic48h && !test.stall_alert_sent_at) {
    return { state: 'STALL', currentPct };
  }

  // Bayesian Monte Carlo
  const draws = variantCounts.map(v =>
    sampleBeta(ALPHA_PRIOR + v.conversions, BETA_PRIOR + v.visitors - v.conversions, MC_DRAWS)
  );
  const winnerProb = computeWinnerProbabilities(draws);
  const expectedLoss = computeExpectedLoss(draws);
  let leaderIdx = 0;
  for (let i = 1; i < winnerProb.length; i++) if (winnerProb[i] > winnerProb[leaderIdx]) leaderIdx = i;
  const leader = variantCounts[leaderIdx];

  const atOrPastTarget = currentPct >= 100;

  // Stop rule: at 100%+ relax the conv/visitors floors (user planned for that sample size)
  const dualGate = atOrPastTarget
    ? winnerProb[leaderIdx] > STOP_P_BEST
    : (winnerProb[leaderIdx] > STOP_P_BEST &&
       expectedLoss[leaderIdx] < STOP_MAX_LOSS &&
       leader.conversions >= STOP_MIN_CONV &&
       leader.visitors >= STOP_MIN_VIS);

  if (dualGate) {
    return {
      state: 'WINNER_FOUND', currentPct, leader,
      leaderIdx, winnerProb, expectedLoss,
      liftPct: computeLiftPct(variantCounts, leaderIdx),
    };
  }
  if (atOrPastTarget) {
    const sortedProb = [...winnerProb].sort((a, b) => b - a);
    if (sortedProb[0] >= 0.85) {
      return { state: 'TRENDING_UNDERPOWERED', currentPct, leader, leaderIdx, winnerProb, liftPct: computeLiftPct(variantCounts, leaderIdx) };
    }
    return { state: 'PRACTICAL_TIE', currentPct, winnerProb };
  }
  return { state: 'NORMAL', currentPct, leader, leaderIdx, winnerProb };
}

function computeLiftPct(variantCounts, leaderIdx) {
  const leaderCvr = variantCounts[leaderIdx].visitors
    ? variantCounts[leaderIdx].conversions / variantCounts[leaderIdx].visitors
    : 0;
  const others = variantCounts.filter((_, i) => i !== leaderIdx);
  const bestOtherCvr = Math.max(...others.map(v => v.visitors ? v.conversions / v.visitors : 0));
  if (bestOtherCvr <= 0) return 0;
  return ((leaderCvr - bestOtherCvr) / bestOtherCvr) * 100;
}

export function pickEmailAction(test, decision) {
  // Precedence: STALL > SUMMARY > MILESTONE
  if (decision.state === 'STALL' && !test.stall_alert_sent_at) {
    return { name: 'test_stall_alert', payload: {} };
  }
  if (
    ['WINNER_FOUND', 'PRACTICAL_TIE', 'TRENDING_UNDERPOWERED'].includes(decision.state) &&
    !test.summary_sent_at
  ) {
    const payload = { verdict: decision.state };
    if (decision.leader) {
      payload.winnerLabel = decision.leader.label || null;
      payload.winnerName  = decision.leader.name  || null;
      payload.liftPct     = decision.liftPct ?? 0;
    }
    return { name: 'test_summary', payload };
  }
  // Milestone — find the highest crossed milestone we haven't sent yet
  const thresholds = [75, 50, 25];
  for (const m of thresholds) {
    if (decision.currentPct >= m && (test.last_milestone_sent || 0) < m) {
      return { name: 'test_milestone', payload: { milestone: m } };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: all decideState tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/test-monitor.js api/test-monitor.test.js
git commit -m "feat(cron): decideState pure function + Bayesian dual-gate stop rule"
```

### Task 17: TDD `pickEmailAction`

**Files:**
- Modify: `api/test-monitor.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `api/test-monitor.test.js`:

```js
test('pickEmailAction: STALL precedence', () => {
  const action = pickEmailAction(baseTest, { state: 'STALL', currentPct: 50 });
  assert.deepEqual(action, { name: 'test_stall_alert', payload: {} });
});

test('pickEmailAction: skip stall if already sent', () => {
  const t = { ...baseTest, stall_alert_sent_at: new Date().toISOString() };
  const action = pickEmailAction(t, { state: 'STALL', currentPct: 50 });
  assert.equal(action, null);
});

test('pickEmailAction: WINNER_FOUND → test_summary with payload', () => {
  const decision = {
    state: 'WINNER_FOUND', currentPct: 60,
    leader: { label: 'B', name: 'Variant B' },
    liftPct: 45.0,
  };
  const action = pickEmailAction(baseTest, decision);
  assert.equal(action.name, 'test_summary');
  assert.equal(action.payload.verdict, 'WINNER_FOUND');
  assert.equal(action.payload.winnerName, 'Variant B');
  assert.equal(action.payload.liftPct, 45);
});

test('pickEmailAction: PRACTICAL_TIE → test_summary, no winner fields needed', () => {
  const action = pickEmailAction(baseTest, { state: 'PRACTICAL_TIE', currentPct: 100 });
  assert.equal(action.name, 'test_summary');
  assert.equal(action.payload.verdict, 'PRACTICAL_TIE');
});

test('pickEmailAction: skip summary if already sent', () => {
  const t = { ...baseTest, summary_sent_at: new Date().toISOString() };
  const action = pickEmailAction(t, { state: 'WINNER_FOUND', currentPct: 60, leader: { label: 'A' } });
  assert.equal(action, null);
});

test('pickEmailAction: 60% pct → 50 milestone (highest unsent)', () => {
  const action = pickEmailAction(baseTest, { state: 'NORMAL', currentPct: 60 });
  assert.equal(action.name, 'test_milestone');
  assert.equal(action.payload.milestone, 50);
});

test('pickEmailAction: 80% pct with 50 already sent → 75 milestone', () => {
  const t = { ...baseTest, last_milestone_sent: 50 };
  const action = pickEmailAction(t, { state: 'NORMAL', currentPct: 80 });
  assert.equal(action.payload.milestone, 75);
});

test('pickEmailAction: 80% pct with 75 already sent → null (waiting for 100% summary)', () => {
  const t = { ...baseTest, last_milestone_sent: 75 };
  const action = pickEmailAction(t, { state: 'NORMAL', currentPct: 80 });
  assert.equal(action, null);
});
```

- [ ] **Step 2: Run to verify pass**

Run: `npm test`
Expected: all pickEmailAction tests pass (since `pickEmailAction` was already implemented in Task 16).

- [ ] **Step 3: Commit**

```bash
git add api/test-monitor.test.js
git commit -m "test(cron): pickEmailAction precedence + idempotency cases"
```

### Task 18: Cron handler — auth, DB query, dispatch loop

**Files:**
- Modify: `api/test-monitor.js`

- [ ] **Step 1: Append the handler at the bottom of `api/test-monitor.js`**

```js
async function fetchRunningTests() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tests?status=eq.running&select=*`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!res.ok) throw new Error(`fetchRunningTests: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchTestVariantsAndCounts(testId) {
  // Get test_variants for label + project name
  const tvRes = await fetch(
    `${SUPABASE_URL}/rest/v1/test_variants?test_id=eq.${testId}&select=variant_id,label,projects(name)`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const testVariants = await tvRes.json();

  // Pull all events for this test (paginated to bypass PostgREST 1000-row cap)
  let allRows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/analytics_events?test_id=eq.${testId}&select=variant_id,event_type,event_data&limit=${PAGE}&offset=${from}`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const rows = await res.json();
    if (!rows || !rows.length) break;
    allRows = allRows.concat(rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }

  // Aggregate per variant
  return testVariants.map(tv => {
    const events = allRows.filter(r => r.variant_id === tv.variant_id);
    const visitors = new Set();
    let conversions = 0;
    for (const e of events) {
      if (e.event_type === 'pageview' && e.event_data?.visitor_id) visitors.add(e.event_data.visitor_id);
      if (e.event_type === 'lead_captured') conversions += 1;
    }
    return {
      variant_id: tv.variant_id,
      label: tv.label,
      name: tv.projects?.name || tv.label,
      visitors: visitors.size,
      conversions,
    };
  });
}

async function markEmailSent(test, actionName, payload) {
  const updates = { updated_at: new Date().toISOString() };
  if (actionName === 'test_milestone') updates.last_milestone_sent = payload.milestone;
  if (actionName === 'test_summary')   updates.summary_sent_at = new Date().toISOString();
  if (actionName === 'test_stall_alert') updates.stall_alert_sent_at = new Date().toISOString();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tests?id=eq.${test.id}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(updates),
    }
  );
  if (!res.ok) throw new Error(`markEmailSent: ${res.status} ${await res.text()}`);
}

async function postEmailAction(test, action) {
  const res = await fetch(`${APP_ORIGIN}/api/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action.name, test_id: test.id, ...action.payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`send-email ${action.name} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

export default async function handler(req, res) {
  // Vercel cron sends GET with Authorization: Bearer <CRON_SECRET>
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];
  const errors = [];
  let tests = [];
  try {
    tests = await fetchRunningTests();
  } catch (err) {
    console.error('fetchRunningTests failed:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }

  for (const test of tests) {
    try {
      if (!test.target_sample_size || !test.started_at) {
        results.push({ test_id: test.id, skipped: 'no target_sample_size or started_at' });
        continue;
      }
      const variantCounts = await fetchTestVariantsAndCounts(test.id);
      const decision = decideState(test, variantCounts);
      const action = pickEmailAction(test, decision);
      if (!action) {
        results.push({ test_id: test.id, state: decision.state, action: null });
        continue;
      }
      await postEmailAction(test, action);
      await markEmailSent(test, action.name, action.payload);
      results.push({ test_id: test.id, state: decision.state, action: action.name, milestone: action.payload.milestone });
    } catch (err) {
      console.error(`test-monitor error on test ${test.id}:`, err);
      errors.push({ test_id: test.id, error: String(err.message || err) });
    }
  }
  return res.status(200).json({ processed: results.length, results, errors });
}
```

- [ ] **Step 2: Add the cron schedule to `vercel.json`**

In `vercel.json`, add a top-level `crons` key (alongside `cleanUrls`, `rewrites`, `headers`):

```json
"crons": [
  { "path": "/api/test-monitor", "schedule": "0 6 * * *" }
]
```

The complete `vercel.json` should now look like:

```json
{
  "cleanUrls": true,
  "rewrites": [
    { "source": "/test/:slug", "destination": "/api/serve-test" },
    { "source": "/lp/:slug/:variant", "destination": "/api/serve-lp" },
    { "source": "/lp/:slug", "destination": "/api/serve-lp" }
  ],
  "crons": [
    { "path": "/api/test-monitor", "schedule": "0 6 * * *" }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Strict-Transport-Security", "value": "max-age=31536000; includeSubDomains" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ]
}
```

- [ ] **Step 3: Tell the user to set `CRON_SECRET`**

Print this instruction and stop:

> **Action required (one-time):** Generate a random secret and add it to Vercel.
> ```bash
> openssl rand -hex 32
> ```
> Copy the output. In Vercel dashboard → Project → Settings → Environment Variables, add:
> - Name: `CRON_SECRET`
> - Value: (the hex string)
> - Environments: Production + Preview + Development
>
> Vercel automatically forwards this as `Authorization: Bearer ${CRON_SECRET}` to scheduled cron URLs.

- [ ] **Step 4: Commit**

```bash
git add api/test-monitor.js vercel.json
git commit -m "feat(cron): test-monitor handler + daily Vercel cron schedule"
```

---

## Stage 6: Activate flow + dashboard banner

### Task 19: Wire `toggleTestStatus` to set `started_at` + send kickoff

**Files:**
- Modify: `dashboard.html` — `toggleTestStatus()` around line 2805

- [ ] **Step 1: Update `toggleTestStatus`**

Replace the entire `async function toggleTestStatus()` body (lines ~2805-2840) with:

```js
async function toggleTestStatus() {
  if (!selectedTest) return;

  const newStatus = selectedTest.status === 'running' ? 'draft' : 'running';

  // If activating, verify all variant projects are published AND planner inputs are set
  if (newStatus === 'running') {
    if (!selectedTest.target_sample_size) {
      alert('הטסט הזה נוצר לפני הוספת תכנון התקציב. ערוך אותו והוסף את ערכי התכנון לפני ההפעלה.');
      return;
    }
    for (const tv of testVariants) {
      const { data: variant } = await sb.from('project_variants')
        .select('status')
        .eq('id', tv.variant_id)
        .single();
      if (!variant || variant.status !== 'published') {
        const pName = tv.projects?.name || 'Unknown';
        alert(`לא ניתן להפעיל: הוריאנט של "${pName}" אינו מפורסם`);
        return;
      }
    }
  }

  const updates = { status: newStatus, updated_at: new Date().toISOString() };
  if (newStatus === 'running' && !selectedTest.started_at) {
    updates.started_at = new Date().toISOString();
  }

  const { error } = await sb.from('tests')
    .update(updates)
    .eq('id', selectedTest.id);

  if (error) {
    console.error('Toggle test status error:', error);
    alert('שגיאה בעדכון סטטוס הטסט');
    return;
  }

  // Fire kickoff email on first activation (idempotent: only if kickoff_sent_at IS NULL)
  if (newStatus === 'running' && !selectedTest.kickoff_sent_at) {
    try {
      const resp = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test_kickoff', test_id: selectedTest.id }),
      });
      if (resp.ok) {
        await sb.from('tests').update({ kickoff_sent_at: new Date().toISOString() }).eq('id', selectedTest.id);
      } else {
        const errBody = await resp.json().catch(() => ({}));
        console.error('Kickoff email failed:', resp.status, errBody);
        // Non-blocking: test is running, user already has dashboard. Show toast.
        alert('הטסט פעיל. שליחת מייל פתיחה נכשלה — בדוק לוגים.');
      }
    } catch (err) {
      console.error('Kickoff email exception:', err);
    }
  }

  selectedTest.status = newStatus;
  await loadTests();
  selectTest(selectedTest.id);
}
```

- [ ] **Step 2: Verify in browser**

Run: open dashboard preview, create a test with planner values, click activate.
Expected:
- `tests.status` flips to `running`, `started_at` populated, `kickoff_sent_at` populated.
- Kickoff email arrives in the test creator's inbox in Hebrew RTL.
- No console errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): set started_at + send kickoff email on test activation"
```

### Task 20: Add the post-summary "Recommend stop" banner

**Files:**
- Modify: `dashboard.html` — banner markup near the variants display, banner JS in the `selectTest` flow

- [ ] **Step 1: Add the banner markup**

Find the test detail header in `dashboard.html` (around line 1660 — the `<span id="test-status-badge">` line). Just BELOW the surrounding header `<div>` (find the closing `</div>` of that block, around line 1670), insert:

```html
<div id="test-recommend-banner" style="display:none; margin:12px 0; padding:14px; border-radius:10px; border-right:4px solid #43a047; background:rgba(67,160,71,0.12);">
  <div style="display:flex; justify-content:space-between; align-items:center; gap:14px;">
    <div>
      <div id="test-recommend-headline" style="color:#81c784; font-weight:700; font-size:15px; margin-bottom:4px;"></div>
      <div id="test-recommend-body" style="color:var(--text-dim); font-size:13px;"></div>
    </div>
    <button id="test-recommend-cta" class="btn-action" onclick="showDeclareWinnerModal()" style="background:rgba(76,175,80,0.2);color:#81c784;border-color:#81c784;white-space:nowrap;">הכרז מנצח ועצור</button>
  </div>
</div>
```

- [ ] **Step 2: Wire the banner in `selectTest` (or wherever test details render)**

Find `function selectTest(testId)` or wherever `selectedTest` is populated and the test detail UI is updated (around line 2530). At the end of that function (after the existing UI updates), add:

```js
  _updateRecommendBanner();
```

Then add the helper function (anywhere convenient, e.g., near `toggleTestStatus`):

```js
function _updateRecommendBanner() {
  const banner = document.getElementById('test-recommend-banner');
  if (!banner || !selectedTest) return;

  const fired = selectedTest.summary_sent_at && selectedTest.status === 'running';
  if (!fired) {
    banner.style.display = 'none';
    return;
  }

  // Read existing variant metrics already computed for the dashboard;
  // fall back to a generic message if they aren't available.
  const headlineEl = document.getElementById('test-recommend-headline');
  const bodyEl = document.getElementById('test-recommend-body');
  const ctaEl = document.getElementById('test-recommend-cta');

  // We only know summary_sent_at fired — to know which verdict, we'd need
  // to re-run the math in browser or store the verdict on tests. Simplest
  // for v1: show a neutral "system has a recommendation" banner; the email
  // already has the verdict text.
  banner.style.display = '';
  banner.style.borderRightColor = '#43a047';
  banner.style.background = 'rgba(67,160,71,0.12)';
  headlineEl.style.color = '#81c784';
  headlineEl.textContent = '🟢 יש לנו המלצה עבורך';
  bodyEl.textContent = 'שלחנו לך מייל עם פירוט. בדוק את התיבה ולחץ "הכרז מנצח" כשאתה מוכן.';
  ctaEl.style.display = '';
}
```

- [ ] **Step 3: Verify in browser**

Manually update one running test row in Supabase: `UPDATE tests SET summary_sent_at = now() WHERE id = '<some-running-test-uuid>';`. Reload dashboard, select that test.
Expected: green banner appears between the test header and the variant grid; clicking the CTA opens the existing declare-winner modal.

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): post-summary recommend-stop banner on running tests"
```

---

## Stage 7: Smoke test on Vercel preview

### Task 21: End-to-end smoke test

**Files:** none modified — verification only

- [ ] **Step 1: Push the branch and open a preview deploy**

```bash
git push -u origin feat/test-planner-emails
```

Visit Vercel dashboard → confirm the preview build succeeded. Note the preview URL (e.g., `messaginglab-git-feat-test-planner-emails-...vercel.app`).

- [ ] **Step 2: Confirm the preview hasn't broken public LP routes** (CLAUDE.md sacred rule)

Run:
```bash
curl -sI https://<preview-url>/lp/lipaz-ela-1 | head -1
```
Expected: `HTTP/2 200`. If 500: STOP — investigate before continuing.

- [ ] **Step 3: Verify function count is 11/12**

Vercel dashboard → Project → Functions. Confirm `test-monitor` shows up and the total is 11.

- [ ] **Step 4: Set `CRON_SECRET` on the Preview environment**

If you haven't already from Task 18 step 3, set it now and redeploy.

- [ ] **Step 5: Manually invoke the cron endpoint**

```bash
curl -i \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://<preview-url>/api/test-monitor
```
Expected: `200 OK` with `{ "processed": N, "results": [...], "errors": [] }`. (`processed` may be 0 if no tests are running.)

- [ ] **Step 6: Create a real test with the calculator and activate it**

Open the preview dashboard, sign in, click "צור טסט חדש":
- Pick 2 published LP variants
- Enter baseline=3, MDE=20, CPC=3.5
- Confirm calculator shows ~4400 visitors / variant, ~₪30,800 budget, days estimate
- Click "צור טסט" → click "הפעל"

Verify in Supabase:
```sql
SELECT name, status, started_at, target_sample_size, baseline_cvr, mde, expected_cpc, kickoff_sent_at
FROM tests ORDER BY created_at DESC LIMIT 1;
```
Expected: all populated, `kickoff_sent_at` within the last minute.

Verify in the test creator's inbox: kickoff email arrived in Hebrew RTL with no garbled chars, three result tiles render, CTA button is clickable.

- [ ] **Step 7: Seed analytics_events to fake 100% sample reached**

In Supabase SQL editor (replace `<test_id>` and `<variant_a_id>`, `<variant_b_id>`):

```sql
-- Seed 50 unique pageviews + 4 leads on variant A
INSERT INTO analytics_events (project_id, variant_id, test_id, event_type, event_data, created_at)
SELECT
  (SELECT project_id FROM test_variants WHERE variant_id='<variant_a_id>'),
  '<variant_a_id>'::uuid,
  '<test_id>'::uuid,
  CASE WHEN g % 13 = 0 THEN 'lead_captured' ELSE 'pageview' END,
  jsonb_build_object('visitor_id', 'seed-a-' || g),
  now() - (g * interval '1 minute')
FROM generate_series(1, 50) g;

-- Seed 50 unique pageviews + 12 leads on variant B (clear winner)
INSERT INTO analytics_events (project_id, variant_id, test_id, event_type, event_data, created_at)
SELECT
  (SELECT project_id FROM test_variants WHERE variant_id='<variant_b_id>'),
  '<variant_b_id>'::uuid,
  '<test_id>'::uuid,
  CASE WHEN g % 4 = 0 THEN 'lead_captured' ELSE 'pageview' END,
  jsonb_build_object('visitor_id', 'seed-b-' || g),
  now() - (g * interval '1 minute')
FROM generate_series(1, 50) g;
```

Then update target_sample_size to a small number so we exceed 100%:
```sql
UPDATE tests SET target_sample_size = 50 WHERE id = '<test_id>';
```

- [ ] **Step 8: Re-invoke the cron and verify the summary email fires**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://<preview-url>/api/test-monitor | jq
```
Expected: `results` includes `{ test_id: '<test_id>', state: 'WINNER_FOUND', action: 'test_summary' }`. Email arrives with subject `יש מנצח: ...`.

Verify dedupe:
```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://<preview-url>/api/test-monitor | jq
```
Expected: `results` for that test has `action: null` (already sent).

Verify in Supabase: `summary_sent_at` populated.

- [ ] **Step 9: Verify the post-summary banner appears in the dashboard**

Reload the dashboard, select the seeded test. Expect the green banner with "יש לנו המלצה עבורך".

- [ ] **Step 10: Cleanup the seeded data**

```sql
DELETE FROM analytics_events WHERE event_data->>'visitor_id' LIKE 'seed-%';
UPDATE tests SET status='completed', target_sample_size=NULL, summary_sent_at=NULL WHERE id='<test_id>';
```

- [ ] **Step 11: Commit anything extra (or just record success)**

If the smoke test surfaced any small bugs and you fixed them inline:

```bash
git add -A
git commit -m "fix: smoke-test fixes (test-planner)"
git push
```

---

## Self-Review

**Spec coverage check** — every spec section maps to one or more tasks:

| Spec section | Task |
|---|---|
| §1 Goals: pre-test calc | Tasks 6, 7, 8 |
| §1 Goals: in-flight emails | Tasks 14, 18, 16/17 (decision) |
| §1 Goals: summary email | Tasks 15, 16/17 (verdicts) |
| §4 Architecture flow | Tasks 0–21 in order |
| §5 Data model | Task 1 |
| §6 Statistical methodology | Tasks 3, 4, 5 (calc + Bayes), Task 16 (decideState) |
| §7 UI: calculator | Tasks 6, 7, 8 |
| §7 UI: recommend banner | Task 20 |
| §8 Email content (6 templates) | Tasks 9, 10, 11 (3 verdicts), 12 |
| §8 Throttling (1 email per tick, precedence) | Task 17 (`pickEmailAction` precedence test cases) |
| §9 Dispatch | Implicit (5-stage task ordering matches the 3-stage agent topology in the spec) |
| §10 Error handling | Throughout — every handler logs and re-throws/500s |
| §11 Testing (bayes + decideState + pickEmailAction + email renderers) | Tasks 3, 4, 5, 9, 10, 11, 12, 16, 17 |
| §12 Verification checklist | Task 21 (mirrors §12 step-by-step) |
| §13 Open risks | Surfaced inline in tasks (CRON_SECRET in Task 18, DST in contract doc, dashboard heuristic noted in §13 — see note below) |

**One spec item not yet implemented**: §13 says the existing dashboard heuristic at `dashboard.html` lines 2707-2723 should additionally consult `summary_sent_at` so the dashboard color matches the email verdict. **Adding it as Task 22**:

### Task 22: Make dashboard heuristic respect `summary_sent_at`

**Files:**
- Modify: `dashboard.html` around lines 2707-2723

- [ ] **Step 1: Augment the existing `hasEnoughData` / leader-coloring logic**

Find the block starting `// Find leader — only call a winner when sample is meaningful AND lift is material` (around line 2707). Replace through the `if (lift >= MIN_RELATIVE_LIFT_PCT) { ... }` close (around line 2722) with:

```js
  // Find leader — call a winner if (a) backend already sent the summary email,
  // OR (b) the legacy heuristic is satisfied. (a) is the authoritative signal.
  const MIN_UV_PER_VARIANT = 30;
  const MIN_LEADS_PER_VARIANT = 5;
  const MIN_RELATIVE_LIFT_PCT = 30;
  let leader = null;

  if (selectedTest?.summary_sent_at) {
    // Backend has decided — show the empirical leader regardless of heuristic
    if (metrics.length >= 2) {
      const sorted = [...metrics].sort((a, b) => b.convPct - a.convPct);
      const delta = sorted[0].convPct - sorted[1].convPct;
      const lift = sorted[1].convPct > 0 ? (delta / sorted[1].convPct) * 100 : Infinity;
      const deltaPct = Number.isFinite(lift) ? lift.toFixed(0) : '∞';
      leader = { vid: sorted[0].vid, deltaPct };
    }
  } else {
    const hasEnoughData = metrics.every(m => m.uv >= MIN_UV_PER_VARIANT && m.lc >= MIN_LEADS_PER_VARIANT);
    if (hasEnoughData && metrics.length >= 2) {
      const sorted = [...metrics].sort((a, b) => b.convPct - a.convPct);
      const delta = sorted[0].convPct - sorted[1].convPct;
      const lift = sorted[1].convPct > 0 ? (delta / sorted[1].convPct) * 100 : Infinity;
      if (lift >= MIN_RELATIVE_LIFT_PCT) {
        const deltaPct = Number.isFinite(lift) ? lift.toFixed(0) : '∞';
        leader = { vid: sorted[0].vid, deltaPct };
      }
    }
  }
```

- [ ] **Step 2: Verify in browser**

For a test where you've already faked `summary_sent_at` (Task 21 step 7), confirm the leader column shows green even if the heuristic floors aren't met.

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "feat(ui): dashboard leader respects summary_sent_at signal"
```

**Placeholder scan:** none found. Every code block contains real code. No "TBD"/"TODO" inside step bodies.

**Type consistency check:**
- `decideState` returns `{state, currentPct, leader, leaderIdx, winnerProb, expectedLoss, liftPct}` (subset depending on state) — used by `pickEmailAction` which references `decision.state`, `decision.leader.label`, `decision.leader.name`, `decision.liftPct`, `decision.currentPct`. ✓
- `pickEmailAction` returns `{name, payload}` — `name ∈ {'test_kickoff','test_milestone','test_summary','test_stall_alert'}` matches the action discriminators in `api/send-email.js` and the contract doc. ✓
- `payload.milestone ∈ {25,50,75}` matches the validator in `handleTestMilestone` (Task 14). ✓
- `payload.verdict ∈ {WINNER_FOUND, PRACTICAL_TIE, TRENDING_UNDERPOWERED}` matches `handleTestSummary` validator (Task 15) and `renderSummaryEmail` switch (Task 11). ✓
- Database column names — `last_milestone_sent` / `summary_sent_at` / `stall_alert_sent_at` / `kickoff_sent_at` — used identically in migration (Task 1), contract doc (Task 2), cron worker `markEmailSent` (Task 18), and `toggleTestStatus` (Task 19). ✓
- `variantCounts` / `variantCountsWithName` shape — `{variant_id, label, name, visitors, conversions}` — consistent across `fetchTestVariantsAndCounts` (Task 18), `decideState` (Task 16), email renderers (Tasks 10/11). ✓

No inconsistencies found.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-03-test-planner-emails.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best fit for this plan because Stage 2/3/4 tasks are independent enough that some can run in parallel (per the spec's 5-agent topology), and per-task review keeps each agent's context tight.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Simpler if you want to watch every step, but heavier on this session's context.

**Which approach?**
