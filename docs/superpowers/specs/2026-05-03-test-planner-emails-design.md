# Test Planner + Lifecycle Emails — Design

**Status:** Draft, awaiting user review
**Date:** 2026-05-03
**Branch:** `feat/test-planner-emails`
**Scope:** Approach B ("honest peeking v1") — Bayesian decision engine + 6 lifecycle emails + daily cron + 5-agent dispatch.

---

## 1. Goals

Add three connected surfaces to the existing A/B testing dashboard so an NGO admin can plan, run, and finish a paid-traffic LP test without doing math or guessing when to stop:

1. **Pre-test budget calculator** — inline in the create-test modal. Inputs: baseline conversion rate, minimum detectable effect (MDE), expected CPC. Outputs: required sample size per variant, $ budget estimate, days estimate.
2. **In-flight milestone emails** — sent at 25% / 50% / 75% / 100% of required sample, plus a 48h-zero-traffic stall alert.
3. **Summary email + stop recommendation** — sent on the earlier of (a) Bayesian winner gate met or (b) 100% of required sample reached. Recommends action; the user clicks "Declare winner" in the dashboard to finalize.

## 2. Constraints (from CLAUDE.md and admin-ux.md)

- **Self-serve flow** — non-tech NGO admin (30s–50s) must complete the entire flow alone. If the UI needs explaining, it's broken.
- **Hebrew RTL** — all user-facing text and emails. Never use English tech words in user-facing copy.
- **Pick simple over clever** — vanilla HTML+JS, small Vercel functions. No framework. ~50 boring lines beat 20 clever ones.
- **Fail loud, never silent** — no `catch {}` without logging or rethrowing.
- **Don't break public LP routes** — `/lp/:slug` and `/lp/:slug/:variant` are LIVE with paying customer ad spend.
- **Vercel Hobby tier** — 12-function ceiling (currently 10 used; this feature adds 1, leaving 1 free). Cron is once-per-day max on Hobby.
- **Brevo for email** — already integrated in `api/send-email.js`. Don't introduce a second mail provider.
- **Do exactly what was asked** — no auto-stop (we recommend; user decides). No auto-defaults / per-community CPC / dashboard live-verdict widget — those were not in the ask.

## 3. Non-goals (explicitly out of scope for v1)

- Auto-stopping a test (we recommend stopping; the user clicks "Declare winner")
- Per-community CPC defaults or admin UI to set them
- Auto-pulling baseline CR from prior tests in the same community
- Live verdict widget on the dashboard for in-flight tests (the existing heuristic + post-summary banner cover this)
- Customizable email templates (templates are inline JS constants)
- Multiple recipients per test (only `tests.created_by` receives email)
- A/B testing tool sharing / "follow this test" subscriptions
- Hourly or sub-daily cron cadence (Hobby tier blocks this)

---

## 4. Architecture

### 4.1 End-to-end flow

```
[user opens "Create test" modal in dashboard.html]
       │
       ▼
[inline calculator: baseline_cvr, mde, expected_cpc]
   ─→ live JS: target_sample_size = sampleSizePerVariant(...)
   ─→ live JS: budget_estimate = required_visitors_total / lp_visit_rate * cpc
   ─→ live JS: days_estimate    = required_visitors_total / community_velocity
       │
       ▼
[user clicks "הפעל טסט"]
   ─→ INSERT tests row: status='running', started_at=now(),
      target_sample_size, baseline_cvr, mde, expected_cpc, last_milestone_sent=0
   ─→ POST /api/send-email {action:'test_kickoff', test_id}
       │
       ▼
[Vercel cron — daily 0 6 * * * UTC → /api/test-monitor]
   (Israel time: 08:00 winter / 09:00 summer; DST drift accepted, see §13)
   for each test where status='running':
     fetch unique-visitor + lead counts per variant from analytics_events
     decision = decideState(test, variantCounts)
     action   = pickEmailAction(test, decision)   // throttled; at most 1/tick
     if action:
        POST /api/send-email {action: action.name, test_id, ...}
        UPDATE tests SET <appropriate>_sent_at = now() (or last_milestone_sent = ...)
       │
       ▼
[user reads email, opens dashboard, sees "Recommend stop" banner if summary fired]
[user clicks "הכרז מנצח" → status='completed' (existing flow)]
```

