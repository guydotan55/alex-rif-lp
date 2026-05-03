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
