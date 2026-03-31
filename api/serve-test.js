// Vercel Serverless Function — serves test URLs with traffic splitting
import { fetchAndRenderVariant } from './lib/lp-renderer.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function parseCookie(str) {
  const obj = {};
  if (!str) return obj;
  str.split(';').forEach(pair => {
    const [key, ...rest] = pair.split('=');
    obj[key.trim()] = decodeURIComponent(rest.join('=').trim());
  });
  return obj;
}

export default async function handler(req, res) {
  const slug = req.query.slug;

  if (!slug) {
    res.status(404);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send("<h1>404 — Not Found</h1>");
  }

  try {
    const headers = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    };

    // Fetch test by slug
    const testRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tests?slug=eq.${encodeURIComponent(slug)}&select=id,status,winner_variant_id&limit=1`,
      { headers }
    );
    if (!testRes.ok) {
      res.status(500);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>500 — Server Error</h1>");
    }

    const tests = await testRes.json();
    if (!tests.length) {
      res.status(404);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>404 — Test Not Found</h1>");
    }

    const test = tests[0];

    // Draft tests are not publicly accessible
    if (test.status === 'draft') {
      res.status(404);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>404 — Test Not Found</h1>");
    }

    // Fetch test variants
    const tvRes = await fetch(
      `${SUPABASE_URL}/rest/v1/test_variants?test_id=eq.${test.id}&select=id,project_id,variant_id,weight`,
      { headers }
    );
    if (!tvRes.ok) {
      res.status(500);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>500 — Server Error</h1>");
    }

    const testVariants = await tvRes.json();
    if (!testVariants.length) {
      res.status(500);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>500 — No variants configured for this test</h1>");
    }

    // Determine which variant to serve
    let chosen;

    if (test.status === 'completed' && test.winner_variant_id) {
      // Always serve the winner
      chosen = testVariants.find(tv => tv.id === test.winner_variant_id);
      if (!chosen) chosen = testVariants[0];
    } else {
      // Check cookie for session consistency
      const cookieKey = `test_${test.id}`;
      const cookies = parseCookie(req.headers.cookie);
      const savedVariantId = cookies[cookieKey];

      if (savedVariantId) {
        chosen = testVariants.find(tv => tv.id === savedVariantId);
      }

      if (!chosen) {
        // Weighted random selection
        const totalWeight = testVariants.reduce((sum, tv) => sum + tv.weight, 0);
        let rand = Math.random() * totalWeight;
        for (const tv of testVariants) {
          rand -= tv.weight;
          if (rand <= 0) { chosen = tv; break; }
        }
        if (!chosen) chosen = testVariants[testVariants.length - 1];

        // Set cookie for session consistency (30 days)
        res.setHeader('Set-Cookie',
          `${cookieKey}=${chosen.id}; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`
        );
      }
    }

    // Fetch project name for page title
    let projectName = null;
    const projRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(chosen.project_id)}&select=name&limit=1`,
      { headers }
    );
    if (projRes.ok) {
      const projs = await projRes.json();
      if (projs.length > 0) projectName = projs[0].name;
    }

    // Render the chosen variant
    const { html, error } = await fetchAndRenderVariant(
      chosen.project_id, chosen.variant_id, test.id, projectName
    );

    if (error) {
      console.error("serve-test render error:", error);
      res.status(500);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>500 — Server Error</h1>");
    }

    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.send(html);

  } catch (err) {
    console.error("serve-test error:", err);
    res.status(500);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send("<h1>500 — Server Error</h1>");
  }
}
