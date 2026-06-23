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
