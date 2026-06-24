// Shared LP rendering — used by serve-lp.js and serve-test.js

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const META_PIXEL_ID = process.env.META_PIXEL_ID || "";

export function escapeHtml(str) {
  if (str == null || str === "") return "";
  // Coerce non-strings (numeric/boolean override values) so .replace can't throw a 500 on /lp.
  if (typeof str !== "string") str = String(str);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Apply text overrides: replace the inner content of every element carrying
 * data-editable="key" with the (escaped) override value.
 *
 * Replacement is nesting-aware: it matches the editable element's OWN closing
 * tag via depth counting, so a nested tag inside it (e.g. <span>•</span> in a
 * headline, <small> in an event row, or <p> inside story_text) does not cut the
 * replacement short and leave the old text behind.
 */
export function applyOverrides(html, overrides) {
  if (!overrides || overrides.length === 0) return html;

  for (const { key, value } of overrides) {
    if (!key || value == null) continue;
    const before = html;
    html = replaceEditable(html, key, value);

    // Legacy fallback: old LPs whose footer has no data-editable hook.
    if (key === "footer_text" && html === before) {
      html = html.replace(
        /(<footer[^>]*>)([\s\S]*?)(<\/footer>)/i,
        `$1<p>${escapeHtml(value)}</p>$3`
      );
    }
  }

  return html;
}

/**
 * Find the index range of the closing tag that matches an element of `tagName`
 * whose content starts at `fromIndex`. Depth-counts nested same-name tags and
 * ignores self-closing ones. Returns {start, end} or null if unbalanced.
 */
function findMatchingClose(str, tagName, fromIndex) {
  const re = new RegExp(`<(/?)${tagName}\\b(?:[^>]*?)(/?)>`, "gi");
  re.lastIndex = fromIndex;
  let depth = 1;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m[1] === "/") {
      depth--;
      if (depth === 0) return { start: m.index, end: m.index + m[0].length };
    } else if (m[2] !== "/") {
      depth++;
    }
  }
  return null;
}

/**
 * Replace the inner content of every <tag data-editable="key">…</tag> in `html`.
 * value === "" hides the element (display:none) and clears its content.
 */
function replaceEditable(html, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openRe = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bdata-editable\\s*=\\s*"${escapedKey}"[^>]*>`,
    "i"
  );
  const escapedValue = escapeHtml(value);

  let out = "";
  let rest = html;
  while (true) {
    const m = openRe.exec(rest);
    if (!m) { out += rest; break; }
    const openTag = m[0];
    const tagName = m[1];
    const openEnd = m.index + openTag.length;

    const close = findMatchingClose(rest, tagName, openEnd);
    if (!close) {
      // Unbalanced markup — skip past this opening tag rather than corrupt it.
      out += rest.slice(0, openEnd);
      rest = rest.slice(openEnd);
      continue;
    }

    out += rest.slice(0, m.index);
    const closeTag = rest.slice(close.start, close.end);
    if (value === "") {
      out += openTag.replace(/>$/, ' style="display:none;">') + closeTag;
    } else {
      out += openTag + escapedValue + closeTag;
    }
    rest = rest.slice(close.end);
  }
  return out;
}

export function applyImageOverrides(html, imageOverrides) {
  if (!imageOverrides || imageOverrides.length === 0) return html;
  for (const { slot, image_url, display_size, display_shape } of imageOverrides) {
    if (!slot || !image_url) continue;
    const slotExists = html.includes(`data-image-slot="${slot}"`);

    if (slotExists) {
      const regex1 = new RegExp(
        `(<img\\b[^>]*data-image-slot\\s*=\\s*"${slot}"[^>]*\\bsrc=")([^"]*)(")`, "gi"
      );
      const regex2 = new RegExp(
        `(<img\\b[^>]*\\bsrc=")([^"]*)("[^>]*data-image-slot\\s*=\\s*"${slot}")`, "gi"
      );
      html = html.replace(regex1, `$1${image_url}$3`);
      html = html.replace(regex2, `$1${image_url}$3`);
    } else if (slot === "fold2") {
      const safeUrl = image_url.replace(/"/g, '&quot;');
      const sizeMap = { small: '50%', medium: '70%', full: '100%' };
      const width = sizeMap[display_size] || '100%';
      const isCircle = display_shape === 'circle';
      const radius = isCircle ? '50%' : '16px';
      const aspectRatio = isCircle ? 'aspect-ratio:1/1;' : '';
      const imgTag = `<div style="margin:32px auto;border-radius:${radius};overflow:hidden;max-width:${width};${aspectRatio}"><img data-image-slot="fold2" src="${safeUrl}" alt="" style="width:100%;height:100%;display:block;object-fit:cover;border-radius:${radius};"></div>`;
      const storyMatch = html.match(/(<[^>]*data-editable\s*=\s*"story_text"[^>]*>[\s\S]*?<\/[^>]+>)/i);
      if (storyMatch) {
        html = html.replace(storyMatch[0], storyMatch[0] + imgTag);
      } else {
        const lastSectionIdx = html.lastIndexOf("<section");
        if (lastSectionIdx > 0) {
          html = html.slice(0, lastSectionIdx) + imgTag + html.slice(lastSectionIdx);
        }
      }
    }
  }
  return html;
}

