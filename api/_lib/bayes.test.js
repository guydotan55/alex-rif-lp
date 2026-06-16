// api/lib/bayes.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleSizePerVariant } from './bayes.js';

test('sampleSizePerVariant: baseline 3%, MDE +30% → ~6300-6600 per variant (relative lift p2=3.9%)', () => {
  const n = sampleSizePerVariant(0.03, 0.30, 2);
  assert.ok(n >= 6300 && n <= 6600, `expected ~6455, got ${n}`);
});

test('sampleSizePerVariant: baseline 5%, MDE +20% → ~7900-8400 per variant (relative lift p2=6.0%)', () => {
  const n = sampleSizePerVariant(0.05, 0.20, 2);
  assert.ok(n >= 7900 && n <= 8400, `expected ~8158, got ${n}`);
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
