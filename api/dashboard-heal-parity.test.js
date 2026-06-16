// Task 6: the dashboard's inlined healEventHooks (browser DOMParser) must behave
// like the tested module api/_lib/heal-event-hooks.js — same 📅 gate and same value
// extraction. We extract the dashboard's heal helpers and run them with linkedom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DOMParser } from 'linkedom';
import { S1, S2, S4, S5, MULTI, FALSE_POSITIVE } from './_lib/heal-event-hooks.fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dash = readFileSync(join(__dirname, '..', 'dashboard.html'), 'utf8');

// Grab the contiguous heal block (consts + functions) from the dashboard script.
function sliceBetween(startMarker, endMarker) {
  const a = dash.indexOf(startMarker);
  const b = dash.indexOf(endMarker, a);
  assert.ok(a !== -1 && b !== -1, `markers found: ${startMarker} / ${endMarker}`);
  return dash.slice(a, b);
}

const healSrc = sliceBetween('const HEAL_DATE_EMOJI', '// ── Preview Tab');
// eslint-disable-next-line no-new-func
const factory = new Function('DOMParser', `${healSrc}\nreturn { healEventHooks };`);
const { healEventHooks } = factory(DOMParser);

const parser = new DOMParser();

function innerOf(html, key) {
  const re = new RegExp(`data-editable="${key}"[^>]*>([\\s\\S]*?)</span>`, 'i');
  const m = re.exec(html);
  return m ? m[1] : null;
}

test('dashboard heal: GATE 0 📅 → no-event-block, healed:false', () => {
  const r = healEventHooks(FALSE_POSITIVE, parser);
  assert.equal(r.healed, false);
  assert.equal(r.reason, 'no-event-block');
});

test('dashboard heal: GATE >=2 📅 → multi-event BAIL byte-identical', () => {
  const r = healEventHooks(MULTI, parser);
  assert.equal(r.healed, false);
  assert.equal(r.reason, 'multi-event');
  assert.equal(r.html, MULTI, 'byte-identical bail');
});

for (const [name, fixture, expDate, expCost] of [
  ['S1', S1, '9.7.2026', '100 ש״ח'],
  ['S2', S2, '15.7.2026', 'הכניסה חופשית, אך מותנית ברישום מראש'],
  ['S4', S4, '11.6.2026', 'הכניסה חופשית'],
  ['S5', S5, '9/7/2025 בשעה 20:00', '100 ש״ח (אירוע בוטיק)'],
]) {
  test(`dashboard heal ${name}: hooks date+location+cost like the module`, () => {
    const r = healEventHooks(fixture, parser);
    assert.equal(r.healed, true);
    assert.equal(innerOf(r.html, 'event_date').trim(), expDate);
    assert.equal(innerOf(r.html, 'event_cost').trim(), expCost);
    assert.ok(!innerOf(r.html, 'event_date').includes('<'), 'no nested markup in value');
    assert.ok(innerOf(r.html, 'event_location') != null, 'location hooked');
  });
}
