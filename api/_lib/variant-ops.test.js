import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSlug, pickName, duplicateVariant, deleteDraftVariant } from './variant-ops.js';

const letters = [...'abcdefghijklmnopqrstuvwxyz'];
for (const [slugs, opts, expected] of [
  [['default'], undefined, 'a'],
  [['default', 'a', 'b'], undefined, 'c'],
  [[...letters, 'v1', 'v3'], undefined, 'v2'],
  [['a'], { random: true, rng: () => 0 }, 'b'],
  [['a'], { random: true, rng: () => 0.9999 }, 'z'],
  [letters, { random: true, rng: () => 0.9999 }, 'v20'],
]) test(`pickSlug chooses ${expected} from ${slugs}`, () => assert.equal(pickSlug(slugs, opts), expected));

for (const [source, names, expected] of [
  [{ variant_name: 'Default', variant_slug: 'default', is_default: true }, [], 'הדף הראשי – עותק'],
  [{ variant_name: 'גרסה מקורית', variant_slug: 'default', is_default: true }, [], 'גרסה מקורית – עותק'],
  [{ variant_name: null, variant_slug: 'b', is_default: false }, [], 'b – עותק'],
  [{ variant_name: null, variant_slug: 'b', is_default: false }, ['b – עותק'], 'b – עותק 2'],
]) test(`pickName chooses ${expected}`, () => assert.equal(pickName(source, names), expected));

test('pickName truncates the base, preserving the suffix', () => {
  const name = pickName({ variant_name: 'א'.repeat(60) }, []);
  assert.ok(Array.from(name).length <= 40);
  assert.ok(name.endsWith(' – עותק'));
});

test('pickName preserves an emoji straddling the old UTF-16 cut point', () => {
  const suffix = ' – עותק';
  const base = 'א'.repeat(40 - Array.from(suffix).length - 1) + '😀' + 'ב'.repeat(20);
  const name = pickName({ variant_name: base }, []);
  assert.doesNotThrow(() => encodeURIComponent(name));
  assert.equal(decodeURIComponent(encodeURIComponent(name)), name);
  assert.ok(name.endsWith('😀' + suffix));
  assert.equal(Array.from(name).length, 40);
});

test('pickName counts emoji as code points for both plain and numbered suffixes', () => {
  const source = { variant_name: '😀'.repeat(60) };
  const first = pickName(source, []);
  const second = pickName(source, [first]);
  for (const [name, suffix] of [[first, ' – עותק'], [second, ' – עותק 2']]) {
    assert.equal(name, '😀'.repeat(40 - Array.from(suffix).length) + suffix);
    assert.equal(Array.from(name).length, 40);
    assert.doesNotThrow(() => encodeURIComponent(name));
  }
});

process.env.SUPABASE_URL = 'https://sb.test.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
const source = { id: 'src', project_id: 'p1', variant_slug: 'default', variant_name: 'Default', is_default: true, generated_html: '<p>original</p>' };
const image = { slot: 'hero', image_url: 'https://image.test/a', source: 'upload', source_meta: { key: 1 }, enabled: false, display_size: 'small', display_shape: 'circle' };
const text = { key: 'hero_title', value: 'hello' };
function duplicateRouter(url, opts) {
  const method = opts.method || 'GET';
  if (url.includes('project_variants?id=eq.src')) return { json: [source] };
  if (url.includes('project_variants?project_id=')) return { json: [source] };
  if (url.endsWith('/project_variants') && method === 'POST') return { json: [{ id: 'new', ...JSON.parse(opts.body) }] };
  if (url.includes('lp_image_content') && method === 'GET') return { json: [image] };
  if (url.includes('lp_editable_content') && method === 'GET') return { json: [text] };
  return { json: [] };
}
async function withFetch(router, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', opts });
    const r = await router(String(url), opts);
    return { ok: r?.ok !== false, status: r?.status || 200, json: async () => r?.json ?? [], text: async () => r?.text || '' };
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}
const duplicate = (extra = {}) => duplicateVariant({ projectId: 'p1', sourceVariantId: 'src', sleep: async () => {}, rng: () => 0, ...extra });
const inserts = calls => calls.filter(c => c.url.endsWith('/project_variants') && c.method === 'POST');

