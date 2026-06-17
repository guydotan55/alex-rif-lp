// Tests for Piece 2B: healEventHooks — auto-heal un-hooked single-event LPs by
// wrapping each event-row VALUE in a data-editable="event_*" span.
//
// SAFETY-CRITICAL gate: single-vs-multi is decided by COUNTING 📅 date-emoji
// occurrences in the parsed DOM — NOT class names. ==1 heal, ==0 / >=2 bail
// byte-identical. Bail/no-heal must return the ORIGINAL string untouched.
//
// parser is injected: node passes linkedom's DOMParser, the browser passes its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { healEventHooks } from './heal-event-hooks.js';
import { S1, S2, S3, S4, S5, MULTI, FALSE_POSITIVE, FULL_DECOY } from './heal-event-hooks.fixtures.js';

const parser = new DOMParser();

// Removing the injected event spans must yield the EXACT original string — the
// byte-faithfulness invariant that lets us write a healed LP back onto /lp/* safely.
function unwrapEventSpans(html) {
  return html.replace(/<span data-editable="event_(?:date|location|cost)">([\s\S]*?)<\/span>/g, '$1');
}

// --- helpers ---------------------------------------------------------------

// Extract the inner text of a data-editable="key" span from a healed HTML string.
function innerOf(html, key) {
  const re = new RegExp(`data-editable="${key}"[^>]*>([\\s\\S]*?)</span>`, 'i');
  const m = re.exec(html);
  return m ? m[1] : null;
}

function reparse(html, key) {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
  return doc.querySelector(`[data-editable="${key}"]`);
}

// --- GATE -------------------------------------------------------------------

test('GATE: ==0 date-emoji → no event block → healed:false, byte-identical', () => {
  const r = healEventHooks(FALSE_POSITIVE, parser);
  assert.equal(r.healed, false);
  assert.equal(r.html, FALSE_POSITIVE, 'byte-identical');
  assert.equal(r.reason, 'no-event-block');
});

test('GATE: >=2 date-emoji (multi-event) → BAIL healed:false, byte-identical', () => {
  const r = healEventHooks(MULTI, parser);
  assert.equal(r.healed, false);
  assert.equal(r.html, MULTI, 'byte-identical');
  assert.equal(r.reason, 'multi-event');
});

// --- HEAL each single-event structure --------------------------------------

for (const [name, fixture] of [['S1', S1], ['S2', S2], ['S4', S4], ['S5', S5]]) {
  test(`HEAL ${name}: wraps date value, strips emoji+label, healed:true`, () => {
    const r = healEventHooks(fixture, parser);
    assert.equal(r.healed, true, 'healed');
    const dateInner = innerOf(r.html, 'event_date');
    assert.ok(dateInner != null, 'event_date span exists');
    assert.ok(!dateInner.includes('<'), 'date inner has no nested markup');
    assert.ok(!dateInner.includes('📅'), 'leading emoji stripped from value');
    assert.ok(!/מתי/.test(dateInner), 'label stripped from value');
    assert.ok(dateInner.trim().length > 0, 'value non-empty');
  });

  test(`HEAL ${name}: wraps location + cost values too`, () => {
    const r = healEventHooks(fixture, parser);
    const loc = innerOf(r.html, 'event_location');
    const cost = innerOf(r.html, 'event_cost');
    assert.ok(loc != null && !loc.includes('<') && !/איפה/.test(loc), 'location wrapped, label stripped, no markup');
    assert.ok(cost != null && !cost.includes('<') && !/עלות/.test(cost), 'cost wrapped, label stripped, no markup');
  });
}

test('HEAL S1: leading value run wrapped, trailing <br>/markup stays OUTSIDE the span', () => {
  const r = healEventHooks(S1, parser);
  // date value is "9.7.2026" with a trailing <br>בשעה 20:00 that must remain outside.
  assert.equal(innerOf(r.html, 'event_date').trim(), '9.7.2026');
  // The trailing markup is preserved in the document.
  assert.ok(r.html.includes('<br>בשעה 20:00') || r.html.includes('<br>\nבשעה 20:00') || r.html.includes('בשעה 20:00'), 'trailing text preserved');
  // The trailing <br> is not swallowed into the span.
  const dateEl = reparse(r.html, 'event_date');
  assert.ok(dateEl && !dateEl.querySelector('br'), 'no <br> inside the date span');
});

test('HEAL S4: cost row uses 🎁 gift emoji and still heals', () => {
  const r = healEventHooks(S4, parser);
  assert.equal(innerOf(r.html, 'event_cost').trim(), 'הכניסה חופשית');
  assert.ok(!r.html.includes('data-editable="event_cost">🎁'), 'gift emoji not inside cost value');
});

test('COST VARIETY: each cost glyph in the known set heals the cost row', () => {
  for (const glyph of ['🎟️', '🎫', '💫', '✨', '💰', '💵', '🎁']) {
    const fixture = S2.replace('🎟️', glyph);
    const r = healEventHooks(fixture, parser);
    assert.equal(r.healed, true, `cost glyph ${glyph} heals`);
    assert.ok(innerOf(r.html, 'event_cost') != null, `cost wrapped for ${glyph}`);
  }
});

