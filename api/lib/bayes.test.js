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