/**
 * Build the client-side analytics + form script.
 * testId is nullable — only set when served via test URL.
 */
export function buildInjectedScript(projectId, variantId, testId, anonKey, supabaseUrl, emailEnabled, metaPixelId) {
  // Build Meta Pixel snippet (only if pixel ID is configured)
  const metaPixelSnippet = metaPixelId ? `
  <!-- Meta Pixel -->
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', '${metaPixelId}');
  fbq('track', 'PageView');` : "";

  // Build Meta CAPI + Pixel event firing code
  const metaEventCode = metaPixelId ? `
        // --- Meta: CompleteRegistration (Pixel + CAPI) ---
        var eventId = sessionId + "_" + Date.now();
        // Browser-side Pixel event
        if (typeof fbq === "function") {
          fbq('track', 'CompleteRegistration', {
            content_name: PROJECT_ID,
            status: 'complete'
          }, { eventID: eventId });
        }
        // Server-side CAPI event (deduped via eventId)
        var fbcCookie = (document.cookie.match(/(?:^|;\\s*)_fbc=([^;]*)/) || [])[1] || "";
        var fbpCookie = (document.cookie.match(/(?:^|;\\s*)_fbp=([^;]*)/) || [])[1] || "";
        fetch("/api/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "meta_capi",
            event_name: "CompleteRegistration",
            event_id: eventId,
            project_id: PROJECT_ID,
            email: email,
            source_url: window.location.href,
            fbc: fbcCookie,
            fbp: fbpCookie
          })
        }).catch(function() {});` : "";

  return `
<!-- LP Builder: Twemoji (consistent emoji rendering as SVG, pinned) -->
<style>img.emoji{height:1em;width:1em;margin:0 .1em;vertical-align:-0.1em;display:inline-block}</style>
<script src="https://cdn.jsdelivr.net/npm/@twemoji/api@17.0.3/dist/twemoji.min.js" crossorigin="anonymous"></script>
<script>
// Guarded Twemoji parser — MUST NEVER throw on /lp. No-ops if twemoji failed to load.
window.__twemojiParse = function(node) {
  try {
    if (typeof window.twemoji === "undefined" || !node) return;
    window.twemoji.parse(node, {
      folder: 'svg',
      ext: '.svg',
      base: 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/',
      className: 'emoji'
    });
  } catch (e) {
    // Swallow — emoji rendering is cosmetic and must not break the page.
  }
};
</script>
<!-- LP Builder: Analytics & Form Handling -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
(function() {
  var SUPABASE_URL = "${supabaseUrl}";
  var SUPABASE_ANON_KEY = "${anonKey}";
  var PROJECT_ID = "${projectId}";
  var VARIANT_ID = ${variantId ? `"${variantId}"` : "null"};
  var TEST_ID = ${testId ? `"${testId}"` : "null"};
  var EMAIL_ENABLED = ${emailEnabled ? "true" : "false"};
  ${metaPixelSnippet}

  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var sessionId = crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36));

  // Persistent visitor_id — survives refreshes, so dashboard can count unique visitors
  var visitorId;
  try {
    visitorId = localStorage.getItem('mlp_visitor_id');
    if (!visitorId) {
      visitorId = crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem('mlp_visitor_id', visitorId);
    }
  } catch (e) {
    // Fallback if localStorage is blocked (private browsing, iframe, etc.)
    visitorId = sessionId;
  }

  function trackEvent(eventType, eventData) {
    var data = eventData || {};
    data.visitor_id = visitorId;
    var row = {
      event_type: eventType,
      event_data: data,
      source: "lp-builder",
      session_id: sessionId,
      project_id: PROJECT_ID
    };
    if (VARIANT_ID) row.variant_id = VARIANT_ID;
    if (TEST_ID) row.test_id = TEST_ID;
    sb.from("analytics_events").insert(row).then(function() {});
  }

  trackEvent("page_view", {
    referrer: document.referrer || null,
    url: window.location.href,
    user_agent: navigator.userAgent
  });

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

  document.addEventListener("click", function(e) {
    var el = e.target.closest('[data-cta], button[type="submit"], .cta-button, a.cta');
    if (el) {
      var btnType = el.matches('button[type="submit"]') ? 'submit'
                  : (el.matches('[data-cta], .cta-button, a.cta') ? 'cta' : 'other');
      trackEvent("button_click", {
        button: btnType,
        text: (el.textContent || "").trim().slice(0, 100),
        tag: el.tagName,
        href: el.href || null
      });
    }
  });

  var form = document.getElementById("lp-email-form") || document.querySelector("form");
  if (form) {
    var submitting = false; // in-flight guard — survives across submit events, works even with no submit button
    form.addEventListener("submit", function(e) {
      e.preventDefault();
      if (submitting) return;

      var emailInput = form.querySelector('input[type="email"], input[name="email"]');

      var email = emailInput ? emailInput.value.trim() : "";
      if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        alert("Please enter a valid email address.");
        return;
      }

      // email / first_name / last_name / phone map to dedicated columns; every
      // OTHER named field on the form is swept into metadata (jsonb) so the
      // customer can collect arbitrary extra details later with no schema change.
      var leadData = {
        email: email,
        project_id: PROJECT_ID,
        source: "lp-builder"
      };
      if (VARIANT_ID) leadData.variant_id = VARIANT_ID;
      if (TEST_ID) leadData.test_id = TEST_ID;

      var firstNameInput = form.querySelector('input[name="first_name"]');
      var lastNameInput  = form.querySelector('input[name="last_name"]');
      var phoneInput     = form.querySelector('input[name="phone"], input[type="tel"]');
      if (firstNameInput && firstNameInput.value.trim()) leadData.first_name = firstNameInput.value.trim();
      if (lastNameInput && lastNameInput.value.trim())   leadData.last_name  = lastNameInput.value.trim();
      if (phoneInput && phoneInput.value.trim())          leadData.phone     = phoneInput.value.trim();

      // Sweep every OTHER named field into metadata. Skip the dedicated columns —
      // by their ACTUAL matched field name, so an email/phone matched via type=
      // (e.g. <input type="tel" name="mobile">) isn't ALSO duplicated here — plus
      // control/hidden inputs (CSRF/honeypot/UTM noise) and disabled fields.
      // Same-name fields (checkbox groups, multi-selects) accumulate into an array
      // so a marketer's multi-value custom field isn't silently collapsed.
      var RESERVED = { email: 1, first_name: 1, last_name: 1, phone: 1 };
      [emailInput, firstNameInput, lastNameInput, phoneInput].forEach(function(el) {
        if (el && el.name) RESERVED[el.name] = 1;
      });
      var SKIP_TYPES = { hidden: 1, password: 1, file: 1, submit: 1, button: 1, reset: 1, image: 1 };
      var metadata = {};
      function addMeta(key, val) {
        if (metadata[key] === undefined) { metadata[key] = val; return; }
        if (!Array.isArray(metadata[key])) metadata[key] = [metadata[key]];
        metadata[key].push(val);
      }
      form.querySelectorAll('input[name], select[name], textarea[name]').forEach(function(field) {
        var key = field.name;
        if (!key || RESERVED[key] || field.disabled || SKIP_TYPES[field.type]) return;
        if (field.type === "checkbox") {
          if (!field.checked) return; // unchecked = no value, like an empty text field
          // explicit value="..." kept verbatim; a bare checkbox (default value "on") records true
          addMeta(key, field.hasAttribute("value") ? field.value : true);
        } else if (field.type === "radio") {
          if (!field.checked) return;
          addMeta(key, field.value);
        } else if (field.tagName === "SELECT" && field.multiple) {
          Array.prototype.forEach.call(field.selectedOptions || [], function(o) { addMeta(key, o.value); });
        } else {
          var val = (field.value || "").trim();
          if (val === "") return;
          addMeta(key, val);
        }
      });
      if (Object.keys(metadata).length) leadData.metadata = metadata;

      // Guard against a double-submit creating two rows while the insert is in flight.
      // Prefer an explicit submit control; only fall back to a typeless <button>
      // (defaults to submit per spec) so a leading decorative button isn't disabled.
      var submitBtn = form.querySelector('button[type="submit"], input[type="submit"]')
                   || form.querySelector('button:not([type])');
      submitting = true;
      if (submitBtn) submitBtn.disabled = true;

      // Fail loud: if the lead does NOT persist, never pretend it did. We do not
      // fire lead_captured (that would inflate the dashboard's lead count and mask
      // the failure) and we do not show the thank-you — we surface a retry message.
      function showLeadError() {
        submitting = false;
        if (submitBtn) submitBtn.disabled = false;
        var errEl = document.getElementById("lp-lead-error");
        if (!errEl) {
          errEl = document.createElement("div");
          errEl.id = "lp-lead-error";
          errEl.setAttribute("role", "alert");
          errEl.style.cssText = "margin-top:12px;padding:10px 14px;border-radius:8px;background:#fdecea;color:#b71c1c;font-size:14px;text-align:center;";
          form.appendChild(errEl);
        }
        errEl.textContent = "אופס, לא הצלחנו לשמור את הפרטים. נסו שוב בעוד רגע.";
      }

      sb.from("leads").insert(leadData).then(function(result) {
        if (result.error) {
          console.error("Lead insert error:", result.error);
          showLeadError();
          return;
        }

        trackEvent("lead_captured", { email: email });
        ${metaEventCode}

        if (EMAIL_ENABLED) {
          fetch("/api/send-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email, project_id: PROJECT_ID })
          }).catch(function(err) { console.error("Email send error:", err); });
        }

        var thankyouEl = document.querySelector('[data-editable="thankyou_text"]');
        if (thankyouEl) {
          thankyouEl.style.display = "block";
          form.style.display = "none";
          __twemojiParse(thankyouEl);
        } else {
          form.innerHTML = '<div style="text-align:center;padding:32px 16px;"><p style="font-size:1.4em;font-weight:700;margin-bottom:8px;">Thank you!</p><p>We received your details.</p></div>';
          __twemojiParse(form);
        }
      }, function(err) {
        // Network / transport rejection (insert never reached the DB).
        console.error("Lead insert failed:", err);
        showLeadError();
      });
    });
  }

  // Render all emoji on the page as SVG via Twemoji — LAST statement of the IIFE.
  __twemojiParse(document.body);
})();
</script>
`;
}

