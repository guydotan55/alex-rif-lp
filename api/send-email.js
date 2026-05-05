// Vercel Serverless Function — sends welcome email via Brevo + Meta CAPI events
import crypto from "crypto";
import {
  renderKickoffEmail,
  renderMilestoneEmail,
  renderSummaryEmail,
  renderStallAlertEmail,
} from "./lib/email-templates.js";
import { computeEconomicVerdict } from "./lib/economic-verdict.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL || "libby.negev.ai@gmail.com";
const APP_ORIGIN = process.env.APP_URL || "https://messaginglab-guydotan55s-projects.vercel.app";
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_CAPI_TOKEN = process.env.META_CAPI_TOKEN;

function sha256(value) {
  return crypto.createHash("sha256").update(value.toLowerCase().trim()).digest("hex");
}

async function handleMetaCapi(req, res) {
  if (!META_PIXEL_ID || !META_CAPI_TOKEN) {
    return res.status(200).json({ skipped: true, reason: "Meta CAPI not configured" });
  }
  const { event_name, event_id, email, source_url, fbc, fbp } = req.body || {};
  if (!event_name || !event_id) {
    return res.status(400).json({ error: "Missing event_name or event_id" });
  }
  const userData = {};
  if (email) userData.em = [sha256(email)];
  if (fbc) userData.fbc = fbc;
  if (fbp) userData.fbp = fbp;
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.headers["x-real-ip"]
    || req.socket?.remoteAddress;
  const clientUa = req.headers["user-agent"];
  if (clientIp) userData.client_ip_address = clientIp;
  if (clientUa) userData.client_user_agent = clientUa;

  const eventData = {
    event_name,
    event_time: Math.floor(Date.now() / 1000),
    event_id,
    action_source: "website",
    user_data: userData,
  };
  if (source_url) eventData.event_source_url = source_url;

  try {
    const capiRes = await fetch(
      `https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [eventData], access_token: META_CAPI_TOKEN }),
      }
    );
    const capiData = await capiRes.json();
    if (!capiRes.ok) {
      console.error("Meta CAPI error:", capiData);
      return res.status(200).json({ sent: false, error: capiData });
    }
    return res.status(200).json({ sent: true, events_received: capiData.events_received });
  } catch (err) {
    console.error("Meta CAPI fetch error:", err);
    return res.status(200).json({ sent: false, error: String(err.message) });
  }
}

// ── Test-planner email helpers ─────────────────────────────

async function fetchTestWithCreatorAndVariants(testId) {
  const testRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tests?id=eq.${testId}&select=*&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const testRows = await testRes.json();
  const test = testRows && testRows[0];
  if (!test) return { error: 'Test not found' };

  const creatorRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${test.created_by}`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const creator = await creatorRes.json();
  if (!creator?.email) return { error: 'Test creator has no email' };

  const tvRes = await fetch(
    `${SUPABASE_URL}/rest/v1/test_variants?test_id=eq.${testId}&select=id,variant_id,label,spend,spend_updated_at,projects(name,slug,target_cpl),project_variants(variant_slug,is_default)`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const testVariants = await tvRes.json();

  return {
    test,
    creatorEmail: creator.email,
    testVariants,
    target_cpl: testVariants[0]?.projects?.target_cpl ?? null,
  };
}

// Build the public LP URL for a test_variants row.
// Default variant: /lp/<project_slug>. Non-default: /lp/<project_slug>/<variant_slug>.
function buildLpUrl(tv) {
  const projectSlug = tv.projects?.slug;
  if (!projectSlug) return null;
  const variantSlug = tv.project_variants?.variant_slug;
  const isDefault = tv.project_variants?.is_default;
  const path = isDefault || !variantSlug ? `/lp/${projectSlug}` : `/lp/${projectSlug}/${variantSlug}`;
  return `${process.env.APP_URL || ''}${path}`;
}

async function fetchVariantCounts(test, testVariants) {
  const variantIds = testVariants.map(tv => tv.variant_id);
  if (!variantIds.length) return [];
  const startedAt = test.started_at || test.reset_at || test.created_at;
  const variantInList = variantIds.map(id => `"${id}"`).join(',');

  let allRows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/analytics_events?variant_id=in.(${variantInList})&created_at=gte.${encodeURIComponent(startedAt)}&select=variant_id,event_type,event_data&limit=${PAGE}&offset=${from}`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const rows = await res.json();
    if (!rows || !rows.length) break;
    allRows = allRows.concat(rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  const byVariant = new Map();
  for (const row of allRows) {
    if (!row.variant_id) continue;
    const v = byVariant.get(row.variant_id) || { variant_id: row.variant_id, visitors: new Set(), conversions: 0 };
    if (row.event_type === 'page_view' && row.event_data?.visitor_id) v.visitors.add(row.event_data.visitor_id);
    if (row.event_type === 'lead_captured') v.conversions += 1;
    byVariant.set(row.variant_id, v);
  }
  return Array.from(byVariant.values()).map(v => ({
    variant_id: v.variant_id,
    visitors: v.visitors.size,
    conversions: v.conversions,
  }));
}

async function sendBrevo(to, subject, html, text, senderName = 'Messaging Lab') {
  const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: senderName, email: SENDER_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });
  const data = await brevoRes.json();
  if (!brevoRes.ok) {
    console.error('Brevo error:', data);
    throw new Error(`Brevo ${brevoRes.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function handleTestKickoff(req, res) {
  const { test_id } = req.body || {};
  if (!test_id) return res.status(400).json({ error: 'test_id required' });
  try {
    const { test, creatorEmail, testVariants, error } = await fetchTestWithCreatorAndVariants(test_id);
    if (error) return res.status(404).json({ error });
    if (!test.target_sample_size) return res.status(400).json({ error: 'target_sample_size missing' });

    // Days estimate: total visitors / 100 (we don't have community velocity server-side cheaply)
    const totalVisitors = test.target_sample_size * Math.max(2, testVariants.length);
    const daysEstimate = Math.max(1, Math.ceil(totalVisitors / 100));

    const { subject, html, text } = renderKickoffEmail(test, Math.max(2, testVariants.length), daysEstimate);
    const data = await sendBrevo(creatorEmail, subject, html, text);
    return res.status(200).json({ success: true, messageId: data.messageId });
  } catch (err) {
    console.error('handleTestKickoff error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

// Placeholder stubs — implemented in Tasks 14 and 15.
async function handleTestMilestone(req, res) {
  const { test_id, milestone } = req.body || {};
  if (!test_id || ![25, 50, 75].includes(milestone)) {
    return res.status(400).json({ error: 'test_id + milestone in {25,50,75} required' });
  }
  try {
    const { test, creatorEmail, testVariants, error } = await fetchTestWithCreatorAndVariants(test_id);
    if (error) return res.status(404).json({ error });

    const counts = await fetchVariantCounts(test, testVariants);
    const variantCountsWithName = testVariants.map(tv => {
      const c = counts.find(x => x.variant_id === tv.variant_id) || { visitors: 0, conversions: 0 };
      return { label: tv.label, name: tv.projects?.name || tv.label, visitors: c.visitors, conversions: c.conversions, lpUrl: buildLpUrl(tv) };
    });

    const { subject, html, text } = renderMilestoneEmail(test, milestone, variantCountsWithName);
    const data = await sendBrevo(creatorEmail, subject, html, text);
    return res.status(200).json({ success: true, messageId: data.messageId });
  } catch (err) {
    console.error('handleTestMilestone error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
async function handleTestSummary(req, res) {
  const { test_id } = req.body || {};
  if (!test_id) return res.status(400).json({ error: 'test_id required' });
  try {
    const { test, creatorEmail, testVariants, target_cpl, error } = await fetchTestWithCreatorAndVariants(test_id);
    if (error) return res.status(404).json({ error });
    if (!test.summary_verdict || !['WINNER_FOUND', 'PRACTICAL_TIE', 'TRENDING_UNDERPOWERED'].includes(test.summary_verdict)) {
      return res.status(400).json({ error: 'tests.summary_verdict not set or invalid; cron must persist verdict before send' });
    }

    const counts = await fetchVariantCounts(test, testVariants);
    const variantCountsWithName = testVariants.map(tv => {
      const c = counts.find(x => x.variant_id === tv.variant_id) || { visitors: 0, conversions: 0 };
      return { label: tv.label, name: tv.projects?.name || tv.label, visitors: c.visitors, conversions: c.conversions, lpUrl: buildLpUrl(tv) };
    });

    // Derive winner display name from persisted FK rather than trusting client
    let winnerName = null, winnerLabel = null;
    if (test.summary_winner_variant_id) {
      const tv = testVariants.find(t => t.variant_id === test.summary_winner_variant_id);
      if (tv) {
        winnerLabel = tv.label;
        winnerName = tv.projects?.name || tv.label;
      }
    }

    let economic = null;
    try {
      const variantsForVerdict = testVariants.map(tv => {
        const c = counts.find(x => x.variant_id === tv.variant_id) || { conversions: 0 };
        return {
          variant_id: tv.variant_id,
          leads: c.conversions,
          spend: tv.spend != null ? Number(tv.spend) : null,
          spend_updated_at: tv.spend_updated_at,
        };
      });
      economic = computeEconomicVerdict({
        cr_leader_variant_id: test.summary_winner_variant_id,
        variants: variantsForVerdict,
        target_cpl: target_cpl != null ? Number(target_cpl) : null,
      });
    } catch (err) {
      console.error('computeEconomicVerdict failed:', err);
      economic = null;
    }

    const variantCountsWithSpend = variantCountsWithName.map(v => {
      const tv = testVariants.find(t => t.variant_id === v.variant_id || (t.label === v.label));
      return { ...v, spend: tv?.spend != null ? Number(tv.spend) : null };
    });

    const decision = {
      verdict: test.summary_verdict,
      winnerLabel,
      winnerName,
      liftPct: test.summary_lift_pct != null ? Number(test.summary_lift_pct) : 0,
      economic,
    };
    const { subject, html, text } = renderSummaryEmail(test, decision, variantCountsWithSpend);
    const data = await sendBrevo(creatorEmail, subject, html, text);
    return res.status(200).json({ success: true, messageId: data.messageId });
  } catch (err) {
    console.error('handleTestSummary error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
async function handleTestStallAlert(req, res) {
  const { test_id } = req.body || {};
  if (!test_id) return res.status(400).json({ error: 'test_id required' });
  try {
    const { test, creatorEmail, error } = await fetchTestWithCreatorAndVariants(test_id);
    if (error) return res.status(404).json({ error });
    const { subject, html, text } = renderStallAlertEmail(test);
    const data = await sendBrevo(creatorEmail, subject, html, text);
    return res.status(200).json({ success: true, messageId: data.messageId });
  } catch (err) {
    console.error('handleTestStallAlert error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Route: Meta CAPI event
  if (req.body?.action === "meta_capi") {
    return handleMetaCapi(req, res);
  }

  if (req.body?.action === 'test_kickoff') {
    return handleTestKickoff(req, res);
  }
  if (req.body?.action === 'test_milestone') {
    return handleTestMilestone(req, res);
  }
  if (req.body?.action === 'test_summary') {
    return handleTestSummary(req, res);
  }
  if (req.body?.action === 'test_stall_alert') {
    return handleTestStallAlert(req, res);
  }

  const { email, project_id } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }

  // --- Project-based email template path ---
  if (project_id) {
    try {
      // Fetch the project row from Supabase
      const projRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?id=eq.${project_id}&select=*&limit=1`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );

      const projRows = await projRes.json();
      const project = projRows && projRows[0];

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      // If email is disabled for this project, skip sending
      if (!project.email_enabled) {
        return res.status(200).json({ success: true, skipped: true });
      }

      const subject = project.email_subject || `Welcome to ${project.name || 'our page'}!`;
      const bodyText = project.email_body || "Thank you for signing up!";

      const bodyHtml = `
        <div style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
          ${bodyText.split("\n").map(line => `<p style="margin: 0 0 10px;">${line || "&nbsp;"}</p>`).join("")}
        </div>
      `;

      const senderName = project.name || "LP Builder";

      // Send via Brevo
      const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": BREVO_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender: { name: senderName, email: SENDER_EMAIL },
          to: [{ email }],
          subject,
          htmlContent: bodyHtml,
          textContent: bodyText,
        }),
      });

      const brevoData = await brevoRes.json();

      if (!brevoRes.ok) {
        console.error("Brevo error:", brevoData);
        return res.status(500).json({ error: brevoData });
      }

      return res.status(200).json({ success: true, messageId: brevoData.messageId });

    } catch (err) {
      console.error("Unexpected error (project email):", err);
      return res.status(500).json({ error: String(err) });
    }
  }

  try {
    // Pick settings keys based on source
    const source = (req.body && req.body.source) || 'cheburashka';
    const subjectKey = source === 'alex-rif' ? 'alex_rif_email_subject' : 'welcome_email_subject';
    const bodyKey = source === 'alex-rif' ? 'alex_rif_email_body' : 'welcome_email_body';

    // Fetch email template from Supabase settings
    const settingsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?key=in.(${subjectKey},${bodyKey})&select=key,value`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    const settingsRows = await settingsRes.json();
    const settings = {};
    for (const row of settingsRows) settings[row.key] = row.value;

    const subject = settings[subjectKey] || "קיבלנו את פרטיך!";
    const bodyText = settings[bodyKey] || "תודה שהתעניינת!";

    const bodyHtml = `
      <div dir="rtl" style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
        <div style="background: #0d2240; border-radius: 16px; padding: 20px 24px; margin-bottom: 24px; text-align: center;">
          <p style="font-size: 22px; font-weight: 900; margin: 0; color: #f5c842;">צ׳יבורשקה בישראל 🐻</p>
        </div>
        ${bodyText.split("\n").map(line => `<p style="margin: 0 0 10px;">${line || "&nbsp;"}</p>`).join("")}
        <hr style="border: none; border-top: 1px solid #eee; margin: 28px 0;" />
        <p style="font-size: 12px; color: #aaa; text-align: center;">רוסית לילדים בישראל</p>
      </div>
    `;

    // Send via Brevo
    const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: "צ׳יבורשקה בישראל", email: SENDER_EMAIL },
        to: [{ email }],
        subject,
        htmlContent: bodyHtml,
        textContent: bodyText,
      }),
    });

    const brevoData = await brevoRes.json();

    if (!brevoRes.ok) {
      console.error("Brevo error:", brevoData);
      return res.status(500).json({ error: brevoData });
    }

    return res.status(200).json({ success: true, messageId: brevoData.messageId });

  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: String(err) });
  }
}
