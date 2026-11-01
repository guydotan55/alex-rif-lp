import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
const dash = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
function extractFn(name) {
  let start = dash.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `dashboard defines ${name}`);
  if (dash.slice(start - 6, start) === 'async ') start -= 6;
  const braceStart = dash.indexOf('{', dash.indexOf(')', start));
  let depth = 0;
  for (let i = braceStart; i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    if (dash[i] === '}' && --depth === 0) return dash.slice(start, i + 1);
  }
  assert.fail(`Unclosed function ${name}`);
}
function fn(name, context = {}) {
  return vm.runInNewContext(`(${extractFn(name)})`, context);
}

test('variant labels match copy naming, including renamed defaults', () => {
  const label = fn('variantDisplayLabel');
  assert.equal(label({ is_default: true, variant_name: 'Default' }), 'הדף הראשי');
  assert.equal(label({ is_default: true, variant_name: null }), 'הדף הראשי');
  assert.equal(label({ is_default: false, variant_name: null, variant_slug: 'b' }), 'b');
  assert.equal(label({ is_default: true, variant_name: 'Main page' }), 'Main page');
});
test('bar sits above tabs, and selecting or adding refreshes every scoped view', () => {
  assert.ok(dash.indexOf('id="variant-bar"') < dash.indexOf('class="tabs-bar"'));
  assert.match(extractFn('selectVariant'), /loadImageSlots/);
  assert.match(extractFn('showAddVariantModal'), /await selectVariant\(data.id\)/);
  assert.match(extractFn('switchTab'), /updateVariantBarVisibility/);
  assert.match(extractFn('renderVariantBar'), /updateVariantBarVisibility/);
});
test('late Edit-text load A cannot replace newer B fields or content', async () => {
  const { document } = parseHTML('<div id="edit-fields"></div>');
  const resolvers = {};
  const context = {
    document, URLSearchParams, console, editLoadSeq: 0, selectedProject: { id: 'p1' }, selectedVariant: { id: 'A' }, projectContent: [], pendingHealedHtml: null,
    sb: { auth: { getSession: async () => ({ data: { session: { access_token: 'ok' } } }) } },
    fetch: url => new Promise(resolve => { resolvers[new URL('https://local/' + url).searchParams.get('variant_id')] = resolve; }),
    renderEditField: item => `<input value="${item.value}">`,
  };
  const load = fn('loadEditableContent', context);
  const a = load();
  await new Promise(setImmediate);
  context.selectedVariant = { id: 'B' };
  const b = load();
  await new Promise(setImmediate);
  resolvers.B({ ok: true, json: async () => [{ key: 'hero_title', value: 'B value' }] });
  await b;
  resolvers.A({ ok: true, json: async () => [{ key: 'hero_title', value: 'A value' }] });
  await a;
  assert.match(document.getElementById('edit-fields').innerHTML, /B value/);
  assert.equal(context.projectContent[0].value, 'B value');
});
test('late image load A cannot replace newer B images', async () => {
  const { document } = parseHTML('<div id="image-slots-list"></div>');
  const resolvers = {};
  const context = { document, imgLoadSeq: 0, selectedProject: { id: 'p1' }, selectedVariant: { id: 'A' },
    sb: { from: () => ({ select: () => ({ eq: (_key, id) => new Promise(resolve => { resolvers[id] = resolve; }) }) }) },
  };
  const load = fn('loadImageSlots', context);
  const a = load();
  context.selectedVariant = { id: 'B' };
  const b = load();
  resolvers.B({ data: [{ slot: 'hero', image_url: '/B.jpg' }] });
  await b;
  resolvers.A({ data: [{ slot: 'hero', image_url: '/A.jpg' }] });
  await a;
  assert.match(document.getElementById('image-slots-list').innerHTML, /\/B.jpg/);
  assert.doesNotMatch(document.getElementById('image-slots-list').innerHTML, /\/A.jpg/);
});