/**
 * Fetch a variant's HTML and apply all overrides + inject analytics script.
 * Returns the final HTML string ready to send.
 */
/**
 * Replace the <title> tag content with the project name.
 */
export function applyPageTitle(html, projectName) {
  if (!projectName) return html;
  return html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(projectName)}</title>`);
}

/**
 * Fetch a variant's HTML and apply all overrides + inject analytics script.
 * Returns the final HTML string ready to send.
 */
export async function fetchAndRenderVariant(projectId, variantId, testId, projectName) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  const variantRes = await fetch(
    `${SUPABASE_URL}/rest/v1/project_variants?id=eq.${encodeURIComponent(variantId)}&select=generated_html&limit=1`,
    { headers }
  );
  if (!variantRes.ok) return { html: null, error: "Failed to fetch variant" };
  const variants = await variantRes.json();
  if (!variants.length || !variants[0].generated_html) {
    return { html: null, error: "Variant not found" };
  }

  let html = variants[0].generated_html;

  // Replace <title> with project name
  html = applyPageTitle(html, projectName);

  const overridesRes = await fetch(
    `${SUPABASE_URL}/rest/v1/lp_editable_content?variant_id=eq.${encodeURIComponent(variantId)}&select=key,value`,
    { headers }
  );
  if (overridesRes.ok) {
    const overrides = await overridesRes.json();
    html = applyOverrides(html, overrides);
  }

  const imageRes = await fetch(
    `${SUPABASE_URL}/rest/v1/lp_image_content?variant_id=eq.${encodeURIComponent(variantId)}&select=slot,image_url,display_size,display_shape&enabled=eq.true`,
    { headers }
  );
  if (imageRes.ok) {
    const imageOverrides = await imageRes.json();
    html = applyImageOverrides(html, imageOverrides);
  }

  const projRes = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=email_enabled,meta_pixel_id&limit=1`,
    { headers }
  );
  let emailEnabled = false;
  let metaPixelId = META_PIXEL_ID; // per-project override below; null/empty => global
  if (projRes.ok) {
    const projs = await projRes.json();
    if (projs.length > 0) {
      emailEnabled = projs[0].email_enabled === true;
      const perProject = (projs[0].meta_pixel_id || "").toString().trim();
      if (perProject) metaPixelId = perProject;
    }
  }

  const injectedScript = buildInjectedScript(
    projectId, variantId, testId,
    SUPABASE_ANON_KEY, SUPABASE_URL, emailEnabled, metaPixelId
  );

  if (html.includes("</body>")) {
    html = html.replace("</body>", injectedScript + "\n</body>");
  } else {
    html += injectedScript;
  }

  return { html, error: null };
}
