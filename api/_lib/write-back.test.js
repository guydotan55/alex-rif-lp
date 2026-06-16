// Tests for the write-back guard folded into save-content.js (Task 5).
// The PATCH of project_variants.generated_html must be a no-op when the healed
// HTML equals what is already stored, and must fire exactly once otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWriteBackRequest, shouldWriteBack } from './write-back.js';

test('isWriteBackRequest: true only when both variant_id and healed_html present', () => {
  assert.equal(isWriteBackRequest({ variant_id: 'v', healed_html: '<x>' }), true);
  assert.equal(isWriteBackRequest({ variant_id: 'v' }), false);
  assert.equal(isWriteBackRequest({ healed_html: '<x>' }), false);
  assert.equal(isWriteBackRequest({}), false);
  assert.equal(isWriteBackRequest(null), false);
  assert.equal(isWriteBackRequest({ variant_id: 'v', healed_html: '' }), false, 'empty html is not a write-back');
});

test('shouldWriteBack: false (no-op) when healed equals stored', () => {
  assert.equal(shouldWriteBack('<html>same</html>', '<html>same</html>'), false);
});

test('shouldWriteBack: true when healed differs from stored', () => {
  assert.equal(shouldWriteBack('<html>old</html>', '<html>new</html>'), true);
});

test('shouldWriteBack: false when healed is empty/nullish (never blank out stored html)', () => {
  assert.equal(shouldWriteBack('<html>x</html>', ''), false);
  assert.equal(shouldWriteBack('<html>x</html>', null), false);
  assert.equal(shouldWriteBack('<html>x</html>', undefined), false);
});

test('shouldWriteBack: true when stored is null/empty but healed has content', () => {
  assert.equal(shouldWriteBack(null, '<html>new</html>'), true);
  assert.equal(shouldWriteBack('', '<html>new</html>'), true);
});
