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
