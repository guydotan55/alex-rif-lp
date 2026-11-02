// Endpoint tests for the healed-HTML write-back folded into save-content.js (Task 5).
// We stub globalThis.fetch to control auth (verifyUser / getUserRole) + the variant
// row + the PATCH, asserting: unauthorized -> 401/403, no-op when equal, single PATCH
// on the happy path.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://sb.test.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'svc';

const { default: handler } = await import('./admin.js');

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


for (const action of ['duplicate-variant', 'delete-draft-variant']) {
  test(`${action} missing project -> 400 before auth`, async () => {
    await withFetch(() => ({}), async calls => {
      const res = mockRes();
      await handler({ method: 'POST', headers: {}, body: { action, variant_id: 'v1', source_variant_id: 'v1' } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'missing_fields');
      assert.equal(calls.length, 0);
    });
  });
  test(`${action} no token -> 401`, async () => {
    await withFetch(() => ({}), async () => {
      const res = mockRes();
      await handler({ method: 'POST', headers: {}, body: { action, project_id: 'p1', variant_id: 'v1', source_variant_id: 'v1' } }, res);
      assert.equal(res.statusCode, 401);
    });
  });
  test(`${action} happy path`, async () => {
    await withFetch(authOkRouter((url, opts) => {
      if (url.includes('project_variants?id=eq.v1')) return { json: [{ id: 'v1', project_id: 'p1', generated_html: '<p>x</p>', status: 'draft', is_default: false, variant_slug: 'a' }] };
      if (url.endsWith('/project_variants') && opts.method === 'POST') return { json: [{ id: 'new', ...JSON.parse(opts.body) }] };
      return {};
    }), async () => {
      const res = mockRes();
      await handler({ method: 'POST', headers: {}, body: { action, project_id: 'p1', variant_id: 'v1', source_variant_id: 'v1', access_token: 'ok' } }, res);
      assert.equal(res.statusCode, 200);
      if (action === 'duplicate-variant') assert.equal(res.body.variant.id, 'new');
      else assert.equal(res.body.ok, true);
    });
  });
}
