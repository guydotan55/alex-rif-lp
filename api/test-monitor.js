// api/test-monitor.js
// Daily cron worker for test-planner: scans running tests, decides what to email.

import { sampleBeta, computeWinnerProbabilities, computeExpectedLoss } from './_lib/bayes.js';
import { computeEconomicVerdict } from './_lib/economic-verdict.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_ORIGIN = process.env.APP_URL || '';
const CRON_SECRET = process.env.CRON_SECRET;

const ALPHA_PRIOR   = 1;
const BETA_PRIOR    = 1;
const MC_DRAWS      = 10000;
// Tuned for NGO scale (~₪5K budget tests). Lower thresholds mean the engine
// will recommend a winner earlier and on smaller samples — accepting ~10-15%
// chance of calling a wrong winner on borderline tests, which is fine when
// the cost is "slightly worse CR" not money loss.
const STOP_P_BEST   = 0.80;
const STOP_MAX_LOSS = 0.0075;
const STOP_MIN_CONV = 20;
const STOP_MIN_VIS  = 100;
const STALL_HOURS   = 48;

export function decideState(test, variantCounts) {
  const totalVisitors = variantCounts.reduce((s, v) => s + v.visitors, 0);
  const totalTarget = test.target_sample_size * variantCounts.length;
  const sampleVsTarget = totalVisitors / totalTarget;
  const currentPct = Math.floor(sampleVsTarget * 100);

  const startedAt = test.started_at || test.reset_at || test.created_at;
  const hoursSinceStart = (Date.now() - new Date(startedAt).getTime()) / 3.6e6;
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
    // 3-tier scale at 100% sample: WINNER_FOUND (caught above at P > STOP_P_BEST=0.80),
    // TRENDING_UNDERPOWERED (0.65 ≤ P ≤ 0.80), PRACTICAL_TIE (P < 0.65).
    if (sortedProb[0] >= 0.65) {
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
  // STALL: send once; if already sent, suppress everything else for this decision
  if (decision.state === 'STALL') {
    return test.stall_alert_sent_at ? null : { name: 'test_stall_alert', payload: {} };
  }
  // Terminal states: send summary once; if already sent, nothing more to do
  if (['WINNER_FOUND', 'PRACTICAL_TIE', 'TRENDING_UNDERPOWERED'].includes(decision.state)) {
    if (test.summary_sent_at) return null;
    const payload = { verdict: decision.state };
    if (decision.leader) {
      payload.winnerLabel     = decision.leader.label      || null;
      payload.winnerName      = decision.leader.name       || null;
      payload.liftPct         = decision.liftPct           ?? 0;
      payload.winnerVariantId = decision.leader.variant_id || null;
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

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function fetchRunningTests() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tests?status=eq.running&select=*`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!res.ok) throw new Error(`fetchRunningTests: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchTestVariantsAndCounts(test) {
  // Get test_variants for label + project name
  const tvRes = await fetch(
    `${SUPABASE_URL}/rest/v1/test_variants?test_id=eq.${test.id}&select=variant_id,label,projects(name)`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const testVariants = await tvRes.json();
  if (!testVariants?.length) return [];

  const variantIds = testVariants.map(tv => tv.variant_id);
  // Use the same start-time fallback chain the dashboard uses (line 2810):
  // started_at OR reset_at OR created_at
  const startedAt = test.started_at || test.reset_at || test.created_at;
  const variantInList = variantIds.map(id => `"${id}"`).join(',');

  // Pull events for these variants since started_at, paginated.
  let allRows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/analytics_events?variant_id=in.(${variantInList})&created_at=gte.${encodeURIComponent(startedAt)}&select=variant_id,event_type,event_data&limit=${PAGE}&offset=${from}`,
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
      if (e.event_type === 'page_view' && e.event_data?.visitor_id) visitors.add(e.event_data.visitor_id);
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

// ---------------------------------------------------------------------------
// Cron handler
// ---------------------------------------------------------------------------

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
      if (!test.target_sample_size) {
        results.push({ test_id: test.id, skipped: 'no target_sample_size — backfill via edit modal' });
        continue;
      }
      const variantCounts = await fetchTestVariantsAndCounts(test);
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
