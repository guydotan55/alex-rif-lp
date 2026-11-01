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
    document, URLSearchParams, console, editLoadSeq: 0, selectedProject: { id: 'p1' }, selectedVariant: { id: 'A' }, projectContent: [], pendingHealedHtml: null, dupInFlight: false,
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

test('duplicate action has synchronous re-entry guard and opens Edit-text', () => {
  assert.match(extractFn('renderVariantBar'), /btn-duplicate-variant/);
  const body = extractFn('duplicateVariant');
  assert.ok(body.indexOf('dupInFlight = true') < body.indexOf('await'));
  assert.match(body, /'duplicate-variant'/);
  assert.match(body, /switchTab\('edit'/);
});
test('duplicate locks typing, rejects re-entry, then selects copy', async () => {
  const { document } = parseHTML('<button id="btn-duplicate-variant"></button><div id="edit-fields"><input><textarea></textarea></div><button data-tab="edit"></button>');
  let resolveSession;
  const calls = [], tabs = [], toasts = [];
  const context = { document, console, dupInFlight: false, selectedProject: { id: 'p1' }, selectedVariant: { id: 'src', generated_html: '<p>x</p>' }, projectVariants: [],
    guardUnsaved: () => true, renderVariantBar: () => {}, variantErrorMessage: fn('variantErrorMessage'),
    sb: { auth: { getSession: () => new Promise(resolve => { resolveSession = resolve; }) } },
    fetch: async (_url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ variant: { id: 'copy' } }) }; },
    selectVariant: async id => { context.selectedVariant = { id }; }, switchTab: tab => tabs.push(tab), showToast: (...args) => toasts.push(args),
  };
  const duplicate = fn('duplicateVariant', context);
  const first = duplicate();
  assert.equal(context.dupInFlight, true);
  assert.ok(document.querySelector('input').disabled);
  await duplicate();
  resolveSession({ data: { session: { access_token: 'ok' } } });
  await first;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source_variant_id, 'src');
  assert.equal(context.selectedVariant.id, 'copy');
  assert.deepEqual(tabs, ['edit']);
  assert.equal(toasts[0][0], 'נוצר עותק! עכשיו שנו בו דבר אחד בלבד');
  assert.equal(context.dupInFlight, false);
  assert.equal(document.querySelector('input').disabled, false);
});
test('duplicate response after a project switch does not enter the new project', async () => {
  const { document } = parseHTML('<button id="btn-duplicate-variant"></button><div id="edit-fields"></div>');
  let resolveFetch;
  const context = { document, console, dupInFlight: false, selectedProject: { id: 'p1' }, selectedVariant: { id: 'src', generated_html: '<p>x</p>' }, projectVariants: [],
    guardUnsaved: () => true, renderVariantBar: () => {}, variantErrorMessage: fn('variantErrorMessage'),
    sb: { auth: { getSession: async () => ({ data: { session: { access_token: 'ok' } } }) } },
    fetch: () => new Promise(resolve => { resolveFetch = resolve; }),
    selectVariant: () => assert.fail('must not select across projects'), switchTab: () => assert.fail('must not switch tabs'), showToast: () => {},
  };
  const pending = fn('duplicateVariant', context)();
  await new Promise(setImmediate);
  context.selectedProject = { id: 'p2' };
  context.projectVariants = [];
  resolveFetch({ ok: true, json: async () => ({ variant: { id: 'copy' } }) });
  await pending;
  assert.equal(context.projectVariants.length, 0);
});