test('duplicate happy path copies HTML, every image field and text into the new draft', async () => {
  await withFetch(duplicateRouter, async calls => {
    const r = await duplicate();
    assert.equal(r.status, 200);
    assert.equal(r.body.variant.id, 'new');
    assert.deepEqual(JSON.parse(inserts(calls)[0].opts.body), {
      project_id: 'p1', variant_slug: 'a', variant_name: 'הדף הראשי – עותק', generated_html: source.generated_html, status: 'draft', is_default: false,
    });
    for (const [table, row] of [['lp_image_content', image], ['lp_editable_content', text]]) {
      const write = calls.find(c => c.url.includes(table) && c.method === 'POST');
      assert.deepEqual(JSON.parse(write.opts.body), [{ project_id: 'p1', variant_id: 'new', ...row }]);
    }
  });
});
test('duplicate with no text rows skips text POST', async () => {
  await withFetch((url, opts) => url.includes('lp_editable_content') ? { json: [] } : duplicateRouter(url, opts), async calls => {
    assert.equal((await duplicate()).status, 200);
    assert.equal(calls.filter(c => c.url.includes('lp_editable_content') && c.method === 'POST').length, 0);
  });
});
for (const [label, response, status, error] of [
  ['foreign source', { json: [{ ...source, project_id: 'OTHER' }] }, 403, 'wrong_project'],
  ['missing source', { json: [] }, 404, 'not_found'],
  ['empty HTML', { json: [{ ...source, generated_html: '  ' }] }, 400, 'empty_source'],
  ['source GET non-ok', { ok: false, status: 500 }, 500, 'server_error'],
]) test(`duplicate refuses ${label}`, async () => {
  await withFetch((url, opts) => url.includes('id=eq.src') ? response : duplicateRouter(url, opts), async calls => {
    assert.deepEqual(await duplicate(), { status, body: { error } });
    assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  });
});
test('slug conflict retries with fresh slugs, different slug and jitter', async () => {
  let n = 0, sleeps = [];
  await withFetch((url, opts) => {
    if (url.endsWith('/project_variants') && opts.method === 'POST' && ++n === 1) return { ok: false, status: 409, json: { code: '23505' } };
    if (url.includes('?project_id=') && n) return { json: [source, { variant_slug: 'a', variant_name: 'הדף הראשי – עותק' }] };
    return duplicateRouter(url, opts);
  }, async calls => {
    assert.equal((await duplicate({ sleep: async ms => sleeps.push(ms) })).status, 200);
    assert.deepEqual(inserts(calls).map(c => JSON.parse(c.opts.body).variant_slug), ['a', 'b']);
    assert.equal(JSON.parse(inserts(calls)[1].opts.body).variant_name, 'הדף הראשי – עותק 2');
    assert.deepEqual(sleeps, [20]);
  });
});
test('409 with 23503 is an ordinary server error, never retried', async () => {
  await withFetch((url, opts) => url.endsWith('/project_variants') && opts.method === 'POST'
    ? { ok: false, status: 409, json: { code: '23503' } } : duplicateRouter(url, opts), async calls => {
    assert.deepEqual(await duplicate(), { status: 500, body: { error: 'server_error' } });
    assert.equal(inserts(calls).length, 1);
  });
});
test('10 conflicts exhaust the slug retries', async () => {
  await withFetch((url, opts) => url.endsWith('/project_variants') && opts.method === 'POST'
    ? { ok: false, status: 409, json: { code: '23505' } } : duplicateRouter(url, opts), async calls => {
    assert.deepEqual(await duplicate(), { status: 409, body: { error: 'slug_exhausted' } });
    assert.equal(inserts(calls).length, 10);
  });
});
for (const mode of ['image', 'text', 'rejected fetch', 'rollback fails']) test(`child copy rollback: ${mode}`, async () => {
  const orig = console.error, logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    await withFetch((url, opts) => {
      if (url.includes(mode === 'text' ? 'lp_editable_content' : 'lp_image_content') && opts.method === 'POST') {
        if (mode === 'rejected fetch') throw new Error('connection lost');
        return { ok: false, status: 500 };
      }
      if (opts.method === 'DELETE' && mode === 'rollback fails') return { ok: false, status: 500 };
      return duplicateRouter(url, opts);
    }, async calls => {
      assert.deepEqual(await duplicate(), { status: 500, body: { error: 'copy_failed' } });
      assert.ok(calls.some(c => c.method === 'DELETE' && c.url.includes('project_variants?id=eq.new')));
      if (mode === 'rollback fails') assert.ok(logs.some(l => l.includes('new')));
    });
  } finally { console.error = orig; }
});

