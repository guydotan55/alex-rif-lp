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