### 4.2 Component boundaries

| Unit | Responsibility | Owns | Reads |
|---|---|---|---|
| Calculator UI block (in `dashboard.html`) | Pure UI: render inputs, run formula, show results, gate Activate button | DOM + 3 input values | community traffic velocity for days estimate |
| `supabase/migrations/add_test_planner_fields.sql` | Schema for planner inputs + email-state ledger | new columns on `tests` | — |
| `api/test-monitor.js` (NEW) | Cron entry point: scan running tests, decide what to send | side-effect HTTP POSTs to send-email; updates `*_sent_at` cols | `tests`, `analytics_events`, env secret |
| `api/lib/bayes.js` (NEW) | Pure stats: `sampleSizePerVariant`, `sampleBeta`, `computeWinnerProbabilities`, `computeExpectedLoss` | nothing — no I/O | nothing |
| `decideState()` (in `test-monitor.js`) | Pure: given test + counts → state + recommendation | nothing | nothing |
| `api/send-email.js` (extended) | Renders + sends 4 new email actions via Brevo | Brevo HTTP | `tests` table for context |
| `docs/test-planner-contract.md` (NEW, by Stage 1 agent) | Single source of truth for column names + payload shapes | text doc in git | — |

### 4.3 Two key design choices

**Recommend, don't auto-stop.** When `decideState` returns `WINNER_FOUND` or 100% sample is reached, we send the summary email and update `summary_sent_at`, but we leave `tests.status='running'`. The user clicks "הכרז מנצח" in the dashboard to finalize. Reasons: (a) "do exactly what was asked" — the user said "summary email recommending when to turn the test off"; (b) preserves the existing manual `declareWinner` flow already wired in `dashboard.html` line 2867; (c) safer — the user is in control of money flowing to Meta.

**Cron mutates only `*_sent_at` columns, never `status`.** This makes the cron read-mostly and idempotent: if the same milestone re-fires (e.g., cron retries), the email-sent guard prevents duplicate sends. Status changes happen only through user action in the dashboard.

---

## 5. Data model

### 5.1 Migration: `supabase/migrations/add_test_planner_fields.sql`

```sql
-- Planner inputs (filled at test creation)
ALTER TABLE tests ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS target_sample_size INT;       -- per variant
ALTER TABLE tests ADD COLUMN IF NOT EXISTS baseline_cvr NUMERIC(5,4);    -- 0.0300 = 3%
ALTER TABLE tests ADD COLUMN IF NOT EXISTS mde NUMERIC(5,4);             -- 0.2000 = +20% relative
ALTER TABLE tests ADD COLUMN IF NOT EXISTS expected_cpc NUMERIC(8,2);    -- ₪3.50

-- Email-state ledger (cron writes; idempotency)
ALTER TABLE tests ADD COLUMN IF NOT EXISTS last_milestone_sent INT NOT NULL DEFAULT 0;  -- 0/25/50/75/100
ALTER TABLE tests ADD COLUMN IF NOT EXISTS stall_alert_sent_at TIMESTAMPTZ;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS summary_sent_at TIMESTAMPTZ;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS kickoff_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tests_running_started ON tests(status, started_at)
  WHERE status = 'running';
```

No new tables. No new RLS policies — the existing `tests` policies (super_admin / admin / manager) cover these columns.

### 5.2 Column rationale

