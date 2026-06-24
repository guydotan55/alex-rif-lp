// The feedback inbox (now the dedicated /reports page) renders attacker-controlled
// ticket fields (body, summary, triage_error, page_url, page_target, email) into
// the SUPER-ADMIN's browser. They must be rendered as text, never HTML. We pull
// the ACTUAL shipped render function out of reports.html and assert a malicious
// ticket produces zero live nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseHTML } from 'linkedom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dash = readFileSync(join(__dirname, '..', 'reports.html'), 'utf8');

function extractFn(name) {
  const start = dash.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `dashboard.html defines ${name}`);
  const braceStart = dash.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return dash.slice(start, i);
}

// Build the render fn in a sandbox with an injected `document` (linkedom).
const src = extractFn('renderFeedbackTicketCard');
// eslint-disable-next-line no-new-func
const makeRender = new Function('document', `${src}\nreturn renderFeedbackTicketCard;`);

function render(ticket) {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  return makeRender(document)(ticket);
}

const XSS = '<script>window.pwned=1</' + 'script><img src=x onerror="window.pwned=1">';

test('malicious body renders inert (no live script/img/svg nodes)', () => {
  const card = render({
    id: '1', status: 'TRIAGED', category: 'bug', severity: 'high',
    summary: '<b>not bold</b>',
    body: XSS,
    user_email: '<i>e</i>@x.com', page_url: 'https://x/"><svg onload=1>',
    triage_error: '<svg onload="window.pwned=1">boom</svg>',
  });
  assert.equal(card.querySelector('script'), null);
  assert.equal(card.querySelector('img'), null);
  assert.equal(card.querySelector('svg'), null);
  assert.equal(card.querySelector('b'), null);
  assert.equal(card.querySelector('i'), null);
});

test('body text is preserved verbatim as text content', () => {
  const card = render({ id: '2', status: 'NEEDS_TRIAGE', body: XSS });
  assert.ok(card.textContent.includes(XSS), 'payload survives as literal text');
});

test('pre-triage ticket shows the "new" status badge', () => {
  const card = render({ id: '3', status: 'NEEDS_TRIAGE', body: 'hi' });
  assert.ok(card.textContent.includes('חדש'));
});

test('resolved ticket exposes no action buttons', () => {
  const card = render({ id: '4', status: 'RESOLVED', body: 'done', summary: 's' });
  assert.equal(card.querySelectorAll('button').length, 0);
});

test('open ticket exposes copy + mark-read + resolve buttons', () => {
  const card = render({ id: '5', status: 'TRIAGED', body: 'x', summary: 's' });
  assert.equal(card.querySelectorAll('button').length, 3);   // + copy-to-Claude-Code
});

test('malicious page_target renders inert as text', () => {
  const card = render({ id: 'p', status: 'TRIAGED', body: 'x', summary: 's',
    page_target: '<img src=x onerror="window.pwned=1"> ("boom")' });
  assert.equal(card.querySelector('img'), null);           // no live node from page_target
  assert.ok(card.textContent.includes('<img src=x onerror'));// survives as literal text
});

test('urgency badge shows the Hebrew label', () => {
  const card = render({ id: 'u', status: 'TRIAGED', body: 'x', summary: 's', user_urgency: 'blocking' });
  assert.ok(card.textContent.includes('חוסם'));
});

test('attachment with a signed URL renders a thumbnail image', () => {
  const card = render({ id: 'a', status: 'TRIAGED', body: 'x', summary: 's',
    feedback_attachments: [{ kind: 'screenshot', storage_path: 'u/1.png', signedUrl: 'https://ex.test/s.png' }] });
  const img = card.querySelector('img');
  assert.ok(img && img.getAttribute('src') === 'https://ex.test/s.png');
});

test('technical info block renders, with a malicious UA kept inert', () => {
  const card = render({ id: 'ci', status: 'TRIAGED', body: 'x', summary: 's',
    client_info: { ua: '<img src=x onerror="window.pwned=1">', viewport: '1440x900' } });
  assert.ok(card.textContent.includes('מידע טכני'));
  assert.ok(card.textContent.includes('1440x900'));
  assert.equal(card.querySelector('img'), null);                 // UA is text, not a live node
  assert.ok(card.textContent.includes('<img src=x onerror'));     // survives as literal text
});

test('attachment WITHOUT a signed URL renders no broken image', () => {
  const card = render({ id: 'a2', status: 'TRIAGED', body: 'x', summary: 's',
    feedback_attachments: [{ kind: 'image', storage_path: 'u/2.png', signedUrl: null }] });
  assert.equal(card.querySelector('img'), null);
});
