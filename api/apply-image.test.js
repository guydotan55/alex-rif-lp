// Endpoint tests for the healed-HTML write-back folded into save-content.js (Task 5).
// We stub globalThis.fetch to control auth (verifyUser / getUserRole) + the variant
// row + the PATCH, asserting: unauthorized -> 401/403, no-op when equal, single PATCH
// on the happy path.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://sb.test.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'svc';

const { default: handler } = await import('./apply-image.js');

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


for (const [project, status] of [['OTHER', 403], ['p1', 200]]) {
  test(`apply-image ownership ${project}`, async () => {
    await withFetch(authOkRouter((url) => {
      if (url.includes('project_variants') && url.includes('select=project_id')) return { json: [{ project_id: project }] };
      return {};
    }), async (calls) => {
      const res = mockRes();
      await handler({ method: 'POST', headers: {}, body: {
        project_id: 'p1', variant_id: 'v1', slot: 'hero', image_url: process.env.SUPABASE_URL + '/cached.jpg', source: 'upload', access_token: 'ok',
      } }, res);
      assert.equal(res.statusCode, status);
      const writes = calls.filter(c => c.method === 'POST' || c.method === 'PATCH');
      if (status === 403) {
        assert.equal(res.body.error, 'wrong_project');
        assert.equal(writes.length, 0);
      } else {
        assert.ok(writes.some(c => c.url.includes('lp_image_content')));
        const check = calls.findIndex(c => c.url.includes('select=project_id'));
        assert.ok(check >= 0 && check < calls.indexOf(writes[0]));
      }
    });
  });
}
