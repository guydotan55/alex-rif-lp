// Tests for applyOverrides — the serve-side text replacer.
// Focus: replacing an editable element's content must respect the element's OWN
// closing tag, even when it contains nested tags (the headline-duplication bug).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverrides, buildInjectedScript } from './lp-renderer.js';

test('simple field: replaces content of a single-element editable', () => {
  const html = '<p data-editable="feature_1_text">old text</p>';
  const out = applyOverrides(html, [{ key: 'feature_1_text', value: 'new text' }]);
  assert.equal(out, '<p data-editable="feature_1_text">new text</p>');
});

test('nested different tag (headline with <span> bullet): replaces whole content, no leftover', () => {
  const html = '<h1 class="hero-title" data-editable="hero_title">בּיתְי <span>•</span> בית חי</h1>';
  const out = applyOverrides(html, [{ key: 'hero_title', value: 'כותרת חדשה' }]);
  assert.equal(out, '<h1 class="hero-title" data-editable="hero_title">כותרת חדשה</h1>');
});

test('nested <small> (event location): replaces whole value, leaves no orphaned tag', () => {
  const html = '<span data-editable="event_location">תל אביב <small>(ליד התחנה)</small></span>';
  const out = applyOverrides(html, [{ key: 'event_location', value: 'חיפה' }]);
  assert.equal(out, '<span data-editable="event_location">חיפה</span>');
  assert.ok(!out.includes('</small>'), 'no orphaned </small>');
});

test('multi-paragraph story_text (nested </p><p>): replaces entire block', () => {
  const html = '<div data-editable="story_text">פסקה ראשונה</p><p>פסקה שנייה</p></div>';
  const out = applyOverrides(html, [{ key: 'story_text', value: 'סיפור חדש' }]);
  assert.equal(out, '<div data-editable="story_text">סיפור חדש</div>');
});

test('nested SAME-name tag (div in div): matches the OUTER closing tag via depth', () => {
  const html = '<div data-editable="x"><div>inner</div>tail</div>';
  const out = applyOverrides(html, [{ key: 'x', value: 'Z' }]);
  assert.equal(out, '<div data-editable="x">Z</div>');
});

test('empty value hides the element (display:none) and clears nested content', () => {
  const html = '<span data-editable="event_cost">חינם <small>(הערה)</small></span>';
  const out = applyOverrides(html, [{ key: 'event_cost', value: '' }]);
  assert.equal(out, '<span data-editable="event_cost" style="display:none;"></span>');
});

test('escapes HTML special chars in the replacement value', () => {
  const html = '<p data-editable="x">a</p>';
  const out = applyOverrides(html, [{ key: 'x', value: 'a <b> & "c"' }]);
  assert.equal(out, '<p data-editable="x">a &lt;b&gt; &amp; &quot;c&quot;</p>');
});

test('replaces ALL elements carrying the same key', () => {
  const html = '<div data-editable="thankyou_text">a</div><div data-editable="thankyou_text">b</div>';
  const out = applyOverrides(html, [{ key: 'thankyou_text', value: 'thanks' }]);
  assert.equal(
    out,
    '<div data-editable="thankyou_text">thanks</div><div data-editable="thankyou_text">thanks</div>'
  );
});

test('does not touch a different editable element', () => {
  const html = '<h1 data-editable="hero_title">A</h1><p data-editable="hero_subtitle">B</p>';
  const out = applyOverrides(html, [{ key: 'hero_title', value: 'X' }]);
  assert.equal(out, '<h1 data-editable="hero_title">X</h1><p data-editable="hero_subtitle">B</p>');
});

test('footer_text fallback still wraps footer when no data-editable element exists', () => {
  const html = '<footer class="f">old footer</footer>';
  const out = applyOverrides(html, [{ key: 'footer_text', value: 'new footer' }]);
  assert.equal(out, '<footer class="f"><p>new footer</p></footer>');
});

test('unknown key leaves html unchanged', () => {
  const html = '<p data-editable="x">a</p>';
  const out = applyOverrides(html, [{ key: 'nope', value: 'b' }]);
  assert.equal(out, html);
});

test('numeric override value is stringified, does not throw a 500', () => {
  const html = '<p data-editable="event_cost">old</p>';
  // A numeric value (e.g. cost saved as a number) must not crash escapeHtml.
  let out;
  assert.doesNotThrow(() => {
    out = applyOverrides(html, [{ key: 'event_cost', value: 100 }]);
  });
  assert.equal(out, '<p data-editable="event_cost">100</p>');
});

test('boolean override value is stringified, does not throw', () => {
  const html = '<p data-editable="x">old</p>';
  let out;
  assert.doesNotThrow(() => {
    out = applyOverrides(html, [{ key: 'x', value: true }]);
  });
  assert.equal(out, '<p data-editable="x">true</p>');
});

