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
    // Handles both self-closing-style and normal elements
    const regex = new RegExp(
      `(<[^>]*\\bdata-editable\\s*=\\s*"${key}"[^>]*>)([\\s\\S]*?)(<\\/[^>]+>)`,
      "gi"
    );
    html = html.replace(regex, `$1${escapedValue}$3`);
  }

  return html;
}

/**
 * Build the client-side script that handles analytics + form submission.
 * Uses the public SUPABASE_ANON_KEY for client-side Supabase calls.
 */
function buildInjectedScript(projectId, anonKey, supabaseUrl, emailEnabled) {
  return `
<!-- LP Builder: Analytics & Form Handling -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
(function() {
  var SUPABASE_URL = "${supabaseUrl}";
  var SUPABASE_ANON_KEY = "${anonKey}";
  var PROJECT_ID = "${projectId}";
  var EMAIL_ENABLED = ${emailEnabled ? "true" : "false"};

  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var sessionId = crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36));

  function trackEvent(eventType, eventData) {
    sb.from("analytics_events").insert({
      event_type: eventType,
      event_data: eventData || {},
      source: "lp-builder",
      session_id: sessionId,
      project_id: PROJECT_ID
    }).then(function() {});
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

  if (!slug) {
    res.status(404);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send("<h1>404 — Not Found</h1>");
  }

  try {
    // Fetch published project by slug
    const projectRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?slug=eq.${encodeURIComponent(slug)}&status=eq.published&select=*&limit=1`,
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
    let html = project.generated_html || project.html || "";

    // Fetch text overrides from lp_editable_content
    const overridesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_editable_content?project_id=eq.${project.id}&select=key,value`,
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

    // Inject analytics + form handling script before </body>
    const emailEnabled = project.email_enabled === true;
    const injectedScript = buildInjectedScript(
      project.id,
      SUPABASE_ANON_KEY,
      SUPABASE_URL,
      emailEnabled
    );

    if (html.includes("</body>")) {
      html = html.replace("</body>", injectedScript + "\n</body>");
    } else {
      // If no </body> tag, append to end
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