const errorMessages = {
  not_found: 'הדף הזה נמחק — רעננו את העמוד',
  has_data: 'אי אפשר למחוק — לדף הזה כבר יש נתונים',
  not_draft: 'הדף הזה כבר מפורסם, אז אי אפשר למחוק אותו',
  is_default: 'את הדף הראשי אי אפשר למחוק',
  wrong_project: 'אין לכם גישה לדף הזה',
  empty_source: 'אין עדיין מה לשכפל — קודם צריך ליצור את הדף',
  slug_exhausted: 'הרבה אנשים משכפלים עכשיו. נסו שוב בעוד כמה שניות',
  copy_failed: 'השכפול לא הצליח. שום דבר לא השתנה — אפשר לנסות שוב',
};
test('variant errors use every exact Hebrew string and status fallback', () => {
  const message = fn('variantErrorMessage');
  for (const [code, text] of Object.entries(errorMessages)) assert.equal(message(code), text);
  assert.equal(message(undefined, 401), 'פג תוקף ההתחברות — התחברו מחדש');
  assert.equal(message('not_found', 401), 'פג תוקף ההתחברות — התחברו מחדש');
  assert.equal(message(undefined, 403), 'אין לכם גישה לפרויקט הזה. פנו למנהל/ת');
  assert.equal(message('wrong_project', 403), errorMessages.wrong_project);
  for (const code of ['missing_fields', 'server_error', 'network', undefined]) {
    assert.equal(message(code), 'משהו השתבש. נסו שוב בעוד רגע');
    assert.match(message(code), /[֐-׿]/);
    assert.doesNotMatch(message(code), /[A-Za-z]/);
  }
});
test('unsaved guard blocks only user actions and offers discard', () => {
  const toasts = [];
  const context = { editDirty: true, showToast: (...args) => toasts.push(args) };
  const guard = fn('guardUnsaved', context);
  assert.equal(guard(), false);
  assert.equal(toasts[0][0], 'יש שינויים שלא נשמרו — שמרו או בטלו אותם קודם');
  context.editDirty = false;
  assert.equal(guard(), true);
  assert.doesNotMatch(extractFn('selectVariant'), /guardUnsaved/);
  assert.match(extractFn('onVariantPillClick'), /guardUnsaved/);
  assert.match(extractFn('renderVariantBar'), /onVariantPillClick\(/);
  assert.match(extractFn('showAddVariantModal'), /guardUnsaved/);
  assert.match(extractFn('clearEditField'), /editDirty = true/);
  assert.match(extractFn('loadEditableContent').slice(0, 450), /editDirty = false/);
  assert.match(dash, /id="btn-discard-content"[^>]*onclick="loadEditableContent\(\)"/);
});
test('save and publish paths map errors and verify publish affected a row', () => {
  for (const name of ['saveContent', 'togglePublish']) {
    assert.doesNotMatch(extractFn(name), /'שגיאה: ' \+/);
    assert.match(extractFn(name), /variantErrorMessage/);
  }
  assert.match(extractFn('togglePublish'), /\.update\(\{ status: newStatus \}\)[\s\S]*?\.select\(\)/);
});
test('publish with zero returned variants changes neither local nor project status', async () => {
  const btn = { disabled: false };
  const calls = [], toasts = [];
  const variant = { id: 'v1', status: 'draft' };
  const context = { selectedProject: { id: 'p1', status: 'draft' }, selectedVariant: variant, document: { getElementById: () => btn }, console,
    variantErrorMessage: fn('variantErrorMessage'), showToast: (...args) => toasts.push(args),
    sb: { from: table => { calls.push(table); return { update: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) }; } },
  };
  await fn('togglePublish', context)();
  assert.equal(variant.status, 'draft');
  assert.deepEqual(calls, ['project_variants']);
  assert.equal(toasts[0][0], errorMessages.not_found);
  assert.equal(btn.disabled, false);
});
