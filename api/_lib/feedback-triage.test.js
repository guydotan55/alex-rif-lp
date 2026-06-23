import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampTriage, extractToolInput } from './feedback-triage.js';

// ---- clampTriage ----------------------------------------------------------

test('clamp: empty object → safe defaults', () => {
  const r = clampTriage({});
  assert.deepEqual(r, { summary: 'ללא סיכום', category: 'question', severity: 'medium' });
});

test('clamp: valid input passes through', () => {
  const r = clampTriage({ summary: 'הכפתור לא עובד', category: 'bug', severity: 'high' });
  assert.deepEqual(r, { summary: 'הכפתור לא עובד', category: 'bug', severity: 'high' });
});

test('clamp: number severity → medium', () => {
  assert.equal(clampTriage({ summary: 'x', category: 'bug', severity: 2 }).severity, 'medium');
});

test('clamp: object summary is coerced to a string, never throws', () => {
  const r = clampTriage({ summary: {}, category: 'bug', severity: 'low' });
  assert.equal(typeof r.summary, 'string');
});

test('clamp: unknown category → question', () => {
  assert.equal(clampTriage({ summary: 'x', category: 'spam', severity: 'low' }).category, 'question');
});

test('clamp: empty / whitespace summary → ללא סיכום', () => {
  assert.equal(clampTriage({ summary: '', category: 'bug', severity: 'low' }).summary, 'ללא סיכום');
  assert.equal(clampTriage({ summary: '   ', category: 'bug', severity: 'low' }).summary, 'ללא סיכום');
});

test('clamp: summary up to 600 chars is kept (2-3 debug sentences)', () => {
  const r = clampTriage({ summary: 'א'.repeat(500), category: 'bug', severity: 'low' });
  assert.equal(r.summary.length, 500); // under 600 → not truncated
});

test('clamp: summary >600 chars is sliced and …-suffixed', () => {
  const r = clampTriage({ summary: 'א'.repeat(800), category: 'bug', severity: 'low' });
  assert.equal(r.summary.length, 601);
  assert.ok(r.summary.endsWith('…'));
});

test('clamp: non-object input → all defaults', () => {
  assert.deepEqual(clampTriage(null), { summary: 'ללא סיכום', category: 'question', severity: 'medium' });
  assert.deepEqual(clampTriage('nope'), { summary: 'ללא סיכום', category: 'question', severity: 'medium' });
});

// ---- extractToolInput -----------------------------------------------------

test('extract: returns the record_triage tool input', () => {
  const msg = { content: [
    { type: 'text', text: 'ok' },
    { type: 'tool_use', name: 'record_triage', input: { summary: 's', category: 'bug', severity: 'low' } },
  ] };
  assert.deepEqual(extractToolInput(msg), { summary: 's', category: 'bug', severity: 'low' });
});

test('extract: no tool_use block → throws (the only throw)', () => {
  assert.throws(() => extractToolInput({ content: [{ type: 'text', text: 'no tool here' }] }));
});

test('extract: null/empty message → throws', () => {
  assert.throws(() => extractToolInput(null));
  assert.throws(() => extractToolInput({ content: [] }));
});