test('rename normalization trims and enforces 1..40 characters', () => {
  const normalize = fn('normalizeVariantName');
  assert.equal(normalize('  א  '), 'א');
  assert.equal(normalize(''), null);
  assert.equal(normalize('א'.repeat(41)), null);
  assert.equal(normalize('א'.repeat(40)), 'א'.repeat(40));
});
test('rename control is a sibling of active pill and clears state before awaiting', () => {
  const { document } = parseHTML('<div id="variant-bar"></div>');
  const variant = { id: 'v1', variant_name: 'name', status: 'draft' };
  fn('renderVariantBar', { document, projectVariants: [variant], selectedVariant: variant, renameState: null, dupInFlight: false,
    updateVariantBarVisibility: () => {}, variantDisplayLabel: fn('variantDisplayLabel'), esc: s => s,
  })();
  const pencil = document.querySelector('.variant-rename-btn');
  assert.ok(pencil);
  assert.equal(pencil.parentElement.id, 'variant-bar');
  assert.equal(pencil.previousElementSibling.classList.contains('variant-pill'), true);
  const body = extractFn('endRenameVariant');
  assert.ok(body.indexOf('renameState = null') < body.indexOf('await'));
  assert.match(body, /\.select\(\)/);
});
test('rename Enter then blur saves once; Escape then blur never saves', async () => {
  for (const commit of [true, false]) {
    const { document } = parseHTML('<input id="variant-rename-input" value="new">');
    let writes = 0;
    const variant = { id: 'v1', variant_name: 'old' };
    const context = { document, console, renameState: { id: 'v1', original: 'old' }, selectedVariant: variant, projectVariants: [variant],
      normalizeVariantName: fn('normalizeVariantName'), renderVariantBar: () => {}, showToast: () => {},
      sb: { from: () => ({ update: () => { writes++; return { eq: () => ({ select: async () => ({ data: [{ id: 'v1' }], error: null }) }) }; } }) },
    };
    const end = fn('endRenameVariant', context);
    const first = end(commit);
    await end(true);
    await first;
    assert.equal(writes, commit ? 1 : 0);
    assert.equal(variant.variant_name, commit ? 'new' : 'old');
  }
});
test('rename with no returned rows reverts and shows exact Hebrew failure', async () => {
  const { document } = parseHTML('<input id="variant-rename-input" value="new">');
  const toasts = [], variant = { id: 'v1', variant_name: 'old' };
  const context = { document, console, renameState: { id: 'v1', original: 'old' }, selectedVariant: variant, projectVariants: [variant],
    normalizeVariantName: fn('normalizeVariantName'), renderVariantBar: () => {}, showToast: (...args) => toasts.push(args),
    sb: { from: () => ({ update: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) }) },
  };
  await fn('endRenameVariant', context)(true);
  assert.equal(variant.variant_name, 'old');
  assert.equal(toasts[0][0], 'לא הצלחנו לשנות את השם. נסו שוב');
});

