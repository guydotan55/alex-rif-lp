// api/feedback.js — single method-branched function (Vercel Hobby 12-fn cap).
//   POST  = widget submit (any authenticated user) — instant, no Anthropic call.
//   GET   = daily triage cron (Bearer CRON_SECRET) — AI-triages NEEDS_TRIAGE rows.
// Inbox reads are client-side under RLS (super_admin), so they live in dashboard.html.

import { authenticateAndAuthorize } from './_lib/auth-helper.js';
import { triageBody, clampTriage } from './_lib/feedback-triage.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SWEEP_LIMIT = 25; // keep the daily sweep inside maxDuration; backlog drains over days
const URGENCIES = ['blocking', 'annoying'];
const ATTACH_KINDS = ['screenshot', 'image'];
const MAX_ATTACHMENTS = 4;
const PAGE_TARGET_MAX = 200;
const CLIENT_INFO_KEYS = ['ua', 'viewport', 'screen', 'dpr', 'lang', 'platform'];

// Give the cron sweep room for ~25 Haiku calls. Submit returns instantly regardless.
export const config = { maxDuration: 60 };

// ---- pure helpers ---------------------------------------------------------

/** origin+pathname only; null for empty / non-string / malformed (never throws). */
export function stripPageUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

/** REST path for the daily sweep — capped, oldest-first, un-triaged with <3 attempts. */
export function buildNeedsTriagePath() {
  return `/rest/v1/feedback_tickets?status=eq.NEEDS_TRIAGE&triage_attempts=lt.3` +
         `&order=created_at.asc&limit=${SWEEP_LIMIT}&select=*`;
}

/** User-set urgency → one of the two allowed values, else null. */
export function clampUrgency(v) {
  return URGENCIES.includes(v) ? v : null;
}

/** "Mark the spot" descriptor → trimmed string ≤200 chars, else null. */
export function truncatePageTarget(v) {
  return typeof v === 'string' ? v.slice(0, PAGE_TARGET_MAX) : null;
}

/**
 * Keep only well-formed attachment refs the submitting user is allowed to claim:
 * a string path inside their OWN "{userId}/" folder, a known kind, no traversal.
 * Caps at MAX_ATTACHMENTS. Returns [{path, kind}].
 */