test('COST FALLBACK: an OFF-LIST cost glyph still heals via third-detail-row fallback', () => {
  // 🏷️ is not in COST_EMOJIS — the cost row must be found as the third row.
  const fixture = S4.replace('🎁', '🏷️');
  const r = healEventHooks(fixture, parser);
  assert.equal(r.healed, true, 'healed via fallback');
  assert.ok(innerOf(r.html, 'event_cost') != null, 'cost still wrapped');
  assert.equal(innerOf(r.html, 'event_cost').trim(), 'הכניסה חופשית');
});

// --- IDEMPOTENT + PARTIAL ---------------------------------------------------

test('IDEMPOTENT: already-hooked LP (S3) → healed:false, byte-identical', () => {
  const r = healEventHooks(S3, parser);
  assert.equal(r.healed, false, 'nothing to heal');
  assert.equal(r.html, S3, 'byte-identical when all rows already hooked');
});

test('IDEMPOTENT: re-running heal on healed output is a no-op (byte-identical second pass)', () => {
  const first = healEventHooks(S2, parser);
  assert.equal(first.healed, true);
  const second = healEventHooks(first.html, parser);
  assert.equal(second.healed, false, 'second pass finds nothing to heal');
  assert.equal(second.html, first.html, 'second pass byte-identical');
});

test('PARTIAL: only un-hooked rows get hooked; pre-existing hook + its trailing <small> preserved', () => {
  // Take S3 (all hooked) and un-hook ONLY the date row, leaving location (with <small>) hooked.
  const partial = S3.replace(
    '<span><strong>מתי:</strong> <span data-editable="event_date">11/6/2026</span></span>',
    '<span><strong>מתי:</strong> 11/6/2026</span>'
  );
  const r = healEventHooks(partial, parser);
  assert.equal(r.healed, true, 'date row healed');
  assert.equal(innerOf(r.html, 'event_date').trim(), '11/6/2026');
  // The already-hooked location with its trailing <small> must be untouched.
  assert.ok(r.html.includes('data-editable="event_location">מרחב בִּיתְי, סמטאות יפו</span> <small'), 'location hook + trailing <small> preserved');
});

// --- VALIDITY GUARD ---------------------------------------------------------

