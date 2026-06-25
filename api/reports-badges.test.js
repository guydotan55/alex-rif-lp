// The /reports ticket card shows the signals in a decluttered form: two labeled
// chips (חומרה / דחיפות) + a quiet category tag, with STATUS turned into a cue
// (a "needs-you" dot / dimmed-done / "לבדיקה ידנית") instead of a confusing
// "סווג" word. We pull the ACTUAL shipped functions out of reports.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseHTML } from 'linkedom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'reports.html'), 'utf8');
function extractFn(name) {
  const s = html.indexOf('function ' + name + '(');
  assert.ok(s !== -1, 'reports.html defines ' + name);
  const b = html.indexOf('{', s); let d = 0, i = b;
  for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (d === 0) { i++; break; } } }
  return html.slice(s, i);
}
function render(t) {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const make = new Function('document', extractFn('renderFeedbackTicketCard') + '\nreturn renderFeedbackTicketCard;');
  return make(document)(t);
}
const matchesStatusFilter = new Function(extractFn('matchesStatusFilter') + '\nreturn matchesStatusFilter;')();

// ---------- the two chips that matter ----------

test('severity renders as a labeled "חומרה" chip', () => {
  const card = render({ id: '1', status: 'TRIAGED', severity: 'high', summary: 's', body: 'b' });
  assert.ok(card.textContent.includes('חומרה'), 'has the severity label');
  assert.ok(card.textContent.includes('גבוה'), 'has the value');
});

test('urgency renders as a labeled "דחיפות" chip', () => {
  const card = render({ id: '2', status: 'TRIAGED', user_urgency: 'annoying', summary: 's', body: 'b' });
  assert.ok(card.textContent.includes('דחיפות'), 'has the urgency label');
  assert.ok(card.textContent.includes('מעצבן'), 'has the value');
});

test('category renders as a quiet .cat tag', () => {
  const card = render({ id: '7', status: 'TRIAGED', category: 'bug', summary: 's', body: 'b' });
  const cat = card.querySelector('.cat');
  assert.ok(cat && cat.textContent === 'באג', 'quiet category tag with the Hebrew label');
});

// ---------- status as a cue, not a "סווג" word ----------

test('the confusing "סווג" word is gone; a new/triaged ticket shows the needs-you dot', () => {
  const card = render({ id: '3', status: 'TRIAGED', summary: 's', body: 'b' });
  assert.ok(!card.textContent.includes('סווג'), 'no "סווג" text');
  assert.ok(card.querySelector('.needdot'), 'shows the needs-you dot');
});

test('a NEEDS_TRIAGE ticket also shows the needs-you dot', () => {
  const card = render({ id: '3b', status: 'NEEDS_TRIAGE', summary: 's', body: 'b' });
  assert.ok(card.querySelector('.needdot'));
});

test('a resolved ticket is dimmed and marked טופל, with no needs-you dot', () => {
  const card = render({ id: '4', status: 'RESOLVED', summary: 's', body: 'b' });
  assert.ok(card.classList.contains('done'), 'card is dimmed (.done)');
  assert.ok(card.textContent.includes('טופל'), 'marked טופל');
  assert.equal(card.querySelector('.needdot'), null, 'no needs-you dot when done');
});

test('a READ ticket shows the quiet "בטיפול" marker and no dot', () => {
  const card = render({ id: '5', status: 'READ', summary: 's', body: 'b' });
  assert.ok(card.textContent.includes('בטיפול'), 'in-progress marker');
  assert.equal(card.querySelector('.needdot'), null, 'no needs-you dot once read');
});

test('a triage-failed ticket shows "לבדיקה ידנית" and no AI severity chip', () => {
  const card = render({ id: '6', status: 'TRIAGE_FAILED', severity: 'high', user_urgency: 'blocking', body: 'b' });
  assert.ok(card.textContent.includes('לבדיקה ידנית'), 'manual-review flag');
  assert.ok(!card.textContent.includes('חומרה'), 'no AI severity label when triage failed');
  assert.ok(card.textContent.includes('דחיפות'), 'user urgency still shown');
  assert.ok(card.querySelector('.needdot'), 'still needs you');
});

// ---------- simplified status filter ----------

test('the "NEW" filter groups NEEDS_TRIAGE + TRIAGED (both = "waiting for you")', () => {
  assert.equal(matchesStatusFilter('NEEDS_TRIAGE', 'NEW'), true);
  assert.equal(matchesStatusFilter('TRIAGED', 'NEW'), true);
  assert.equal(matchesStatusFilter('READ', 'NEW'), false);
  assert.equal(matchesStatusFilter('RESOLVED', 'NEW'), false);
});

test('ALL matches everything; a specific status matches only itself', () => {
  assert.equal(matchesStatusFilter('RESOLVED', 'ALL'), true);
  assert.equal(matchesStatusFilter('READ', 'READ'), true);
  assert.equal(matchesStatusFilter('TRIAGE_FAILED', 'TRIAGE_FAILED'), true);
  assert.equal(matchesStatusFilter('READ', 'RESOLVED'), false);
});
