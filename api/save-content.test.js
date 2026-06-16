// Endpoint tests for the healed-HTML write-back folded into save-content.js (Task 5).
// We stub globalThis.fetch to control auth (verifyUser / getUserRole) + the variant
// row + the PATCH, asserting: unauthorized -> 401/403, no-op when equal, single PATCH
// on the happy path.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://sb.test.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'svc';

const { default: handler } = await import('./save-content.js');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end() { return this; },
  };
}

// Build a fetch stub from a routing function (url, opts) -> { ok, status, json }.
function withFetch(router, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', opts });
    const r = router(String(url), opts) || {};
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.json ?? [],
      text: async () => r.text ?? '',
    };
  };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = orig; });
}

// A router that authenticates successfully as super_admin.
function authOkRouter(extra) {
  return (url, opts) => {
    if (url.includes('/auth/v1/user')) return { json: { id: 'u1', email: 'a@b.co' } };
    if (url.includes('/user_roles')) return { json: [{ role: 'super_admin' }] };
    return extra(url, opts);
  };
}

test('write-back UNAUTHORIZED (no token) -> 401', async () => {
  await withFetch(() => ({}), async () => {
    const req = { method: 'POST', headers: {}, body: { project_id: 'p1', variant_id: 'v1', healed_html: '<x>new</x>' } };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  });
});

test('write-back UNAUTHORIZED (invalid token) -> 401', async () => {
  await withFetch((url) => {
    if (url.includes('/auth/v1/user')) return { ok: false, status: 401 };
    return {};
  }, async () => {
    const req = { method: 'POST', headers: { authorization: 'Bearer bad' }, body: { project_id: 'p1', variant_id: 'v1', healed_html: '<x>new</x>' } };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  });
});

test('write-back NO-OP when healed_html equals stored -> 200 written:false, NO PATCH', async () => {
  const STORED = '<html>same</html>';
  await withFetch(authOkRouter((url) => {
    if (url.includes('/project_variants') ) return { json: [{ generated_html: STORED, project_id: 'p1' }] };
    return {};
  }), async (calls) => {
    const req = { method: 'POST', headers: { authorization: 'Bearer ok' }, body: { project_id: 'p1', variant_id: 'v1', healed_html: STORED } };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.written, false);
    const patches = calls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 0, 'no PATCH on no-op');
  });
});

test('write-back HAPPY PATH -> single PATCH, 200 written:true', async () => {
  const STORED = '<html>old</html>';
  const HEALED = '<html>new with hooks</html>';
  await withFetch(authOkRouter((url, opts) => {
    if (url.includes('/project_variants') && (opts.method || 'GET') === 'GET') {
      return { json: [{ generated_html: STORED, project_id: 'p1' }] };
    }
    if (url.includes('/project_variants') && opts.method === 'PATCH') {
      return { ok: true, status: 204 };
    }
    return {};
  }), async (calls) => {
    const req = { method: 'POST', headers: { authorization: 'Bearer ok' }, body: { project_id: 'p1', variant_id: 'v1', healed_html: HEALED } };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.written, true);
    const patches = calls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 1, 'exactly one PATCH');
    assert.ok(patches[0].opts.body.includes('new with hooks'), 'PATCH carries the healed html');
  });
});

test('write-back CROSS-TENANT: variant belongs to another project -> 403, NO PATCH', async () => {
  await withFetch(authOkRouter((url) => {
    // The caller is authorized for project p1, but the variant they passed belongs
    // to project OTHER — the ownership check must reject it (service role bypasses RLS).
    if (url.includes('/project_variants')) return { json: [{ generated_html: '<x>old</x>', project_id: 'OTHER' }] };
    return {};
  }), async (calls) => {
    const req = { method: 'POST', headers: { authorization: 'Bearer ok' }, body: { project_id: 'p1', variant_id: 'v_foreign', healed_html: '<x>attacker</x>' } };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403, 'cross-tenant write-back rejected');
    const patches = calls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 0, 'no PATCH on a foreign variant');
  });
});

test('regular content save (items) still works and does NOT trigger write-back', async () => {
  await withFetch(authOkRouter((url, opts) => {
    if (url.includes('lp_editable_content') && opts.method === 'POST') return { ok: true };
    if (url.includes('lp_editable_content')) return { json: [{ key: 'hero_title', value: 'x' }] };
    return {};
  }), async (calls) => {
    const req = { method: 'POST', headers: { authorization: 'Bearer ok' }, body: { project_id: 'p1', variant_id: 'v1', items: [{ key: 'hero_title', value: 'x' }] } };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    const variantPatches = calls.filter((c) => c.url.includes('project_variants') && c.method === 'PATCH');
    assert.equal(variantPatches.length, 0, 'no generated_html write on a normal item save');
  });
});
