// Task 1b: the dashboard PREVIEW must replace data-editable content with the SAME
// nesting-aware logic as the publish path (api/_lib/lp-renderer.js). We extract the
// ported lpReplaceEditable/lpFindMatchingClose/lpEscapeHtml helpers from dashboard.html
// and assert they behave identically to applyOverrides for the tricky nested cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyOverrides } from './_lib/lp-renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dash = readFileSync(join(__dirname, '..', 'dashboard.html'), 'utf8');

// Pull the three ported helper function bodies out of the dashboard <script> and eval
// them in an isolated sandbox so we exercise the ACTUAL shipped preview code.
function extractFn(name) {
  const start = dash.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `dashboard.html defines ${name}`);
  // Walk braces from the first { after the signature to find the function end.
  const braceStart = dash.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return dash.slice(start, i);
}

const src = [extractFn('lpEscapeHtml'), extractFn('lpFindMatchingClose'), extractFn('lpReplaceEditable')].join('\n');
// eslint-disable-next-line no-new-func
const factory = new Function(`${src}\nreturn { lpEscapeHtml, lpReplaceEditable };`);
const { lpReplaceEditable } = factory();

// Mirror applyOverrides for a single key using the dashboard helper.
function previewApply(html, key, value) {
  return lpReplaceEditable(html, key, value);
}

const cases = [
  ['<p data-editable="feature_1_text">old text</p>', 'feature_1_text', 'new text'],
  ['<h1 class="hero-title" data-editable="hero_title">בּיתְי <span>•</span> בית חי</h1>', 'hero_title', 'כותרת חדשה'],
  ['<span data-editable="event_location">תל אביב <small>(ליד התחנה)</small></span>', 'event_location', 'חיפה'],
  ['<div data-editable="story_text">פסקה ראשונה</p><p>פסקה שנייה</p></div>', 'story_text', 'סיפור חדש'],
  ['<div data-editable="x"><div>inner</div>tail</div>', 'x', 'Z'],
  ['<span data-editable="event_cost">חינם <small>(הערה)</small></span>', 'event_cost', ''],
  ['<p data-editable="x">a</p>', 'x', 'a <b> & "c"'],
];

test('dashboard preview helper matches publish-path applyOverrides on nested cases', () => {
  for (const [html, key, value] of cases) {
    const preview = previewApply(html, key, value);
    const publish = applyOverrides(html, [{ key, value }]);
    assert.equal(preview, publish, `mismatch for key=${key} value=${JSON.stringify(value)}`);
  }
});

test('dashboard no longer uses the old first-closing-tag preview regex', () => {
  // The legacy approach captured (<...data-editable...>)([\s\S]*?)(</[^>]+>) and
  // replaced with $1..$3 — which cut at the FIRST closing tag. It must be gone.
  assert.ok(
    !dash.includes('(<\\/[^>]+>)`, \'gi\''),
    'old non-greedy first-closing-tag preview regex removed'
  );
});
