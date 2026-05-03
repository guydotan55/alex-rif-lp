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