test('pending delete is filtered out of refetched lists', () => {
  const context = { pendingDelete: { variant: { id: 'gone' } } };
  const filter = fn('filterPending', context);
  assert.deepEqual(filter([{ id: 'keep' }, { id: 'gone' }]).map(v => v.id), ['keep']);
  context.pendingDelete = null;
  assert.equal(filter([{ id: 'gone' }]).length, 1);
});
test('delete uses a dedicated undo toast and flushes on project switch and pagehide', () => {
  assert.match(dash, /id="undo-toast"/);
  assert.match(dash, /pagehide['"],\s*\(\) => flushPendingDelete\(\{ keepalive: true \}\)/);
  const body = extractFn('flushPendingDelete');
  assert.ok(body.indexOf('pendingDelete = null') < body.indexOf("fetch('/api/admin'"));
  assert.match(extractFn('selectProject'), /flushPendingDelete\(/);
  assert.match(extractFn('selectProject'), /filterPending\(/);
});
function deletionContext() {
  const { document } = parseHTML('<div id="undo-toast" style="display:none"></div>');
  const original = { id: 'default', is_default: true, status: 'published' };
  const variant = { id: 'draft', status: 'draft', is_default: false };
  const requests = [], toasts = [], timers = [];
  const context = { document, console, selectedProject: { id: 'p1' }, selectedVariant: variant, projectVariants: [original, variant],
    pendingDelete: null, deleteStaging: false, guardUnsaved: () => true, variantErrorMessage: fn('variantErrorMessage'),
    renderVariantBar: () => {}, showToast: (...args) => toasts.push(args),
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => {},
    sb: { auth: { getSession: async () => ({ data: { session: { access_token: 'captured' } } }) } },
    selectVariant: async id => { context.selectedVariant = context.projectVariants.find(v => v.id === id); },
    fetch: (_url, opts) => { requests.push(opts); return Promise.resolve({ ok: true, json: async () => ({ ok: true }) }); },
  };
  context.flushPendingDelete = fn('flushPendingDelete', context);
  context.undoDeleteVariant = fn('undoDeleteVariant', context);
  return { context, requests, toasts, timers, variant };
}
test('stage then undo restores selection and position without any network request', async () => {
  const { context, requests, variant, timers } = deletionContext();
  await fn('stageDeleteVariant', context)();
  assert.equal(context.pendingDelete.variant.id, 'draft');
  assert.equal(context.pendingDelete.token, 'captured');
  assert.equal(context.projectVariants.length, 1);
  assert.equal(context.selectedVariant.id, 'default');
  await context.undoDeleteVariant();
  assert.equal(context.pendingDelete, null);
  assert.equal(context.projectVariants[1], variant);
  assert.equal(context.selectedVariant.id, 'draft');
  timers[0]();
  assert.equal(requests.length, 0);
});
test('delete staging blocks re-entry and abandons a changed selection after session await', async () => {
  const { context, requests } = deletionContext();
  let resolveSession;
  context.sb.auth.getSession = () => new Promise(resolve => { resolveSession = resolve; });
  const stage = fn('stageDeleteVariant', context);
  const first = stage();
  assert.equal(context.deleteStaging, true);
  await stage();
  context.selectedVariant = context.projectVariants[0];
  resolveSession({ data: { session: { access_token: 'ok' } } });
  await first;
  assert.equal(context.deleteStaging, false);
  assert.equal(context.pendingDelete, null);
  assert.equal(context.projectVariants.length, 2);
  assert.equal(requests.length, 0);
});
test('flush keepalive sends synchronously with captured project and token exactly once', async () => {
  const { context, requests } = deletionContext();
  await fn('stageDeleteVariant', context)();
  context.selectedProject = { id: 'other' };
  context.flushPendingDelete({ keepalive: true });
  assert.equal(context.pendingDelete, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].keepalive, true);
  assert.deepEqual(JSON.parse(requests[0].body), { action: 'delete-draft-variant', project_id: 'p1', variant_id: 'draft', access_token: 'captured' });
  context.flushPendingDelete();
  assert.equal(requests.length, 1);
});
for (const sameProject of [true, false]) test(`delete refusal restores only in matching project (${sameProject})`, async () => {
  const { context, toasts } = deletionContext();
  await fn('stageDeleteVariant', context)();
  context.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'has_data' }) });
  // The extracted function resolves fetch from this context at call time.
  if (!sameProject) { context.selectedProject = { id: 'other' }; context.projectVariants = []; }
  await context.flushPendingDelete();
  assert.equal(context.projectVariants.some(v => v.id === 'draft'), sameProject);
  assert.equal(toasts[0][0], errorMessages.has_data);
});

test('delete control appears only on the active non-default draft', () => {
  const { document } = parseHTML('<div id="variant-bar"></div>');
  const variant = { id: 'v1', variant_name: 'name', status: 'draft', is_default: false };
  const context = { document, projectVariants: [variant], selectedVariant: variant, renameState: null, dupInFlight: false,
    updateVariantBarVisibility: () => {}, variantDisplayLabel: fn('variantDisplayLabel'), esc: s => s,
  };
  const render = fn('renderVariantBar', context);
  render();
  assert.equal(document.querySelector('.variant-delete-btn').textContent, 'מחיקת טיוטה');
  variant.is_default = true;
  render();
  assert.equal(document.querySelector('.variant-delete-btn'), null);
  variant.is_default = false;
  variant.status = 'published';
  render();
  assert.equal(document.querySelector('.variant-delete-btn'), null);
});
test('starting another delete flushes the first and gives the second its own undo window', async () => {
  const { context, requests } = deletionContext();
  const stage = fn('stageDeleteVariant', context);
  await stage();
  const second = { id: 'draft2', status: 'draft', is_default: false };
  context.projectVariants.push(second);
  context.selectedVariant = second;
  await stage();
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].body).variant_id, 'draft');
  assert.equal(context.pendingDelete.variant.id, 'draft2');
  await context.undoDeleteVariant();
  assert.equal(context.selectedVariant.id, 'draft2');
  assert.equal(requests.length, 1);
});
test('delete expiry sends once and a network rejection restores the draft', async () => {
  const { context, timers, toasts } = deletionContext();
  await fn('stageDeleteVariant', context)();
  context.fetch = async () => { throw new Error('offline'); };
  await timers[0]();
  assert.equal(context.pendingDelete, null);
  assert.ok(context.projectVariants.some(v => v.id === 'draft'));
  assert.equal(toasts[0][0], 'משהו השתבש. נסו שוב בעוד רגע');
});
