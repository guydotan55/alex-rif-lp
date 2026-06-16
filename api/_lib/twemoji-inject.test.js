// Tests for Piece 3b: Twemoji injection inside buildInjectedScript().
// Twemoji renders every emoji as a consistent SVG across devices/fonts.
// HARD requirement: it must NEVER throw on /lp — guarded + try/catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInjectedScript } from './lp-renderer.js';

function build() {
  return buildInjectedScript(
    'proj-1', 'var-1', 'test-1',
    'anon-key', 'https://sb.example.co', true, '123456789'
  );
}

test('Twemoji CDN script is pinned (never @latest)', () => {
  const s = build();
  assert.ok(
    s.includes('https://cdn.jsdelivr.net/npm/@twemoji/api@17.0.3/dist/twemoji.min.js'),
    'pinned twemoji CDN src present'
  );
  assert.ok(!s.includes('@twemoji/api@latest'), 'must not use @latest');
  assert.ok(!s.includes('twemoji@latest'), 'must not use @latest');
});

test('img.emoji CSS is injected with the required rules', () => {
  const s = build();
  assert.ok(/img\.emoji\s*\{/.test(s), 'img.emoji selector present');
  assert.ok(s.includes('height:1em'), 'height:1em');
  assert.ok(s.includes('width:1em'), 'width:1em');
  assert.ok(s.includes('margin:0 .1em'), 'margin rule');
  assert.ok(s.includes('vertical-align:-0.1em'), 'vertical-align rule');
  assert.ok(s.includes('display:inline-block'), 'display rule');
});

test('__twemojiParse helper is guarded against missing window.twemoji and wrapped in try/catch', () => {
  const s = build();
  assert.ok(s.includes('window.__twemojiParse'), 'helper defined on window');
  // Guard: no-op if twemoji not loaded
  assert.ok(/typeof\s+window\.twemoji\s*===?\s*["']undefined["']/.test(s), 'guards on window.twemoji undefined');
  // try/catch wrapper present near the parse call
  assert.ok(s.includes('try {') && s.includes('catch'), 'has try/catch');
});

test('forces SVG rendering with pinned base + className', () => {
  const s = build();
  assert.ok(s.includes("folder:'svg'") || s.includes('folder: \'svg\''), "folder:'svg'");
  assert.ok(s.includes("ext:'.svg'") || s.includes("ext: '.svg'"), "ext:'.svg'");
  assert.ok(
    s.includes('https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/'),
    'pinned SVG asset base'
  );
  assert.ok(s.includes("className:'emoji'") || s.includes("className: 'emoji'"), "className:'emoji'");
});

test('__twemojiParse is called exactly three times (body, thankyou reveal, form fallback)', () => {
  const s = build();
  // Helper defined once on window.
  assert.ok(/window\.__twemojiParse\s*=/.test(s), 'helper defined on window once');
  // Exactly three invocation sites: __twemojiParse( ... )
  const invocations = (s.match(/__twemojiParse\s*\(/g) || []).length;
  assert.equal(invocations, 3, 'exactly three invocation sites');
});

test('body parse is the LAST statement of the analytics IIFE', () => {
  const s = build();
  // The IIFE ends with })(); — the body parse must be the final statement before it.
  const iifeEnd = s.lastIndexOf('})();');
  assert.ok(iifeEnd > 0, 'IIFE close found');
  const tail = s.slice(0, iifeEnd);
  const lastBodyParse = tail.lastIndexOf('__twemojiParse(document.body)');
  assert.ok(lastBodyParse > 0, 'document.body parse exists');
  // Nothing but whitespace/comments between the body parse and the IIFE close.
  const between = tail.slice(lastBodyParse).replace('__twemojiParse(document.body);', '');
  assert.ok(!/[a-zA-Z]\w*\s*\(/.test(between), 'no further statements after body parse before IIFE close');
});

test('thankyou reveal and form fallback each get a twemoji parse', () => {
  const s = build();
  // After the thank-you element is revealed (thankyouEl block) twemoji must re-parse it.
  assert.ok(/thankyouEl[\s\S]*?__twemojiParse\(/.test(s), 'parse after thankyou reveal');
  // After the form.innerHTML fallback, parse the form.
  assert.ok(/form\.innerHTML[\s\S]*?__twemojiParse\(/.test(s), 'parse after form.innerHTML fallback');
});

test('REGRESSION: supabase-js + lead_captured analytics remain intact', () => {
  const s = build();
  assert.ok(s.includes('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'), 'supabase-js still loaded');
  assert.ok(s.includes('lead_captured'), 'lead_captured event still fired');
  assert.ok(s.includes('supabase.createClient'), 'supabase client still created');
});
