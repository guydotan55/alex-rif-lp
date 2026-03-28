// Vercel Serverless Function — serves AI-generated landing pages with analytics
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Apply text overrides: replace innerHTML of elements with data-editable="key"
 * Each override has a `key` and `value` from the lp_editable_content table.
 */
function applyOverrides(html, overrides) {
  if (!overrides || overrides.length === 0) return html;

  for (const { key, value } of overrides) {
    if (!key || value == null) continue;
    const escapedValue = escapeHtml(value);
    // Match elements with data-editable="key" and replace their inner content
    const regex = new RegExp(
      `(<[^>]*\\bdata-editable\\s*=\\s*"${key}"[^>]*>)([\\s\\S]*?)(<\\/[^>]+>)`,
      "gi"
    );
    const before = html;
    if (value === '') {
      // Empty value: hide the element entirely by adding display:none
      html = html.replace(regex, (match, open, content, close) => {
        const hiddenOpen = open.replace(/>$/, ' style="display:none;">');
        return hiddenOpen + close;
      });
    } else {
      html = html.replace(regex, `$1${escapedValue}$3`);
    }

    // For footer_text on older LPs without data-editable attribute:
    // replace the inner content of <footer> directly
    if (key === "footer_text" && html === before) {
      html = html.replace(
        /(<footer[^>]*>)([\s\S]*?)(<\/footer>)/i,
        `$1<p>${escapedValue}</p>$3`
      );
    }
  }

  return html;
}

function applyImageOverrides(html, imageOverrides) {
  if (!imageOverrides || imageOverrides.length === 0) return html;
  for (const { slot, image_url } of imageOverrides) {
    if (!slot || !image_url) continue;
    // Handle src before or after data-image-slot in the tag
    const regex1 = new RegExp(
      `(<img\\b[^>]*data-image-slot\\s*=\\s*"${slot}"[^>]*\\bsrc=")([^"]*)(")`, "gi"
    );
    const regex2 = new RegExp(
      `(<img\\b[^>]*\\bsrc=")([^"]*)("[^>]*data-image-slot\\s*=\\s*"${slot}")`, "gi"
    );
    html = html.replace(regex1, `$1${image_url}$3`);
    html = html.replace(regex2, `$1${image_url}$3`);
  }
  return html;
}

/**
 * Build the client-side script that handles analytics + form submission.
 * Uses the public SUPABASE_ANON_KEY for client-side Supabase calls.
 */
function buildInjectedScript(projectId, variantId, anonKey, supabaseUrl, emailEnabled) {
  return `
<!-- LP Builder: Analytics & Form Handling -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
(function() {
  var SUPABASE_URL = "${supabaseUrl}";
  var SUPABASE_ANON_KEY = "${anonKey}";
  var PROJECT_ID = "${projectId}";
  var VARIANT_ID = ${variantId ? `"${variantId}"` : "null"};
  var EMAIL_ENABLED = ${emailEnabled ? "true" : "false"};

  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var sessionId = crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36));

  function trackEvent(eventType, eventData) {
    var row = {
      event_type: eventType,
      event_data: eventData || {},
      source: "lp-builder",
      session_id: sessionId,
      project_id: PROJECT_ID
    };
    if (VARIANT_ID) row.variant_id = VARIANT_ID;
    sb.from("analytics_events").insert(row).then(function() {});
  }

  // 1. page_view — fires on load
  trackEvent("page_view", {
    referrer: document.referrer || null,
    url: window.location.href,
    user_agent: navigator.userAgent
  });

  // 2. last_fold_reach — IntersectionObserver on form section
  var formSection = document.getElementById("lp-email-form") || document.querySelector("form");
  if (formSection) {
    var foldObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          trackEvent("last_fold_reach", { element: "form" });
          foldObserver.disconnect();
        }
      });
    }, { threshold: 0.3 });
    foldObserver.observe(formSection);
  }

  // 3. button_click — click on CTA elements
  document.addEventListener("click", function(e) {
    var el = e.target.closest('[data-cta], button[type="submit"], .cta-button, a.cta');
    if (el) {
      trackEvent("button_click", {
        text: (el.textContent || "").trim().slice(0, 100),
        tag: el.tagName,
        href: el.href || null
      });
    }
  });

  // 4. Form submission handler
  var form = document.getElementById("lp-email-form") || document.querySelector("form");
  if (form) {
    form.addEventListener("submit", function(e) {
      e.preventDefault();

      var emailInput = form.querySelector('input[type="email"], input[name="email"]');
      var nameInput = form.querySelector('input[name="name"]');
      var phoneInput = form.querySelector('input[name="phone"]');

      var email = emailInput ? emailInput.value.trim() : "";
      if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        alert("Please enter a valid email address.");
        return;
      }

      var leadData = {
        email: email,
        project_id: PROJECT_ID,
        source: "lp-builder"
      };
      if (VARIANT_ID) leadData.variant_id = VARIANT_ID;
      if (nameInput && nameInput.value.trim()) leadData.name = nameInput.value.trim();
      if (phoneInput && phoneInput.value.trim()) leadData.phone = phoneInput.value.trim();

      // Insert lead
      sb.from("leads").insert(leadData).then(function(result) {
        if (result.error) {
          console.error("Lead insert error:", result.error);
        }

        // Track lead_captured event
        trackEvent("lead_captured", { email: email });

        // Send welcome email if enabled
        if (EMAIL_ENABLED) {
          fetch("/api/send-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email, project_id: PROJECT_ID })
          }).catch(function(err) { console.error("Email send error:", err); });
        }

        // Show thank you message
        var thankyouEl = document.querySelector('[data-editable="thankyou_text"]');
        if (thankyouEl) {
          thankyouEl.style.display = "block";
          form.style.display = "none";
        } else {
          form.innerHTML = '<div style="text-align:center;padding:32px 16px;"><p style="font-size:1.4em;font-weight:700;margin-bottom:8px;">Thank you!</p><p>We received your details.</p></div>';
        }
      });
    });
  }
})();
</script>
`;
}