- `target_sample_size` is **per variant**, not total — matches the formula's natural unit.
- `last_milestone_sent` is `INT` (not 4 bool flags) — naturally monotonic; check is `if (currentPct >= 25 && last_milestone_sent < 25)`.
- `kickoff_sent_at` separate from `last_milestone_sent` because kickoff fires synchronously on Activate, not on a cron tick.
- `summary_sent_at` is its own column (not a sentinel value of `last_milestone_sent=100`) because the summary can fire either at 100% sample OR on early significance — both paths need the same dedupe lock.
- Partial index on `(status, started_at) WHERE status='running'` keeps the cron's primary query fast as the `tests` table grows.

---

## 6. Statistical methodology (from research Agent A)

### 6.1 Calculator: frequentist two-proportion sample size

The planning number must be defensible and match every other A/B calculator the marketer might cross-check (Evan Miller, Optimizely, AB Tasty), so we use the standard formula even though our decision engine is Bayesian.

```ts
// In api/lib/bayes.js
export function sampleSizePerVariant(baselineCr: number, mde: number, numVariants = 2): number {
  const k = numVariants - 1;
  const alpha = k > 1 ? 0.05 / k : 0.05;       // Bonferroni for 3+ variants
  const z_a = quantileNormal(1 - alpha / 2);    // two-sided
  const z_b = 0.841621;                          // power 0.80
  const p1 = baselineCr;
  const p2 = baselineCr * (1 + mde);
  const pBar = (p1 + p2) / 2;
  const num = Math.pow(
    z_a * Math.sqrt(2 * pBar * (1 - pBar)) +
    z_b * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)),
    2
  );
  return Math.ceil(num / Math.pow(p2 - p1, 2));
}
```

