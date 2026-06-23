import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { stripPageUrl, buildNeedsTriagePath, runTriageSweep,
  clampUrgency, truncatePageTarget, validateAttachments, sanitizeClientInfo } from './feedback.js';

function mkRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// ---- stripPageUrl ---------------------------------------------------------

test('stripPageUrl keeps origin+pathname, drops query/hash', () => {
  assert.equal(stripPageUrl('https://app.example.com/dashboard?x=1#frag'), 'https://app.example.com/dashboard');
});

test('stripPageUrl returns null for empty / non-string / malformed', () => {
  assert.equal(stripPageUrl(''), null);
  assert.equal(stripPageUrl(null), null);
  assert.equal(stripPageUrl(123), null);
  assert.equal(stripPageUrl('not a url'), null); // must not throw
});

// ---- sweep query (LIMIT 25 + filters) ------------------------------------

test('sweep query caps at 25 and filters to un-triaged with <3 attempts, oldest first', () => {
  const path = buildNeedsTriagePath();
  assert.match(path, /status=eq\.NEEDS_TRIAGE/);
  assert.match(path, /triage_attempts=lt\.3/);
  assert.match(path, /limit=25/);
  assert.match(path, /order=created_at\.asc/);
});

// ---- urgency / page_target / attachments (v2) -----------------------------

test('clampUrgency keeps the two valid values, else null', () => {
  assert.equal(clampUrgency('blocking'), 'blocking');
  assert.equal(clampUrgency('annoying'), 'annoying');
  assert.equal(clampUrgency('urgent'), null);
  assert.equal(clampUrgency(undefined), null);
  assert.equal(clampUrgency(3), null);
  assert.equal(clampUrgency({}), null);
});

test('truncatePageTarget caps length and rejects non-strings', () => {
  assert.equal(truncatePageTarget('button#send ("שלח")'), 'button#send ("שלח")');
  assert.equal(truncatePageTarget('x'.repeat(500)).length, 200);
  assert.equal(truncatePageTarget(null), null);
  assert.equal(truncatePageTarget(42), null);
});

test('validateAttachments keeps only well-formed, own-folder, capped items', () => {
  const uid = 'user-1';
  const got = validateAttachments([
    { path: 'user-1/a.png', kind: 'screenshot' },   // ok
    { path: 'user-1/b.jpg', kind: 'image' },         // ok
    { path: 'user-2/c.png', kind: 'image' },         // foreign folder → drop
    { path: 'user-1/d.png', kind: 'evil' },          // bad kind → drop
    { path: 'user-1/../user-2/e.png', kind: 'image' }, // traversal → drop
    { path: 42, kind: 'image' },                     // non-string → drop
  ], uid);
  assert.deepEqual(got, [
    { path: 'user-1/a.png', kind: 'screenshot' },
    { path: 'user-1/b.jpg', kind: 'image' },
  ]);
});

test('validateAttachments handles non-array and caps at 4', () => {
  assert.deepEqual(validateAttachments(null, 'u'), []);
  assert.deepEqual(validateAttachments('nope', 'u'), []);
  const many = Array.from({ length: 6 }, (_, i) => ({ path: `u/${i}.png`, kind: 'image' }));
  assert.equal(validateAttachments(many, 'u').length, 4);
});

// ---- sanitizeClientInfo (v3 technical info) -------------------------------

test('sanitizeClientInfo keeps only whitelisted string fields', () => {
  const got = sanitizeClientInfo({
    ua: 'Mozilla/5.0 Chrome', viewport: '1440x900', screen: '1920x1080',
    dpr: 2, lang: 'he-IL', platform: 'MacIntel',
    evil: '<script>', cookies: 'secret',
  });
  assert.deepEqual(got, {
    ua: 'Mozilla/5.0 Chrome', viewport: '1440x900', screen: '1920x1080',
    dpr: '2', lang: 'he-IL', platform: 'MacIntel',
  });
});

test('sanitizeClientInfo truncates long values and drops empties', () => {
  const got = sanitizeClientInfo({ ua: 'x'.repeat(900), viewport: '' });
  assert.equal(got.ua.length, 400);
  assert.ok(!('viewport' in got)); // empty string dropped
});

