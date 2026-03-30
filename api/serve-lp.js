// Vercel Serverless Function — serves AI-generated landing pages with analytics
import {
  applyOverrides,
  applyImageOverrides,
  applyPageTitle,
  buildInjectedScript,
  fetchAndRenderVariant
} from './lib/lp-renderer.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  const slug = req.query.slug;
  const variantSlug = req.query.variant;

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

    // Fetch project by slug
    const projectRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?slug=eq.${encodeURIComponent(slug)}&select=id,name,email_enabled&limit=1`,
      { headers }
    );

    if (!projectRes.ok) {
      console.error("Supabase projects fetch error:", projectRes.status);
      res.status(500);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>500 — Server Error</h1>");
    }

    const projects = await projectRes.json();

    if (!projects || projects.length === 0) {
      res.status(404);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>404 — Page Not Found</h1>");
    }

    const project = projects[0];

    // Fetch the variant: specific variant by slug, or default
    let variantQuery = `${SUPABASE_URL}/rest/v1/project_variants?project_id=eq.${project.id}&status=eq.published&select=id,generated_html`;
    if (variantSlug) {
      variantQuery += `&variant_slug=eq.${encodeURIComponent(variantSlug)}`;
    } else {
      variantQuery += `&is_default=eq.true`;
    }
    variantQuery += `&limit=1`;

    const variantRes = await fetch(variantQuery, { headers });

    if (!variantRes.ok) {
      console.error("Supabase variants fetch error:", variantRes.status);
      res.status(500);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>500 — Server Error</h1>");
    }

    const variants = await variantRes.json();

    if (!variants || variants.length === 0) {
      // Fallback: legacy projects without variants
      const fallbackRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?id=eq.${project.id}&status=eq.published&select=generated_html&limit=1`,
        { headers }
      );
      const fallbackProjects = fallbackRes.ok ? await fallbackRes.json() : [];
      if (fallbackProjects.length > 0 && fallbackProjects[0].generated_html) {
        let html = fallbackProjects[0].generated_html;
        html = applyPageTitle(html, project.name);
        const imageOverridesRes = await fetch(
          `${SUPABASE_URL}/rest/v1/lp_image_content?project_id=eq.${project.id}&select=slot,image_url,display_size&enabled=eq.true`,
          { headers }
        );
        if (imageOverridesRes.ok) {
          const imageOverrides = await imageOverridesRes.json();
          html = applyImageOverrides(html, imageOverrides);
        }
        const emailEnabled = project.email_enabled === true;
        const injectedScript = buildInjectedScript(project.id, null, null, SUPABASE_ANON_KEY, SUPABASE_URL, emailEnabled);
        if (html.includes("</body>")) {
          html = html.replace("</body>", injectedScript + "\n</body>");
        } else {
          html += injectedScript;
        }
        res.status(200);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
        return res.send(html);
      }

      res.status(404);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>404 — Page Not Found</h1>");
    }

    const variant = variants[0];

    // Use shared renderer for the main path
    const { html, error } = await fetchAndRenderVariant(project.id, variant.id, null, project.name);
    if (error) {
      res.status(500);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>500 — Server Error</h1>");
    }

    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
    return res.send(html);

  } catch (err) {
    console.error("serve-lp error:", err);
    res.status(500);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send("<h1>500 — Server Error</h1>");
  }
}