// ── buildInjectedScript: per-project Meta Pixel injection ──────────────────
// (projectId, variantId, testId, anonKey, supabaseUrl, emailEnabled, metaPixelId)
const injectArgs = (pixel) => ['proj-1', 'var-1', null, 'anon-key', 'https://sb.example.co', true, pixel];

test('injects the per-project Meta Pixel id when one is provided', () => {
  const out = buildInjectedScript(...injectArgs('37738239499108437'));
  assert.ok(out.includes("fbq('init', '37738239499108437')"), 'inits the given pixel');
  assert.ok(out.includes("fbq('track', 'PageView')"), 'fires PageView on load');
  assert.ok(out.includes("fbq('track', 'CompleteRegistration'"), 'fires CompleteRegistration on submit');
});

test('CAPI payload carries project_id so the server can resolve the right token', () => {
  const out = buildInjectedScript(...injectArgs('37738239499108437'));
  assert.ok(out.includes('project_id: PROJECT_ID'), 'CAPI body includes project_id');
  assert.ok(out.includes('action: "meta_capi"'));
});

test('different projects render different pixels — nothing hardcoded to one customer', () => {
  const kili = buildInjectedScript(...injectArgs('37738239499108437'));
  const lipaz = buildInjectedScript(...injectArgs('1435123421262484'));
  assert.ok(kili.includes("fbq('init', '37738239499108437')"));
  assert.ok(lipaz.includes("fbq('init', '1435123421262484')"));
  assert.ok(!kili.includes('1435123421262484'), 'kili page carries no trace of the lipaz pixel');
});

test('no pixel id => no Meta Pixel snippet at all', () => {
  const out = buildInjectedScript(...injectArgs(''));
  assert.ok(!out.includes('fbq('), 'no fbq calls');
  assert.ok(!out.includes('connect.facebook.net'), 'no pixel library loaded');
});

// ── lead capture: contact fields + metadata catch-all + fail-loud ──────────
// Regression for the dropped-leads bug: forms collect first_name/last_name/phone,
// but the old code sent a non-existent `name`/`phone` shape and fired
// lead_captured even when the insert failed — so phone submissions vanished.
const leadScript = () => buildInjectedScript('proj-1', 'var-1', null, 'anon-key', 'https://sb.example.co', true, '');

test('reads first_name / last_name / phone from the form into dedicated fields', () => {
  const out = leadScript();
  assert.ok(out.includes(`input[name="first_name"]`), 'reads first_name');
  assert.ok(out.includes(`input[name="last_name"]`), 'reads last_name');
  assert.ok(out.includes(`input[name="phone"]`) && out.includes(`input[type="tel"]`), 'reads phone (name or tel)');
  assert.ok(out.includes('leadData.first_name'), 'maps first_name to a column');
  assert.ok(out.includes('leadData.last_name'), 'maps last_name to a column');
  assert.ok(out.includes('leadData.phone'), 'maps phone to a column');
});

test('no longer sends a legacy `name` field (column does not exist)', () => {
  const out = leadScript();
  assert.ok(!out.includes('leadData.name'), 'legacy name assignment removed');
  assert.ok(!out.includes(`querySelector('input[name="name"]')`), 'no name selector');
});

test('sweeps any other named field into the metadata jsonb catch-all', () => {
  const out = leadScript();
  assert.ok(out.includes('var metadata = {}'), 'builds a metadata object');
  assert.ok(out.includes('input[name], select[name], textarea[name]'), 'scans all named fields');
  assert.ok(out.includes('leadData.metadata = metadata'), 'attaches metadata to the lead');
  assert.ok(/RESERVED\s*=\s*{[^}]*first_name[^}]*}/.test(out), 'dedicated columns are excluded from metadata');
});

test('FAIL LOUD: on insert error, shows a retry message and does NOT fire lead_captured', () => {
  const out = leadScript();
  // The lead_captured call must come AFTER the error guard returns, so a failed
  // insert can never reach it.
  const errGuard = out.indexOf('if (result.error)');
  const showErr = out.indexOf('showLeadError();'); // the CALL, not the declaration
  const tracked = out.indexOf(`trackEvent("lead_captured"`);
  assert.ok(errGuard !== -1, 'has an error guard on the insert result');
  assert.ok(showErr !== -1 && showErr > errGuard, 'surfaces an error UI inside the guard');
  assert.ok(tracked > errGuard, 'lead_captured fires only after the error guard');
  // The error guard returns before the success path.
  assert.ok(/if \(result\.error\) \{[\s\S]*showLeadError\(\);[\s\S]*return;[\s\S]*\}/.test(out), 'error guard returns early');
});

test('error message is human Hebrew copy, not a stack trace, and re-enables retry', () => {
  const out = leadScript();
  assert.ok(out.includes('אופס'), 'friendly Hebrew error copy');
  assert.ok(out.includes('submitBtn.disabled = false'), 're-enables the submit button for retry');
  assert.ok(out.includes('role", "alert"') || out.includes(`setAttribute("role", "alert")`), 'error is announced to assistive tech');
});
