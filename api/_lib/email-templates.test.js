import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderKickoffEmail, renderMilestoneEmail, renderSummaryEmail } from './email-templates.js';

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

test('renderSummaryEmail WINNER_FOUND — winner subject + lift number', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 800 },
    {
      verdict: 'WINNER_FOUND',
      winnerLabel: 'B',
      winnerName: 'Variant B',
      liftPct: 45.6,
      winnerCvr: 0.058,
      runnerUpCvr: 0.040,
    },
    [
      { label: 'A', name: 'Variant A', visitors: 800, conversions: 32 },
      { label: 'B', name: 'Variant B', visitors: 800, conversions: 46 },
    ]
  );
  assert.match(out.subject, /יש מנצח/);
  assert.match(out.subject, /Variant B|B/);
  assert.match(out.html, /45/);
  assert.match(out.html, /הכרז מנצח/);
});

test('renderSummaryEmail PRACTICAL_TIE — no-difference subject', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    { verdict: 'PRACTICAL_TIE' },
    [
      { label: 'A', name: 'A', visitors: 500, conversions: 15 },
      { label: 'B', name: 'B', visitors: 500, conversions: 16 },
    ]
  );
  assert.match(out.subject, /אין הבדל/);
});

test('renderSummaryEmail TRENDING_UNDERPOWERED — extend-or-decide subject', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    { verdict: 'TRENDING_UNDERPOWERED', winnerLabel: 'B', winnerName: 'B', liftPct: 18 },
    [
      { label: 'A', name: 'A', visitors: 500, conversions: 18 },
      { label: 'B', name: 'B', visitors: 500, conversions: 22 },
    ]
  );
  assert.match(out.subject, /להאריך|לא מובהק/);
});

import { renderStallAlertEmail } from './email-templates.js';

test('renderStallAlertEmail — 0-visitors subject + diagnostic checklist', () => {
  const out = renderStallAlertEmail({ name: 'Test C', slug: 'test-c' });
  assert.match(out.subject, /0 מבקרים|עצירה/);
  assert.match(out.html, /dir="rtl"/);
  assert.match(out.html, /פיקסל|מטא|URL/);
});

const baseSummaryVariants = [
  { label: 'A', name: 'התפתחות אישית',     visitors: 283, conversions: 23, lpUrl: 'https://example.com/lp/a', spend: 380 },
  { label: 'B', name: 'מסע אישי',          visitors: 234, conversions: 8,  lpUrl: 'https://example.com/lp/b', spend: 200 },
  { label: 'C', name: 'התפתחות נוסחה ב',   visitors: 274, conversions: 17, lpUrl: 'https://example.com/lp/c', spend: 320 },
];

test('renderSummaryEmail VIABLE — green band, scale-up CTA', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    {
      verdict: 'WINNER_FOUND', winnerLabel: 'A', winnerName: 'התפתחות אישית', liftPct: 31,
      economic: { verdict: 'VIABLE', cr_leader_cpl: 16.5, target_cpl: 40, oldest_spend_age_days: 2 },
    },
    baseSummaryVariants,
  );
  assert.match(out.subject, /יש זוכה ✓/);
  assert.match(out.html, /הגדל תקציב/);
  assert.match(out.html, /16/);
  assert.match(out.html, /עלות לליד/);
});

test('renderSummaryEmail NOT_VIABLE — amber band, two-truths copy', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    {
      verdict: 'WINNER_FOUND', winnerLabel: 'A', winnerName: 'התפתחות אישית', liftPct: 31,
      economic: { verdict: 'NOT_VIABLE', cr_leader_cpl: 28, target_cpl: 10, gap: 18, oldest_spend_age_days: 2 },
    },
    baseSummaryVariants,
  );
  assert.match(out.subject, /צריך לדבר על העלות/);
  assert.match(out.html, /איך להוזיל את הליד/);
  assert.match(out.html, /תובנת המסר שווה זהב/);
  assert.match(out.html, /המסר עצמו עובד/);
});

test('renderSummaryEmail WINNER_BUT_CHEAPER_ELSEWHERE — three-line output', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    {
      verdict: 'WINNER_FOUND', winnerLabel: 'C', winnerName: 'התפתחות נוסחה ב', liftPct: 22,
      economic: {
        verdict: 'WINNER_BUT_CHEAPER_ELSEWHERE',
        cr_leader_cpl: 18.8, cpl_leader_variant_id: 'A',
        cpl_leader_cpl: 16.5, target_cpl: 10, gap: 8.8, oldest_spend_age_days: 2,
      },
    },
    baseSummaryVariants,
  );
  assert.match(out.subject, /אבל וריאציה אחרת זולה יותר/);
  assert.match(out.html, /ניסוח מנצח/);
  assert.match(out.html, /עלות נמוכה יותר/);
});

test('renderSummaryEmail INSUFFICIENT_SPEND — show winner only + spend prompt', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    {
      verdict: 'WINNER_FOUND', winnerLabel: 'A', winnerName: 'התפתחות אישית', liftPct: 31,
      economic: { verdict: 'INSUFFICIENT_SPEND', spend_floor: 600, oldest_spend_age_days: 2 },
    },
    baseSummaryVariants,
  );
  assert.match(out.subject, /יש מנצח/);
  assert.match(out.html, /עדכן הוצאות/);
  assert.doesNotMatch(out.html, /הגדל תקציב/);
});

test('renderSummaryEmail INSUFFICIENT_DATA — same prompt-for-spend treatment', () => {
  const out = renderSummaryEmail(
    { name: 'Test', target_sample_size: 500 },
    {
      verdict: 'WINNER_FOUND', winnerLabel: 'A', winnerName: 'התפתחות אישית', liftPct: 31,
      economic: { verdict: 'INSUFFICIENT_DATA', reason: 'stale_spend', oldest_spend_age_days: 17 },
    },
    baseSummaryVariants,
  );
  assert.match(out.subject, /יש מנצח/);
  assert.match(out.html, /עדכן הוצאות/);
});