test('VALIDITY GUARD: if heal would produce unbalanced markup, return ORIGINAL html healed:false', () => {
  // A row whose value run contains a stray "<" that can't be safely wrapped.
  // The guard re-parses; if span count is unbalanced it must revert to original.
  const broken = `<div class="event-details">
    <div class="event-detail">
      <div class="event-detail-icon">📅</div>
      <div><strong>מתי:</strong> 15.7.2026</div>
    </div>
  </div>`;
  // Sanity: this one is healable; the guard should NOT trip here.
  const ok = healEventHooks(broken, parser);
  assert.equal(ok.healed, true, 'well-formed row still heals (guard does not over-trip)');
  // Balanced spans: every data-editable opening span has a matching close.
  const opens = (ok.html.match(/<span data-editable="event_/g) || []).length;
  const closes = (ok.html.match(/<\/span>/g) || []).length;
  assert.ok(closes >= opens, 'no unbalanced editable spans');
});

test('regression: healed output round-trips through the parser without error', () => {
  for (const f of [S1, S2, S4, S5]) {
    const r = healEventHooks(f, parser);
    assert.equal(r.healed, true);
    const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${r.html}</body></html>`, 'text/html');
    assert.ok(doc.querySelector('[data-editable="event_date"]'), 'date hook parseable');
  }
});

// --- The case the trimmed fixtures missed: a FULL document where a decorative
// --- emoji from the cost set (✨) precedes the event block. This reproduces the
// --- live-data corruption the review panel caught.
test('FULL DOC, decorative ✨ before the event block: event_cost lands on the REAL cost row, not the offering heading', () => {
  const r = healEventHooks(FULL_DECOY, new DOMParser());
  assert.equal(r.healed, true);
  assert.equal(innerOf(r.html, 'event_cost'), 'הכניסה חופשית');
  assert.ok(!/data-editable="event_cost">רוח/.test(r.html), 'must NOT hook the offering heading "רוח והעשרה..."');
  assert.equal(innerOf(r.html, 'event_date'), '11.6.2026');
  assert.equal(innerOf(r.html, 'event_location'), 'מרחב בִּתְאָ, סמטאות יפו');
});

test('FULL DOC heal is byte-faithful: unwrap spans === original, and <head><style> is untouched', () => {
  const r = healEventHooks(FULL_DECOY, new DOMParser());
  assert.equal(unwrapEventSpans(r.html), FULL_DECOY);
  assert.ok(
    r.html.includes('<style>.offering-icon{content:"״";background:url("data:image/svg+xml,%3Csvg/%3E")}</style>'),
    '<style> block (quotes + entities) preserved byte-for-byte'
  );
});

for (const [name, fx] of [['S1', S1], ['S2', S2], ['S4', S4], ['S5', S5]]) {
  test(`byte-faithful (${name}): unwrapping the injected spans equals the original`, () => {
    const r = healEventHooks(fx, new DOMParser());
    assert.equal(r.healed, true);
    assert.equal(unwrapEventSpans(r.html), fx);
  });
}

test('value duplicated elsewhere on the page: heal hooks the EVENT occurrence (first at/after 📅), leaving the duplicates untouched, byte-faithfully', () => {
  const html =
    `<!DOCTYPE html><html><head><meta name="x" content="11.6.2026"></head><body>` +
    `<div class="event-details">` +
    `<div class="event-detail-card"><div class="detail-icon">📅</div><div class="detail-label">מתי</div><div class="detail-value">11.6.2026</div></div>` +
    `<div class="event-detail-card"><div class="detail-icon">📍</div><div class="detail-label">איפה</div><div class="detail-value">חיפה</div></div>` +
    `<div class="event-detail-card"><div class="detail-icon">🎁</div><div class="detail-label">עלות</div><div class="detail-value">הכניסה חופשית</div></div>` +
    `</div>` +
    `<div class="cta-micro">הכניסה חופשית! שריינו 11.6.2026</div>` + // date + cost duplicated, no 📅
    `</body></html>`;
  const r = healEventHooks(html, new DOMParser());
  assert.equal(r.healed, true);
  // All three event fields hook the EVENT cells (date appears in <meta> + a cta badge;
  // cost appears in the cta badge too — neither suppresses nor mis-targets the hook).
  assert.equal(innerOf(r.html, 'event_date'), '11.6.2026');
  assert.equal(innerOf(r.html, 'event_location'), 'חיפה');
  assert.equal(innerOf(r.html, 'event_cost'), 'הכניסה חופשית');
  // The duplicates outside the event block are left untouched.
  assert.ok(r.html.includes('<meta name="x" content="11.6.2026">'), 'meta duplicate untouched');
  assert.ok(r.html.includes('<div class="cta-micro">הכניסה חופשית! שריינו 11.6.2026</div>'), 'cta badge duplicate untouched');
  assert.equal(unwrapEventSpans(r.html), html, 'byte-faithful');
});

test('every wrapped value span contains plain text only (no nested markup)', () => {
  const r = healEventHooks(FULL_DECOY, new DOMParser());
  for (const key of ['event_date', 'event_location', 'event_cost']) {
    const inner = innerOf(r.html, key);
    assert.ok(inner != null && !inner.includes('<'), `${key} inner is plain text`);
  }
});

// One event value CONTAINS another (cost is a substring of the date). Per-row
// anchoring + the advancing cursor must NOT nest the cost span inside the date span.
test('NESTING GUARD: when one event value is a substring of another, spans never nest; byte-faithful', () => {
  const html =
    `<!DOCTYPE html><html><body><div class="event-details">` +
    `<div class="event-detail-card"><div class="detail-icon">📅</div><div class="detail-label">מתי</div><div class="detail-value">5 שקלים ביוני</div></div>` +
    `<div class="event-detail-card"><div class="detail-icon">📍</div><div class="detail-label">איפה</div><div class="detail-value">יפו</div></div>` +
    `<div class="event-detail-card"><div class="detail-icon">🎁</div><div class="detail-label">עלות</div><div class="detail-value">5 שקלים</div></div>` +
    `</div></body></html>`;
  const r = healEventHooks(html, new DOMParser());
  assert.equal(r.healed, true);
  assert.equal(innerOf(r.html, 'event_date'), '5 שקלים ביוני');
  assert.equal(innerOf(r.html, 'event_cost'), '5 שקלים');
  assert.ok(!/data-editable="event_[a-z]+">\s*<span data-editable/.test(r.html), 'no nested editable span');
  assert.equal(unwrapEventSpans(r.html), html, 'byte-faithful (no nesting, nothing else touched)');
});

// A decoy duplicate of the location value sits in a subtitle BETWEEN the date and
// location rows. Anchoring on the location row's own 📍 must hook the real cell.
test('DECOY GUARD: a value duplicated in text between rows is not hooked; per-row emoji anchors to the real cell', () => {
  const html =
    `<!DOCTYPE html><html><body><div class="event-details">` +
    `<div class="event-detail-card"><div class="detail-icon">📅</div><div class="detail-label">מתי</div><div class="detail-value">11.6.2026</div></div>` +
    `<p class="subtitle">האירוע יתקיים ב תל אביב</p>` +
    `<div class="event-detail-card"><div class="detail-icon">📍</div><div class="detail-label">איפה</div><div class="detail-value">תל אביב</div></div>` +
    `<div class="event-detail-card"><div class="detail-icon">🎁</div><div class="detail-label">עלות</div><div class="detail-value">חינם</div></div>` +
    `</div></body></html>`;
  const r = healEventHooks(html, new DOMParser());
  assert.equal(r.healed, true);
  assert.equal(innerOf(r.html, 'event_location'), 'תל אביב');
  assert.ok(r.html.includes('<p class="subtitle">האירוע יתקיים ב תל אביב</p>'), 'decoy subtitle untouched');
  assert.equal(unwrapEventSpans(r.html), html, 'byte-faithful');
});