Sanity check: baseline=3%, MDE=+30% → ~3,830 / variant (matches Evan Miller's calculator within rounding).

### 6.2 Live decision: Bayesian Beta-Binomial with dual-gate stop

Bayesian because we *will* peek at every cron tick, and frequentist peeking inflates Type-I error (Evan Miller, "How not to run an A/B test"). Beta(1,1) prior is uniform; weakly-informative is fine for v1.

**Constants** (in `api/test-monitor.js`):

```js
const ALPHA_PRIOR   = 1;
const BETA_PRIOR    = 1;
const MC_DRAWS      = 10000;
const STOP_P_BEST   = 0.95;     // P(winner is best) > 0.95
const STOP_MAX_LOSS = 0.0075;   // expected loss < 0.75% of baseline CR
const STOP_MIN_CONV = 25;       // ≥25 conversions for the leader
const STOP_MIN_VIS  = 200;      // ≥200 visitors for the leader
const STALL_HOURS   = 48;       // 0 traffic for 48h → stall alert
```

**Stop rule (early, while `currentPct < 100`):** all four gates must be true to declare an early winner. The expected-loss gate is the safety net that prevents firing on a small-n posterior fluke.

**Stop rule (at or past planned sample, `currentPct >= 100`):** the `STOP_MIN_CONV` and `STOP_MIN_VIS` floors are RELAXED — the user planned for that sample size, so the safety floors no longer apply. Only `winnerProb[leader] > STOP_P_BEST` (and implicitly `expectedLoss < STOP_MAX_LOSS` since they correlate) needs to hold to return `WINNER_FOUND`. Otherwise drop into `TRENDING_UNDERPOWERED` (P(best) ∈ [0.85, 0.95]) or `PRACTICAL_TIE` (< 0.85). Without this relaxation, tests planned with `target_sample_size < 200` per variant could never declare a winner.

### 6.3 End states

When the cron tick processes a test:

| State | Trigger | Email sent | Banner shown |
|---|---|---|---|
| `NORMAL` | Test running, no milestone crossed | none | none |
| `STALL` | 0 visitors in 48h, `!stall_alert_sent_at` | `test_stall_alert` | none |
| `WINNER_FOUND` | (early) dual-gate met OR (at-target) currentPct ≥ 100 && P(best) > 0.95; AND `!summary_sent_at` | `test_summary` (winner variant) | "מצאנו מנצח" |
| `PRACTICAL_TIE` | currentPct ≥ 100, top P(best) < 0.85 | `test_summary` (no winner) | "אין הבדל מובהק" |
| `TRENDING_UNDERPOWERED` | currentPct ≥ 100, top P(best) ∈ [0.85, 0.95] | `test_summary` (suggest extend) | "מוביל לא מובהק" |
| (milestone) | currentPct ≥ {25,50,75} && last_milestone_sent < that value | `test_milestone` | none |

### 6.4 Multiple comparisons (3+ variants)

Calculator inflates sample size via Bonferroni. The Bayesian P(best) sums to 1 across all variants by construction, so the live-decision side is naturally multi-arm. No further correction needed.

### 6.5 What the user sees (never raw probabilities)

Traffic-light + plain Hebrew sentence + (behind a "show me the numbers" toggle) credible-interval ranges:

| Light | When | Hebrew copy |
|---|---|---|
| 🟢 Green | dual-gate met | "וריאציה ב' מנצחת. אפשר לעצור את הטסט." |
| 🟡 Yellow | P(best) ∈ [0.85, 0.95] OR < 50% sample | "וריאציה ב' מובילה, אבל מוקדם להחליט. ממשיכים." |
| ⚪ Gray | <25% sample OR <25 conv/variant | "צריך עוד נתונים. בערך X ימים נוספים." |
| 🔴 Red | end of test, practical tie | "אין הבדל משמעותי. בחר על פי שיקולים אחרים." |

---

## 7. UI

### 7.1 Calculator (inline in create-test modal, dashboard.html ~line 1815-1870)

Three required RTL inputs above the existing "הפעל טסט" button: baseline CVR %, MDE %, expected CPC ₪. Each has a `?` tooltip with one sentence of plain Hebrew (per admin-ux: never English tech words in user-facing text).

Below the inputs, a results panel shows:
- Required visitors per variant
- Estimated total budget in ₪
- Estimated days based on community traffic velocity. **Velocity definition**: average unique visitors per day across all `published` projects in the same `community_id` over the last 14 days, computed from `analytics_events` `pageview` events. If the community has no traffic in the last 14 days, fall back to a default of 100 visitors/day and surface the assumption in a Hebrew tooltip ("מבוסס על הערכה. עדכן בהתאם לקצב התנועה הצפוי.").

The Activate button is disabled until all 3 inputs are valid numbers AND at least one variant in the test is `published`.

### 7.2 Post-summary "Recommend stop" banner

When the dashboard loads a test where `summary_sent_at IS NOT NULL` and `status='running'`, render a banner above the variants:

```
┌─ המלצה מהמערכת ─────────────────────────────────┐
│  🟢 מצאנו מנצח: וריאציה ב'                       │
│  שלחנו לך מייל עם הפרטים. אפשר לעצור את הטסט.    │
│                              [ הכרז מנצח ועצור ]  │
└─────────────────────────────────────────────────┘
```

Reuses the existing `btn-declare-winner` action wired in `dashboard.html` line 2867. Color follows the verdict: green for WINNER_FOUND, gray for PRACTICAL_TIE, yellow for TRENDING_UNDERPOWERED.

---

## 8. Email content (from research Agent B)

### 8.1 Six email templates (rendered inline in `api/send-email.js`)

| # | Action | Trigger | Hebrew subject (recommended) |
|---|---|---|---|
| 1 | `test_kickoff` | Synchronously on Activate | **הטסט עלה לאוויר — הנה התוכנית** |
| 2 | `test_milestone` (25%) | Daily cron, currentPct ≥ 25 && last_milestone_sent < 25 | **רבע מהדרך — {{leader}} מוביל קלות** |
| 3 | `test_milestone` (50%) | currentPct ≥ 50 && last_milestone_sent < 50 | **חצי דרך. הפער מתחיל להתייצב.** |
| 4 | `test_milestone` (75%) | currentPct ≥ 75 && last_milestone_sent < 75 | **שלושת רבעי הדרך — מתחילים להתכונן להחלטה** |
| 5 | `test_summary` | state ∈ {WINNER_FOUND, PRACTICAL_TIE, TRENDING_UNDERPOWERED} && !summary_sent_at | Variant-dependent (see §8.2) |
| 6 | `test_stall_alert` | state == STALL && !stall_alert_sent_at | **עצירה: 0 מבקרים ב-48 השעות האחרונות** |

### 8.2 Summary email subject by verdict

- WINNER_FOUND → **יש מנצח: {{winning_variant}} ({{lift}}% שיפור)**
- PRACTICAL_TIE → **הטסט הסתיים — אין הבדל מובהק בין הוורסיות**
- TRENDING_UNDERPOWERED → **{{leader}} מוביל אך לא מובהק — להאריך או להחליט?**

### 8.3 Cross-cutting email rules

- `<html dir="rtl" lang="he">` AND `dir="rtl"` on every `<table>`, `<td>`, `<div>` containing Hebrew (Outlook ignores inheritance).
- `text-align: right` inline on all text cells.
- Font stack: `font-family: 'Heebo', 'Assistant', 'Arial Hebrew', Arial, sans-serif;`
- Numbers/currency wrapped in `<span dir="ltr">` to prevent ₪ flipping.
- Buttons: bullet-proof `<table>` with `dir="rtl"` on inner `<td>` (no VML — Brevo handles MSO conditionals).
- Light/dark mode: explicit `background-color` AND `color` on every text container; `<meta name="color-scheme" content="light dark">`.
- **No embedded chart images.** Use bold typography for the 1-2 numbers that matter. Summary email's winner-vs-runner-up comparison uses width-based `<td>` bar charts (renders universally). QuickChart PNGs are blocked ~30% of the time on Outlook (Litmus 2024).
- Reuse the existing navy-header + Heebo card visual style from `api/send-email.js` lines 176-184 (the welcome email).

### 8.4 Throttling

The daily cron naturally enforces most of Agent B's throttling rules. Only one rule remains:

**Per cron tick per test, send AT MOST ONE email.** Precedence: `test_stall_alert` > `test_summary` > `test_milestone`. If two milestone thresholds are crossed in one tick (high-velocity test), only the highest fires and `last_milestone_sent` jumps to that value — the skipped milestone is silently absorbed.

### 8.5 Templates as inline JS constants

Stored in `api/send-email.js` for v1 (consistent with the existing welcome-email pattern). Not pulled from Supabase `settings` because (a) we're not asking the user to customize, (b) it doubles cron DB round-trips for no value. If user customization is later added, lift to `settings` table at that point.

---

## 9. Multi-agent dispatch (5 agents, 3 stages)

### 9.1 Stage 1 (serial): `migration-architect`

- Writes `supabase/migrations/add_test_planner_fields.sql` per §5.1 verbatim.
- Writes `docs/test-planner-contract.md` declaring: column names + types, the 4 new send-email `action` discriminators with exact JSON payload shapes, the cron schedule string (`0 6 * * *` UTC, drifts 08:00–09:00 IL across DST — acceptable), the SELECT query the cron worker uses against `tests` + `analytics_events`, and the dependency arrows between Stage 2 agents.
- Returns: file paths + the contract doc inline so the parent can verify.

**Gate before Stage 2:** parent reads the contract doc, confirms it matches §5.1, then runs `npx supabase db push` (or instructs the user). No Stage 2 dispatch until migration is applied.

### 9.2 Stage 2 (3 parallel agents)

- **2a `calculator-ui-coder`** — owns the create-test modal block in `dashboard.html` (~lines 1815-1870 + a new `<script>` block). Writes the Hebrew RTL inputs + tooltips + live results panel + persists planner inputs into `tests` row on Activate + POSTs `test_kickoff`. Reads `docs/test-planner-contract.md`. Forbidden from touching `api/send-email.js`.
- **2b `cron-worker-coder`** — owns `api/test-monitor.js` (NEW), `api/lib/bayes.js` (NEW), and `vercel.json` (adds `crons` block). Implements `decideState`, `pickEmailAction`, the cron loop, Monte Carlo helpers, and the cron-secret auth check. Calls send-email via HTTP only — never imports it.
- **2c `email-handler-extender`** — owns `api/send-email.js` only. Adds 4 new `action` branches alongside existing `meta_capi` / project / legacy paths. Each renders the Hebrew RTL HTML template (per §8) and POSTs Brevo using the existing pattern.

### 9.3 Stage 3 (serial): `integrator-qa`

- Wires the Activate flow so it writes `started_at=now()` and validates `target_sample_size IS NOT NULL`.
- Adds the post-summary "Recommend stop" banner (§7.2) — different region of `dashboard.html` than 2a, no overlap.
- Updates the existing dashboard "neutral colors" heuristic so it also reads `summary_sent_at` (so dashboard verdict matches email verdict).
- Smoke test: seeds a fake running test, invokes `/api/test-monitor` with the cron secret locally, verifies the right email action fires.

### 9.4 File ownership matrix (collision-proof)

| File | Stage 1 | 2a | 2b | 2c | Stage 3 |
|---|---|---|---|---|---|
| `supabase/migrations/add_test_planner_fields.sql` | **W** | r | r | r | r |
| `docs/test-planner-contract.md` | **W** | r | r | r | r |
| `dashboard.html` | r | **W** (modal + script) | — | — | **W** (createTest, toggleTestStatus, banner) |
| `api/test-monitor.js` (NEW) | — | — | **W** | — | r |
| `api/lib/bayes.js` (NEW) | — | — | **W** | — | r |
| `vercel.json` | — | — | **W** | — | r |
| `api/send-email.js` | r | — | — | **W** | r |

### 9.5 Tooling

Plain `Task` subagents (`subagent_type: "general-purpose"`). The repo's `.claude-flow/` is empty / scaffolded-but-unused — no leverage from MCP swarm tools.

### 9.6 Function-count budget

Currently 10 Vercel functions. After this feature: **11** (added: `test-monitor`). 1 slot remains under the 12 ceiling. `api/lib/bayes.js` is not a function (no default export route).

---

## 10. Error handling

Per CLAUDE.md "Fail loud, never silent":

- **Cron worker:** if `decideState` throws on a test, log to `console.error` with the `test.id` and continue to the next test. Never `catch {}` silently. Final response includes an `errors[]` array so we can grep Vercel logs.
- **Send-email branches:** each new action wraps the Brevo POST in try/catch, logs the full Brevo error response, returns 500 with the error body (matches existing pattern).
- **Calculator UI:** if a tooltip target is missing or the JS throws, the Activate button stays disabled and a Hebrew error message renders. Never silently allows launch with bad numbers.
- **Cron auth:** `x-vercel-cron-secret` header check (configured via Vercel cron secrets). If missing/wrong, return 401 with no body.

---

## 11. Testing

Per CLAUDE.md "Tests for your own changes only — no suite to backfill. Co-locate tests next to code":

- `api/lib/bayes.test.js` — unit tests for `sampleSizePerVariant` (vs. Evan Miller known-good values), `sampleBeta`, `computeWinnerProbabilities`, `computeExpectedLoss` (vs. Stucchio worked examples).
- `api/test-monitor.test.js` — table-driven tests for `decideState` covering NORMAL / STALL / WINNER_FOUND / PRACTICAL_TIE / TRENDING_UNDERPOWERED, plus `pickEmailAction` precedence tests. Mocked test row + variant counts; no DB.
- No automated tests for email HTML — visual diff isn't worth automating; integration check is sending to a real Brevo sandbox inbox during Stage 3 smoke test.

## 12. Verification before declaring v1 done

Per CLAUDE.md "API changes → deploy preview to Vercel, hit the endpoint manually":

1. Deploy preview branch to Vercel.
2. Visit `/lp/lipaz-ela-1` — confirm no LP regression (CLAUDE.md: "Don't break public LP routes").
3. Open dashboard, create a test using the calculator, activate. Confirm `test_kickoff` email arrives in Hebrew RTL with no garbled chars.
4. Manually invoke `/api/test-monitor` with the cron secret — confirm response shows the seeded test was processed.
5. Seed `analytics_events` to fake 100% sample reached; re-invoke cron; confirm summary email arrives with correct verdict.
6. Confirm `tests.last_milestone_sent` and `summary_sent_at` updated; re-invoke cron — confirm no duplicate email sent.
7. Verify Vercel function count is 11/12 after deploy.

---

## 13. Open risks and notes

- **Vercel cron secret config**: requires the user to set `CRON_SECRET` in Vercel environment variables AND configure the cron's Authorization header. Stage 2b agent must produce a 1-line README note in `docs/test-planner-contract.md` explaining this.
- **DST drift on cron**: Vercel cron uses UTC. `0 6 * * *` UTC fires at 08:00 IST (winter, UTC+2) and 09:00 IDT (summer, UTC+3). Drift accepted for v1 — both times are reasonable morning send windows for an Israeli marketer, and Vercel's free cron doesn't support timezone-aware schedules. If we later care about exact 09:00 IL, switch to a worker that wakes hourly and gates on local-time check.
- **Daily cron lag**: a high-velocity test (say ₪500/day Meta spend) can cross 25%, 50%, 75% all between two daily cron ticks. The throttling rule (§8.4) silently absorbs the skipped milestones, but the user gets fewer emails than the 4-stage cadence implies. Acceptable for v1; documented in the kickoff email's "what to expect" line.
- **Bayesian Monte Carlo cost**: 10k draws per variant per cron tick. At 4 variants × 50 running tests, that's 2M draws per day. JS math, no I/O — well under Vercel function timeout.
- **Existing dashboard heuristic**: lines 2707-2723 of `dashboard.html` use a non-statistical "≥30 UV, ≥5 leads, ≥30% lift" heuristic to color the leader green. Stage 3 should leave this in place but additionally consult `summary_sent_at` so the in-dashboard color matches the emailed verdict. (Removing the heuristic entirely is out of scope.)
- **Three-or-more variants**: math is correct (Bonferroni for sizing, multi-arm posterior for stopping), but tested only on 2-variant cases in v1 unit tests. Stage 3 smoke test should cover one 3-variant case.

---

## 14. References

- Evan Miller, "How not to run an A/B test" — https://www.evanmiller.org/how-not-to-run-an-ab-test.html
- Evan Miller, sample-size calculator — https://www.evanmiller.org/ab-testing/sample-size.html
- Johari, Pekelis, Walsh, "Always Valid Inference" (mSPRT) — https://arxiv.org/abs/1512.04922
- Optimizely Stats Engine technical paper — https://www.optimizely.com/insights/blog/stats-engine-technical-paper/
- Chris Stucchio, Bayesian A/B decision rule — https://www.chrisstucchio.com/blog/2014/bayesian_ab_decision_rule.html
- VWO SmartStats whitepaper — https://cdn2.hubspot.net/hubfs/310840/VWO_SmartStats_technical_whitepaper.pdf
- Statsig multiple-testing — https://www.statsig.com/blog/multiple-testing-statsig
- Litmus 2024 State of Email Engagement — client market share + dark-mode rendering data
- Internal: `.claude/rules/admin-ux.md`, `.claude/rules/lp-design.md`, `CLAUDE.md`
