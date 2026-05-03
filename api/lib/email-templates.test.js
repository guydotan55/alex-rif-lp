import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderKickoffEmail, renderMilestoneEmail } from './email-templates.js';

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
