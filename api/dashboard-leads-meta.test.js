// Tests formatLeadMeta() — the helper that renders a lead's custom (metadata)
// fields into the new "פרטים נוספים" column. Extracts the ACTUAL source from
// dashboard.html (no duplication) and exercises the formatting + XSS wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');

const start = html.indexOf('function formatLeadMeta(');
assert.ok(start !== -1, 'formatLeadMeta is defined in dashboard.html');
const end = html.indexOf('\nfunction ', start + 1);
assert.ok(end !== -1 && end > start, 'found end of formatLeadMeta');
const src = html.slice(start, end);
// eslint-disable-next-line no-new-func
const { formatLeadMeta } = new Function(src + '\nreturn { formatLeadMeta };')();

test('no custom fields → em dash', () => {
  assert.equal(formatLeadMeta({}), '—');
  assert.equal(formatLeadMeta(null), '—');
  assert.equal(formatLeadMeta(undefined), '—');
});

test('a ticked checkbox (stored as true) shows the field name + ✓', () => {
  assert.equal(formatLeadMeta({ consent: true }), 'consent: ✓');
});

test('a string value is shown verbatim after the field name', () => {
  assert.equal(formatLeadMeta({ note: 'hi there' }), 'note: hi there');
});

test('an array (multi-select / checkbox group) is comma-joined', () => {
  assert.equal(formatLeadMeta({ interests: ['music', 'art'] }), 'interests: music, art');
});

test('multiple fields are key-sorted and separated by " · "', () => {
  assert.equal(formatLeadMeta({ b: 'y', a: 'x' }), 'a: x · b: y');
});

test('the leads cell escapes formatLeadMeta output (metadata is untrusted public-form input)', () => {
  // The rendered <td> must wrap the helper in esc() so a malicious field name/value
  // can't inject HTML. (formatLeadMeta returns raw text; the cell escapes it.)
  assert.ok(/esc\(\s*formatLeadMeta\(/.test(html), 'metadata cell renders as esc(formatLeadMeta(...))');
});
