// EXECUTION tests for the injected LP form-capture script.
//
// The other suite (lp-renderer.test.js) only string-matches the generated source.
// These tests actually RUN the generated IIFE against a minimal DOM/supabase stub
// and dispatch a real submit, so the behaviours the dropped-leads fix guarantees
// are proven at runtime — and a future refactor that breaks them fails here even
// if the source still contains the matched substrings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInjectedScript } from './lp-renderer.js';

// Pull out the form/analytics IIFE (the inline <script> block that talks to leads).
function extractFormScript() {
  const out = buildInjectedScript('proj-1', 'var-1', null, 'anon-key', 'https://sb.example.co', true, '');
  const blocks = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const body = blocks.find(b => b.includes('sb.from("leads")'));
  assert.ok(body, 'found the leads form-handler script block');
  return body;
}

// A field factory mimicking the bits of a DOM input/select the script reads.
// hasAttribute('value') is true only when the field was given an explicit value
// attribute (_valueAttr) — mirrors a real DOM checkbox (bare checkbox => "on", no attr).
function field(o) {
  const f = Object.assign(
    { tagName: 'INPUT', type: 'text', name: '', value: '', checked: false, disabled: false, multiple: false, selectedOptions: [] },
    o
  );
  f.hasAttribute = (a) => (a === 'value' ? !!o._valueAttr : false);
  return f;
}