const draft = { id: 'v1', project_id: 'p1', status: 'draft', is_default: false };
function deleteRouter(url, opts) {
  if (url.includes('/project_variants')) return { json: [draft] };
  return { json: [] };
}
const deleteDraft = () => deleteDraftVariant({ projectId: 'p1', variantId: 'v1' });
for (const [label, row, error, status] of [
  ['missing', null, 'not_found', 404],
  ['foreign', { ...draft, project_id: 'OTHER' }, 'wrong_project', 403],
  ['default', { ...draft, is_default: true }, 'is_default', 409],
  ['published', { ...draft, status: 'published' }, 'not_draft', 409],
]) test(`delete refuses ${label}`, async () => {
  await withFetch(() => ({ json: row ? [row] : [] }), async calls => {
    assert.deepEqual(await deleteDraft(), { status, body: { error } });
    assert.equal(calls.filter(c => c.method === 'DELETE').length, 0);
  });
});
for (const table of ['leads', 'analytics_events', 'test_variants']) test(`delete refuses rows in ${table}`, async () => {
  await withFetch((url, opts) => url.includes(`/${table}?`) ? { json: [{ id: 'data' }] } : deleteRouter(url, opts), async calls => {
    assert.deepEqual(await deleteDraft(), { status: 409, body: { error: 'has_data' } });
    assert.equal(calls.filter(c => c.method === 'DELETE').length, 0);
  });
});
test('clean draft deletes conditionally with representation', async () => {
  await withFetch(deleteRouter, async calls => {
    assert.deepEqual(await deleteDraft(), { status: 200, body: { ok: true } });
    const deletes = calls.filter(c => c.method === 'DELETE');
    assert.equal(deletes.length, 1);
    for (const part of ['id=eq.v1', 'project_id=eq.p1', 'status=eq.draft', 'is_default=eq.false']) assert.ok(deletes[0].url.includes(part));
    assert.equal(deletes[0].opts.headers.Prefer, 'return=representation');
  });
});
test('draft published between check and delete is refused', async () => {
  await withFetch((url, opts) => opts.method === 'DELETE' ? { json: [] } : deleteRouter(url, opts), async () => {
    assert.deepEqual(await deleteDraft(), { status: 409, body: { error: 'not_draft' } });
  });
});
for (const [table, mode] of [['test_variants', 'non-ok'], ['leads', 'object'], ['analytics_events', 'reject'], ['project_variants', 'non-ok'], ['project_variants', 'object']]) {
  test(`delete fails closed for ${table} ${mode}`, async () => {
    await withFetch((url, opts) => {
      if (url.includes(`/${table}?`)) {
        if (mode === 'reject') throw new Error('network');
        return mode === 'non-ok' ? { ok: false, status: 500 } : { json: { error: 'bad response' } };
      }
      return deleteRouter(url, opts);
    }, async calls => {
      assert.deepEqual(await deleteDraft(), { status: 500, body: { error: 'server_error' } });
      assert.equal(calls.filter(c => c.method === 'DELETE').length, 0);
    });
  });
}
