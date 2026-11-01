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