export default async function handler(req, res) {
  const slug = req.query.slug;
  const variantSlug = req.query.variant; // undefined for /lp/:slug, set for /lp/:slug/:variant

  if (!slug) {
    res.status(404);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send("<h1>404 — Not Found</h1>");
  }

  try {
    // Fetch project by slug (no status filter — variant status controls publishing)
    const projectRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?slug=eq.${encodeURIComponent(slug)}&select=id,email_enabled&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
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

    const variantRes = await fetch(variantQuery, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (!variantRes.ok) {
      console.error("Supabase variants fetch error:", variantRes.status);
      res.status(500);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send("<h1>500 — Server Error</h1>");
    }

    const variants = await variantRes.json();

    if (!variants || variants.length === 0) {
      // Fallback: try serving from projects.generated_html for backward compat
      const fallbackRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?id=eq.${project.id}&status=eq.published&select=generated_html&limit=1`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      const fallbackProjects = fallbackRes.ok ? await fallbackRes.json() : [];
      if (fallbackProjects.length > 0 && fallbackProjects[0].generated_html) {
        // Serve legacy project HTML without variant tracking
        let html = fallbackProjects[0].generated_html;
        const imageOverridesRes = await fetch(
          `${SUPABASE_URL}/rest/v1/lp_image_content?project_id=eq.${project.id}&select=slot,image_url`,
          { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
        );
        if (imageOverridesRes.ok) {
          const imageOverrides = await imageOverridesRes.json();
          html = applyImageOverrides(html, imageOverrides);
        }
        const emailEnabled = project.email_enabled === true;
        const injectedScript = buildInjectedScript(project.id, null, SUPABASE_ANON_KEY, SUPABASE_URL, emailEnabled);
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
    let html = variant.generated_html || "";

    // Fetch text overrides scoped to this variant
    const overridesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_editable_content?variant_id=eq.${variant.id}&select=key,value`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (overridesRes.ok) {
      const overrides = await overridesRes.json();
      html = applyOverrides(html, overrides);
    }

    // Fetch image overrides scoped to this variant
    const imageOverridesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_image_content?variant_id=eq.${variant.id}&select=slot,image_url`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (imageOverridesRes.ok) {
      const imageOverrides = await imageOverridesRes.json();
      html = applyImageOverrides(html, imageOverrides);
    }

    // Inject analytics + form handling script before </body>
    const emailEnabled = project.email_enabled === true;
    const injectedScript = buildInjectedScript(
      project.id,
      variant.id,
      SUPABASE_ANON_KEY,
      SUPABASE_URL,
      emailEnabled
    );

    if (html.includes("</body>")) {
      html = html.replace("</body>", injectedScript + "\n</body>");
    } else {
      html += injectedScript;
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