test('sanitizeClientInfo returns null for non-objects / arrays / empty', () => {
  assert.equal(sanitizeClientInfo(null), null);
  assert.equal(sanitizeClientInfo('nope'), null);
  assert.equal(sanitizeClientInfo([1, 2]), null);
  assert.equal(sanitizeClientInfo({}), null);
  assert.equal(sanitizeClientInfo({ junk: 'x' }), null); // no whitelisted keys
});

// ---- cron auth ordering (no network) -------------------------------------

test('GET + wrong CRON_SECRET → 401', async () => {
  process.env.CRON_SECRET = 'right-secret';
  const res = mkRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
  assert.equal(res.statusCode, 401);
});

test('GET + unset CRON_SECRET → 401 (never runs triage)', async () => {
  delete process.env.CRON_SECRET;
  const res = mkRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer anything' } }, res);
  assert.equal(res.statusCode, 401);
});

test('POST + no token → 401 (auth before any work)', async () => {
  const res = mkRes();
  await handler({ method: 'POST', body: {}, headers: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('unsupported method → 405', async () => {
  const res = mkRes();
  await handler({ method: 'PUT', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

// ---- per-ticket isolation + attempts/TRIAGE_FAILED -----------------------

test('one failing ticket does not stall the others; success path TRIAGES', async () => {
  const tickets = [
    { id: 'a', body: 'good 1', triage_attempts: 0 },
    { id: 'b', body: 'BOOM',   triage_attempts: 0 },
    { id: 'c', body: 'good 2', triage_attempts: 0 },
  ];
  const patches = [];
  const deps = {
    fetchTickets: async () => tickets,
    triage: async (body) => {
      if (body === 'BOOM') throw new Error('transport blew up');
      return { summary: 'ok', category: 'bug', severity: 'low' };
    },
    patch: async (id, updates) => { patches.push({ id, updates }); },
  };
  const res = mkRes();
  await runTriageSweep({}, res, deps);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processed, 2);          // a and c
  assert.equal(res.body.errors.length, 1);      // b
  const a = patches.find(p => p.id === 'a');
  assert.equal(a.updates.status, 'TRIAGED');
  assert.equal(a.updates.category, 'bug');
  const b = patches.find(p => p.id === 'b');
  assert.equal(b.updates.triage_attempts, 1);
  assert.equal(b.updates.status, undefined);    // still NEEDS_TRIAGE (left for next sweep)
  assert.ok(b.updates.triage_error);
});

test('sweep stops launching new triages once the time budget is spent', async () => {
  const triaged = [];
  let clock = 0;
  const deps = {
    fetchTickets: async () => [
      { id: 'a', body: 'one', triage_attempts: 0 },
      { id: 'b', body: 'two', triage_attempts: 0 },
    ],
    now: () => clock,           // 0 at start, then jump past the budget
    budgetMs: 50,
    triage: async () => { clock = 1000; return { summary: 's', category: 'bug', severity: 'low' }; },
    patch: async (id) => { triaged.push(id); },
  };
  const res = mkRes();
  await runTriageSweep({}, res, deps);
  // 'a' processes; before 'b' the clock (1000) exceeds budget (50) → 'b' deferred.
  assert.deepEqual(triaged, ['a']);
  assert.equal(res.body.processed, 1);
  assert.ok(res.body.deferred >= 1, 'reports how many were left for the next sweep');
});

test('3rd failed attempt flips status to TRIAGE_FAILED', async () => {
  const patches = [];
  const deps = {
    fetchTickets: async () => [{ id: 'z', body: 'BOOM', triage_attempts: 2 }],
    triage: async () => { throw new Error('still failing'); },
    patch: async (id, updates) => { patches.push({ id, updates }); },
  };
  const res = mkRes();
  await runTriageSweep({}, res, deps);
  assert.equal(patches[0].updates.triage_attempts, 3);
  assert.equal(patches[0].updates.status, 'TRIAGE_FAILED');
});
