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

// ── pickEmailAction: precedence + idempotency ──────────────────────────────

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