export function validateAttachments(arr, userId) {
  if (!Array.isArray(arr)) return [];
  const prefix = userId + '/';
  const out = [];
  for (const a of arr) {
    if (!a || typeof a.path !== 'string') continue;
    if (!ATTACH_KINDS.includes(a.kind)) continue;
    if (!a.path.startsWith(prefix) || a.path.includes('..')) continue;
    out.push({ path: a.path, kind: a.kind });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

/**
 * Technical info from the user's browser → a small whitelisted JSON object
 * (string values, capped). Null for anything invalid/empty. Prevents a client
 * from stuffing arbitrary/huge JSON into the ticket.
 */
export function sanitizeClientInfo(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const k of CLIENT_INFO_KEYS) {
    if (obj[k] == null || obj[k] === '') continue;
    out[k] = String(obj[k]).slice(0, 400);
  }
  return Object.keys(out).length ? out : null;
}

// ---- service-role REST (test-monitor.js pattern) --------------------------

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function insertTicket(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback_tickets?select=id`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`insertTicket: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function insertAttachments(ticketId, atts) {
  const rows = atts.map(a => ({ ticket_id: ticketId, storage_path: a.path, kind: a.kind }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback_attachments`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insertAttachments: ${res.status} ${await res.text()}`);
}

async function fetchNeedsTriage() {
  const res = await fetch(`${SUPABASE_URL}${buildNeedsTriagePath()}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`fetchNeedsTriage: ${res.status} ${await res.text()}`);
  return res.json();
}

async function patchTicket(id, updates) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback_tickets?id=eq.${id}`, {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`patchTicket: ${res.status} ${await res.text()}`);
}

// ---- POST: submit ---------------------------------------------------------

async function handleSubmit(req, res) {
  const auth = await authenticateAndAuthorize(req, res, {}); // any authenticated user
  if (!auth) return; // helper already sent 401/403

  const { text, page_url, urgency, page_target, attachments, client_info } = req.body || {};
  const body = typeof text === 'string' ? text.trim() : '';
  const validAtts = validateAttachments(attachments, auth.user.id);
  // A ticket needs either words or at least one image.
  if (!body && validAtts.length === 0) return res.status(400).json({ error: 'Empty feedback' });
  if (body.length > 5000) return res.status(400).json({ error: 'Feedback too long (max 5000)' });

  const ticketBody = body || '(צורפה תמונה ללא טקסט)';
  let ticket;
  try {
    ticket = await insertTicket({
      user_id: auth.user.id,
      user_email: auth.user.email || auth.role?.email || null, // verified token, never client
      body: ticketBody,
      page_url: stripPageUrl(page_url),
      app_version: process.env.VERCEL_GIT_COMMIT_SHA || null,  // server-stamped
      status: 'NEEDS_TRIAGE',
      summary: null, category: null, severity: null,
      triage_attempts: 0, triage_error: null, triaged_at: null,
      user_urgency: clampUrgency(urgency),
      page_target: truncatePageTarget(page_target),
      client_info: sanitizeClientInfo(client_info),                // technical info for debugging
    });
  } catch (err) {
    console.error('[feedback] submit insert failed:', err); // fail loud
    return res.status(500).json({ error: 'Could not save feedback' });
  }

  // Attachments are supplementary — if they fail, keep the ticket and log loudly.
  if (validAtts.length && ticket && ticket.id) {
    try {
      await insertAttachments(ticket.id, validAtts);
    } catch (err) {
      console.error('[feedback] attachment insert failed (ticket kept):', err);
    }
  }

  // Triage immediately so a 2-3 sentence debug summary is ready in /reports.
  // Bounded (timeout + no retries) so a slow Anthropic call can NEVER hit the 60s
  // maxDuration and 504 the request AFTER the row was inserted (which would make
  // the user retry → duplicate ticket). On any failure — or for attachment-only
  // tickets with no text — the ticket stays NEEDS_TRIAGE and the daily cron handles it.
  let status = 'NEEDS_TRIAGE';
  if (ticket && ticket.id && body) {
    try {
      const clamped = clampTriage(await triageBody(body, { requestOptions: { timeout: 15000, maxRetries: 0 } }));
      await patchTicket(ticket.id, {
        summary: clamped.summary, category: clamped.category, severity: clamped.severity,
        status: 'TRIAGED', triaged_at: new Date().toISOString(), triage_error: null,
      });
      status = 'TRIAGED';
    } catch (err) {
      console.error('[feedback] on-submit triage failed (left for cron):', err);
    }
  }
  return res.status(200).json({ status });
}

// ---- GET: triage sweep ----------------------------------------------------

export async function runTriageSweep(req, res, deps = {}) {
  const fetchTickets = deps.fetchTickets || fetchNeedsTriage;
  const patch = deps.patch || patchTicket;
  const triage = deps.triage || triageBody;
  const now = deps.now || Date.now;
  const budgetMs = deps.budgetMs ?? 50000; // stop before the 60s maxDuration wall

  let tickets = [];
  try {
    tickets = await fetchTickets();
  } catch (err) {
    console.error('[feedback] fetchNeedsTriage failed:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }

  const start = now();
  const results = [];
  const errors = [];
  let deferred = 0;
  for (const t of tickets) {
    if (now() - start > budgetMs) {
      // Out of time — leave the rest NEEDS_TRIAGE for the next daily sweep.
      deferred = tickets.length - results.length - errors.length;
      console.warn(`[feedback] triage time budget spent; deferring ${deferred} ticket(s) to next sweep`);
      break;
    }
    try {
      const clamped = clampTriage(await triage(t.body)); // triage throws on no tool_use
      await patch(t.id, {
        summary: clamped.summary,
        category: clamped.category,
        severity: clamped.severity,
        status: 'TRIAGED',
        triaged_at: new Date().toISOString(),
        triage_error: null,
      });
      results.push({ id: t.id, category: clamped.category, severity: clamped.severity });
    } catch (err) {
      const attempts = (t.triage_attempts || 0) + 1;
      const failed = attempts >= 3;
      console.error(`[feedback] triage failed on ${t.id} (attempt ${attempts}):`, err);
      try {
        await patch(t.id, {
          triage_attempts: attempts,
          triage_error: String(err.message || err),
          ...(failed ? { status: 'TRIAGE_FAILED' } : {}),
        });
      } catch (patchErr) {
        console.error(`[feedback] could not record triage failure on ${t.id}:`, patchErr);
      }
      errors.push({ id: t.id, error: String(err.message || err), failed });
    }
  }
  return res.status(200).json({ processed: results.length, results, errors, deferred });
}

// ---- entry: branch on method (cron auth BEFORE any user-auth helper) ------

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const cronSecret = process.env.CRON_SECRET;
    const auth = req.headers.authorization || req.headers.Authorization;
    if (!cronSecret) console.error('[feedback] CRON_SECRET unset — triage will never run'); // fail loud
    if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return runTriageSweep(req, res);
  }
  if (req.method === 'POST') return handleSubmit(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}
