// Tests for Piece 2A: the generation prompt must instruct Claude to wrap each
// event-row emoji GLYPH in its own data-editable="event_*_icon" span, parallel to
// the value spans — while keeping the "value span = PLAIN TEXT ONLY" clause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from './generate-lp.js';

const prompt = buildSystemPrompt('no_images', null);

test('prompt names all three icon keys', () => {
  assert.ok(prompt.includes('event_date_icon'), 'event_date_icon');
  assert.ok(prompt.includes('event_location_icon'), 'event_location_icon');
  assert.ok(prompt.includes('event_cost_icon'), 'event_cost_icon');
});

test('prompt keeps the three value keys', () => {
  assert.ok(prompt.includes('data-editable="event_date"'), 'event_date value key');
  assert.ok(prompt.includes('data-editable="event_location"'), 'event_location value key');
  assert.ok(prompt.includes('data-editable="event_cost"'), 'event_cost value key');
});

test('worked example shows the icon span wrapping ONLY the emoji, parallel to the value span', () => {
  // The example must demonstrate data-editable="event_date_icon">📅 next to data-editable="event_date">
  assert.ok(
    /data-editable="event_date_icon">📅/.test(prompt),
    'example wraps the 📅 glyph in an event_date_icon span'
  );
  assert.ok(
    /data-editable="event_date">/.test(prompt),
    'example still shows the event_date value span'
  );
});

test('icon spans hold emoji ONLY (instruction is explicit)', () => {
  assert.ok(
    /emoji ONLY|only the emoji|bare emoji|emoji glyph/i.test(prompt),
    'instructs that icon spans contain only the emoji glyph'
  );
});

test('the value-span PLAIN-TEXT-ONLY clause survives', () => {
  assert.ok(prompt.includes('PLAIN TEXT ONLY'), 'plain-text clause retained');
});