// Run the IIFE with stubs, then return a submit() that dispatches the captured handler.
function bootstrap({ fields, leadResult, thankyouEl = null }) {
  const inserts = [];
  let uid = 0;
  const byId = {};

  const byName = (n) => fields.find((f) => f.name === n) || null;
  const byType = (t) => fields.find((f) => f.type === t) || null;
  const submitBtn = { tagName: 'BUTTON', disabled: false };

  const form = {
    tagName: 'FORM', style: {}, innerHTML: '', _handlers: {},
    addEventListener(ev, fn) { this._handlers[ev] = fn; },
    appendChild(el) { if (el && el.id) byId[el.id] = el; },
    querySelector(sel) {
      if (sel.includes('name="first_name"')) return byName('first_name');
      if (sel.includes('name="last_name"')) return byName('last_name');
      if (sel.includes('name="phone"') || sel.includes('type="tel"')) return byName('phone') || byType('tel');
      if (sel.includes('name="email"') || sel.includes('type="email"')) return byName('email') || byType('email');
      if (sel.includes('type="submit"') || sel.includes('button')) return submitBtn;
      return null;
    },
    querySelectorAll() { return fields.filter((f) => f.name); }, // only called with the named-field selector
  };
  byId['lp-email-form'] = form;

  const documentStub = {
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => (sel.includes('thankyou_text') ? thankyouEl : sel === 'form' ? form : null),
    createElement: () => ({ id: '', style: {}, textContent: '', setAttribute() {}, appendChild() {} }),
    addEventListener() {},
    body: {},
    referrer: '',
  };

  let nextLeadResult = leadResult;
  const sb = {
    from(table) {
      return {
        insert(row) {
          inserts.push({ table, row });
          if (table === 'leads') {
            return nextLeadResult === 'reject' ? Promise.reject(new Error('network down')) : Promise.resolve(nextLeadResult);
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  const env = {
    supabase: { createClient: () => sb },
    document: documentStub,
    window: { location: { href: 'http://test/' } },
    navigator: { userAgent: 'node-test' },
    crypto: { randomUUID: () => 'uuid-' + uid++ },
    localStorage: (() => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })(),
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    IntersectionObserver: class { observe() {} disconnect() {} },
    console: { error() {}, log() {} },
    __twemojiParse: () => {},
    fbq: () => {},
  };

  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  new Function(...names, extractFormScript())(...names.map((n) => env[n]));

  const handler = form._handlers.submit;
  assert.ok(typeof handler === 'function', 'submit handler was registered');

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const submit = () => handler({ preventDefault() {} });
  const leadInserts = () => inserts.filter((i) => i.table === 'leads');
  const leadCapturedFired = () => inserts.some((i) => i.table === 'analytics_events' && i.row.event_type === 'lead_captured');

  return { inserts, leadInserts, leadCapturedFired, submit, flush, form, submitBtn, byId };
}

const baseFields = () => [
  field({ type: 'email', name: 'email', value: 'a@b.com' }),
  field({ type: 'text', name: 'first_name', value: 'Dana' }),
  field({ type: 'text', name: 'last_name', value: 'Cohen' }),
  field({ type: 'tel', name: 'phone', value: '050-1234567' }),       // matched via input[type=tel]
  field({ type: 'checkbox', name: 'newsletter', value: 'on', checked: true }),
  field({ type: 'text', name: 'comment', value: 'hi there' }),       // → metadata
  field({ type: 'hidden', name: 'utm_source', value: 'fb' }),        // → skipped (control type)
];

test('SUCCESS: builds the right payload (dedicated cols + metadata) and fires lead_captured', async () => {
  const h = bootstrap({ fields: baseFields(), leadResult: { error: null } });
  h.submit();
  await h.flush();

  assert.equal(h.leadInserts().length, 1, 'exactly one leads insert');
  const row = h.leadInserts()[0].row;
  assert.equal(row.email, 'a@b.com');
  assert.equal(row.project_id, 'proj-1');
  assert.equal(row.source, 'lp-builder');
  assert.equal(row.variant_id, 'var-1');
  assert.equal(row.first_name, 'Dana');
  assert.equal(row.last_name, 'Cohen');
  assert.equal(row.phone, '050-1234567'); // phone captured via type="tel"
  assert.deepEqual(row.metadata, { newsletter: true, comment: 'hi there' }, 'checkbox→true, stray field kept, hidden skipped');
  assert.ok(!('utm_source' in row.metadata), 'hidden input excluded');
  assert.ok(!('email' in row.metadata), 'reserved column excluded from metadata');
  assert.ok(h.leadCapturedFired(), 'lead_captured fires on success');
});

test('FAIL LOUD: insert {error} → no lead_captured, error shown, submit re-enabled', async () => {
  const h = bootstrap({ fields: baseFields(), leadResult: { error: { message: 'column does not exist' } } });
  h.submit();
  await h.flush();

  assert.equal(h.leadInserts().length, 1, 'insert was attempted');
  assert.ok(!h.leadCapturedFired(), 'lead_captured must NOT fire on a failed insert');
  assert.ok(h.byId['lp-lead-error'], 'error element was rendered');
  assert.match(h.byId['lp-lead-error'].textContent, /אופס/, 'human Hebrew retry message');
  assert.equal(h.submitBtn.disabled, false, 'submit re-enabled so the visitor can retry');
});

test('FAIL LOUD: promise rejection (network) → no lead_captured, error shown', async () => {
  const h = bootstrap({ fields: baseFields(), leadResult: 'reject' });
  h.submit();
  await h.flush();
  assert.ok(!h.leadCapturedFired(), 'rejected insert does not count as a lead');
  assert.ok(h.byId['lp-lead-error'], 'error surfaced on rejection');
});

test('double-submit guard: two submits while in flight → only one leads row', async () => {
  const h = bootstrap({ fields: baseFields(), leadResult: { error: null } });
  h.submit();
  h.submit(); // second fires before the first resolves
  await h.flush();
  assert.equal(h.leadInserts().length, 1, 'in-flight guard blocked the duplicate insert');
});

test('checkbox GROUP (same name) accumulates into an array, not last-wins', async () => {
  const fields = [
    field({ type: 'email', name: 'email', value: 'a@b.com' }),
    field({ type: 'checkbox', name: 'interests', value: 'music', checked: true, _valueAttr: true }),
    field({ type: 'checkbox', name: 'interests', value: 'art', checked: true, _valueAttr: true }),
    field({ type: 'checkbox', name: 'interests', value: 'sport', checked: false, _valueAttr: true }),
  ];
  const h = bootstrap({ fields, leadResult: { error: null } });
  h.submit();
  await h.flush();
  const row = h.leadInserts()[0].row;
  assert.deepEqual(row.metadata.interests, ['music', 'art'], 'both checked values kept; unchecked omitted');
});

test('phone matched via type="tel" under a non-"phone" name is NOT also duplicated in metadata', async () => {
  const fields = [
    field({ type: 'email', name: 'email', value: 'a@b.com' }),
    field({ type: 'tel', name: 'mobile', value: '050-9999999' }), // matched by input[type=tel]
  ];
  const h = bootstrap({ fields, leadResult: { error: null } });
  h.submit();
  await h.flush();
  const row = h.leadInserts()[0].row;
  assert.equal(row.phone, '050-9999999', 'tel field captured into the phone column');
  assert.ok(!row.metadata || !('mobile' in row.metadata), 'not duplicated into metadata under its own name');
});

test('explicit checkbox value="on" is preserved, not collapsed to boolean true', async () => {
  const fields = [
    field({ type: 'email', name: 'email', value: 'a@b.com' }),
    field({ type: 'checkbox', name: 'plan', value: 'on', checked: true, _valueAttr: true }),
  ];
  const h = bootstrap({ fields, leadResult: { error: null } });
  h.submit();
  await h.flush();
  assert.equal(h.leadInserts()[0].row.metadata.plan, 'on', 'explicit value="on" kept verbatim');
});

test('email-only form still works (no phone/name inputs present)', async () => {
  const fields = [field({ type: 'email', name: 'email', value: 'solo@x.com' })];
  const h = bootstrap({ fields, leadResult: { error: null } });
  h.submit();
  await h.flush();
  const row = h.leadInserts()[0].row;
  assert.equal(row.email, 'solo@x.com');
  assert.ok(!('phone' in row), 'no phone key when no phone field');
  assert.ok(!('metadata' in row), 'no metadata key when nothing extra to capture');
  assert.ok(h.leadCapturedFired());
});

test('oversized free-text metadata never blocks the lead (value trimmed, lead still saves)', async () => {
  const fields = [
    field({ type: 'email', name: 'email', value: 'a@b.com' }),
    field({ tagName: 'TEXTAREA', type: 'textarea', name: 'story', value: 'x'.repeat(10000) }),
  ];
  const h = bootstrap({ fields, leadResult: { error: null } });
  h.submit();
  await h.flush();
  assert.equal(h.leadInserts().length, 1, 'lead still inserted despite oversized field');
  const row = h.leadInserts()[0].row;
  assert.equal(row.email, 'a@b.com', 'the real lead value is preserved');
  if (row.metadata && 'story' in row.metadata) {
    assert.ok(row.metadata.story.length <= 2000, 'oversized value was trimmed, not sent whole');
  }
  assert.ok(JSON.stringify(row.metadata || {}).length <= 9000, 'metadata stays under the server cap');
});
