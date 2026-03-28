// Vercel Serverless Function — generates LP HTML via Claude API (multimodal)
import Anthropic from "@anthropic-ai/sdk";
import { verifyUser, canAccessProject } from "./lib/auth-helper.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
// ANTHROPIC_API_KEY is auto-read by the SDK

/**
 * Build a text brief from the project data for Claude.
 */
function buildBrief(project) {
  const q = project.questionnaire_data || {};
  const lang = project.language || "he";
  const lines = [];

  lines.push(`Business/Project Name: ${project.name || "Untitled"}`);

  if (lang === "he") {
    lines.push("Language: Hebrew (RTL)");
  } else {
    lines.push("Language: English (LTR)");
  }

  if (q.what_you_do) lines.push(`What they do: ${q.what_you_do}`);
  if (q.target_audience) lines.push(`Target audience: ${q.target_audience}`);
  if (q.main_benefit) lines.push(`Main benefit / value proposition: ${q.main_benefit}`);
  if (q.story) lines.push(`Brand story: ${q.story}`);

  if (q.features && Array.isArray(q.features) && q.features.length > 0) {
    lines.push("Features / Benefits:");
    for (const f of q.features) {
      if (f.title) {
        lines.push(`  - ${f.title}${f.description ? ": " + f.description : ""}`);
      }
    }
  }

  if (q.social_proof) lines.push(`Social proof / testimonials: ${q.social_proof}`);
  if (q.badges) lines.push(`Trust badges / certifications: ${q.badges}`);
  if (q.price) lines.push(`Price: ${q.price}`);
  if (q.price_description) lines.push(`Price description: ${q.price_description}`);
  if (q.cta_text) lines.push(`CTA button text: ${q.cta_text}`);
  if (q.thankyou_text) lines.push(`Thank-you message: ${q.thankyou_text}`);
  if (q.color_preference) lines.push(`Color preference: ${q.color_preference}`);
  if (q.tone) lines.push(`Tone / voice: ${q.tone}`);

  // Brief mode: the brief text is stored in questionnaire_data.brief
  if (q.brief) {
    lines.push("");
    lines.push("Free-form brief:");
    lines.push(q.brief);
  }

  if (project.brief_text) {
    lines.push("");
    lines.push("Additional brief / notes:");
    lines.push(project.brief_text);
  }

  return lines.join("\n");
}

/**
 * Build the system prompt instructing Claude how to generate the LP.
 */
function buildSystemPrompt(imageMode, resolvedImages) {
  return `You are an expert landing page designer and front-end developer.
Your job is to create a complete, production-ready, single-file HTML landing page based on the provided brief and inspiration image.

CRITICAL RULES:
1. Return ONLY raw HTML starting with <!DOCTYPE html>. No markdown fences, no explanations, no commentary.
2. The output must be a single self-contained HTML file with all CSS inside <style> tags and minimal JS inside <script> tags.
3. Set dir="rtl" on <html> for Hebrew or dir="ltr" for English based on the language in the brief.
4. Use appropriate Google Fonts:
   - Hebrew: choose from Heebo, Assistant, Secular One, Rubik (use at least 2 — one display, one body)
   - English: choose distinctive, modern display fonts paired with a clean body font
5. Include ALL of these sections (skip only if data is clearly not provided):
   - Hero section with headline + subtitle + CTA button
   - Story / About section
   - Features / Benefits section (use cards, grid, or icons)
   - Social proof section (if testimonials/reviews data is given)
   - Pricing section (if price data is given)
   - Email signup form
   - Footer
6. The email form MUST have id="lp-email-form" with an input[type="email"][name="email"] and a submit button.
7. Include a hidden thank-you element: <div data-editable="thankyou_text" style="display:none;">Thank you message here</div> — place it right after the form.
8. Add data-editable attributes to these elements so text can be edited later:
   - data-editable="hero_title" on the main hero headline
   - data-editable="hero_subtitle" on the hero subtitle
   - data-editable="story_title" on the story/about section headline (e.g. "הסיפור שלי")
   - data-editable="story_text" on the story/about paragraph
   - data-editable="features_title" on the features/benefits section headline
   - data-editable="features_subtitle" on the features/benefits section subtitle (if exists)
   - data-editable="feature_1_icon" on the first feature card icon/emoji element (a small span or div containing only the emoji)
   - data-editable="feature_1_title" on the first feature card title
   - data-editable="feature_1_text" on the first feature card description
   - data-editable="feature_2_icon" on the second feature card icon/emoji element
   - data-editable="feature_2_title" on the second feature card title
   - data-editable="feature_2_text" on the second feature card description
   - data-editable="feature_3_icon" on the third feature card icon/emoji element
   - data-editable="feature_3_title" on the third feature card title
   - data-editable="feature_3_text" on the third feature card description
   - data-editable="cta_text" on the primary CTA button text
   - data-editable="form_title" on the form section headline
   - data-editable="form_subtitle" on the form section subtitle/description text (e.g. "השאירו את כתובת המייל שלכם")
   - data-editable="thankyou_text" on the hidden thank-you element
   - data-editable="footer_text" on the footer paragraph/text element
9. Add class="cta-button" and data-cta="true" to ALL CTA buttons.
10. MOBILE IS THE #1 PRIORITY — 95% of traffic comes from mobile devices:
    - Design mobile-first: start with the mobile layout, then enhance for larger screens
    - The page MUST look perfect and identical in visual quality on mobile and desktop
    - All decorative elements (arches, frames, shapes, borders) must be visible and properly sized on mobile too
    - Use relative units (%, vw, vh, rem, em), flexbox, CSS grid
    - Font sizes must be readable on small screens (min 16px body text)
    - Buttons must be touch-friendly (min 48px height, full-width on mobile)
    - Padding/margins should use clamp() or responsive values
    - Test-proof: no horizontal scroll, no cut-off elements, no hidden content on mobile
    - Hero section should fit within the mobile viewport without excessive empty space
${imageMode === "with_images" && resolvedImages ? `11. IMAGE PLACEMENT RULES:
    - You have been provided with real image URLs. Use them in the HTML.
    - Hero section MUST include: <img data-image-slot="hero" src="${resolvedImages.hero?.url}" alt="[contextual alt text]" style="width:100%;height:100%;object-fit:cover;">
    ${resolvedImages.fold2 ? `- Second fold section MUST include: <img data-image-slot="fold2" src="${resolvedImages.fold2.url}" alt="[contextual alt text]" style="width:100%;object-fit:cover;">` : "- No second fold image — use CSS-only design for other sections."}
    - Design the color palette, typography, and mood to COMPLEMENT the provided images
    - Hero image can be used as: full-width background behind text, partial overlay, side-by-side with text, or contained block — choose the best approach for the design
    - Images must be responsive (width:100%, height:auto or object-fit:cover)
    - The data-image-slot attribute is REQUIRED on each image — do not remove it
    - Do NOT add any other <img> tags beyond the provided slots
    - Use CSS gradients, shapes, patterns for other decorative elements` :
`11. Create a UNIQUE, visually striking design inspired by the uploaded image's color palette, mood, and style:
    - Extract dominant colors from the image and use them as the page palette
    - Use CSS gradients, shapes, patterns, and decorative elements for visual interest
    - Do NOT use any external images or placeholder image URLs
    - All visual elements must be pure CSS (gradients, borders, shadows, shapes)`}
12. DO NOT include:
    - Analytics code or tracking scripts
    - Form submission handlers or JavaScript form logic
    - Supabase client or any database code
    - External JavaScript libraries
    - Comments like "<!-- Add your tracking code here -->"
    These will be injected server-side.
13. Use semantic HTML5 elements (section, header, nav, main, footer).
14. Ensure excellent contrast ratios and accessibility basics (alt texts, aria-labels where needed).
15. Add subtle CSS animations (fade-in, slide-up) for visual polish. Use @keyframes, not JS.`;
}

/**
 * Extract data-editable keys and their default text content from the generated HTML.
 */
function extractEditableKeys(html) {
  const results = [];
  const regex = /<[^>]*\bdata-editable\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[^>]+>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const key = match[1];
    // Strip HTML tags from inner content to get plain text
    const rawText = match[2].replace(/<[^>]*>/g, "").trim();
    results.push({ key, default_value: rawText });
  }
  return results;
}

/**
 * Strip markdown code fences if Claude wraps the output.
 */
function stripMarkdownFences(text) {
  let result = text.trim();
  // Remove leading ```html or ```
  if (result.startsWith("```html")) {
    result = result.slice(7);
  } else if (result.startsWith("```")) {
    result = result.slice(3);
  }
  // Remove trailing ```
  if (result.endsWith("```")) {
    result = result.slice(0, -3);
  }
  return result.trim();
}

/**
 * Send admin notification email via Brevo (non-blocking, fire-and-forget).
 */
function sendAdminNotification(project, userEmail) {
  const adminEmail = "guydotan55@gmail.com";

  const slug = project.slug || "no-slug";
  const language = project.language || "unknown";

  fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": BREVO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sender: { name: "LP Builder", email: "noreply@lpbuilder.com" },
      to: [{ email: adminEmail }],
      subject: `New LP Created: ${project.name || "Untitled"}`,
      htmlContent: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>New Landing Page Generated</h2>
          <table style="border-collapse: collapse; width: 100%;">
            <tr><td style="padding: 8px; font-weight: bold;">Project:</td><td style="padding: 8px;">${project.name || "Untitled"}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold;">User Email:</td><td style="padding: 8px;">${userEmail || "unknown"}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold;">Slug:</td><td style="padding: 8px;">${slug}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold;">Language:</td><td style="padding: 8px;">${language}</td></tr>
          </table>
        </div>
      `,
      textContent: `New LP Created\nProject: ${project.name}\nUser: ${userEmail}\nSlug: ${slug}\nLanguage: ${language}`,
    }),
  }).catch((err) => {
    console.error("Admin notification email failed:", err);
  });
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { project_id, variant_id, access_token } = req.body || {};

  // Validate required params
  if (!project_id) {
    return res.status(400).json({ error: "Missing required parameter: project_id" });
  }
  if (!access_token) {
    return res.status(401).json({ error: "Missing required parameter: access_token" });
  }

  try {
    // 1. Fetch project from Supabase
    const projectRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}&select=*&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!projectRes.ok) {
      console.error("Supabase project fetch error:", projectRes.status);
      return res.status(500).json({ error: "Failed to fetch project" });
    }

    const projects = await projectRes.json();
    if (!projects || projects.length === 0) {
      return res.status(404).json({ error: "Project not found" });
    }

    const project = projects[0];

    // 2. Verify user has access to the project (role-based)
    const user = await verifyUser(access_token);
    if (!user) return res.status(401).json({ error: "Invalid token" });

    const hasAccess = await canAccessProject(user.id, project_id);
    if (!hasAccess) return res.status(403).json({ error: "You do not have access to this project" });

    // Check for resolved_images from client (two-phase generation)
    const resolved_images = req.body.resolved_images || null;
    const imageMode = project.image_mode || "css_only";

    // 3. Build the brief from project data
    const briefText = buildBrief(project);

    // 4. Build messages for Claude API
    const systemPrompt = buildSystemPrompt(imageMode, resolved_images);

    // Build user message content — text brief + optional image + optional brief file
    const userContent = [];

    // If project has an image URL, include it as multimodal input
    const imageUrl = project.image_url;

    if (imageUrl) {
      userContent.push({
        type: "image",
        source: {
          type: "url",
          url: imageUrl,
        },
      });
    }

    // If a brief file was uploaded (PDF/DOCX), include it as a document
    const q = project.questionnaire_data || {};
    const briefFileUrl = q.brief_file_url;

    if (briefFileUrl) {
      userContent.push({
        type: "document",
        source: {
          type: "url",
          url: briefFileUrl,
        },
        title: "Uploaded brief document",
      });
    }

    // Add the text brief
    let briefIntro = "";
    if (imageMode === "with_images" && resolved_images?.hero) {
      briefIntro = "You have been provided with real image URLs to use in the landing page. Design the page around these images.";
      briefIntro += `\n\nHero image URL: ${resolved_images.hero.url}`;
      if (resolved_images.fold2) {
        briefIntro += `\nSecond fold image URL: ${resolved_images.fold2.url}`;
      }
    }
    if (imageUrl) {
      briefIntro += (briefIntro ? "\n" : "") + "Here is the inspiration image for the design. Use its color palette, mood, and visual style as the basis for the landing page design.";
    }
    if (briefFileUrl) {
      briefIntro += (briefIntro ? "\n" : "") + "A brief document has been attached above — incorporate its content into the landing page design.";
    }
    if (!imageUrl && !briefFileUrl && !resolved_images) {
      briefIntro = "(No inspiration image was provided. Create a visually striking design using a modern, professional color palette that matches the brand's tone.)";
    }

    userContent.push({
      type: "text",
      text: `${briefIntro}\n\n--- BRIEF ---\n${briefText}`,
    });

    // 5. Call Claude API with streaming for large output
    const client = new Anthropic();

    const stream = client.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
    });

    const finalMessage = await stream.finalMessage();

    // Extract the text content from the response
    let generatedHtml = "";
    for (const block of finalMessage.content) {
      if (block.type === "text") {
        generatedHtml += block.text;
      }
    }

    if (!generatedHtml) {
      return res.status(500).json({ error: "Claude returned empty response" });
    }

    // Strip markdown fences if present
    generatedHtml = stripMarkdownFences(generatedHtml);

    // Validate it looks like HTML
    if (!generatedHtml.startsWith("<!DOCTYPE") && !generatedHtml.startsWith("<html")) {
      console.error("Generated content does not look like HTML:", generatedHtml.slice(0, 200));
      return res.status(500).json({ error: "Generated content is not valid HTML" });
    }

    // 6. Resolve or create the variant to save HTML into
    let activeVariantId = variant_id;

    if (!activeVariantId) {
      // Check if a default variant exists for this project
      const existingVarRes = await fetch(
        `${SUPABASE_URL}/rest/v1/project_variants?project_id=eq.${encodeURIComponent(project_id)}&is_default=eq.true&select=id&limit=1`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      const existingVars = existingVarRes.ok ? await existingVarRes.json() : [];

      if (existingVars.length > 0) {
        activeVariantId = existingVars[0].id;
      } else {
        // Create a default variant
        const createVarRes = await fetch(
          `${SUPABASE_URL}/rest/v1/project_variants`,
          {
            method: "POST",
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({
              project_id: project_id,
              variant_slug: "default",
              variant_name: "Default",
              is_default: true,
              status: "draft",
            }),
          }
        );
        if (createVarRes.ok) {
          const created = await createVarRes.json();
          activeVariantId = created[0].id;
        }
      }
    }

    // Save generated HTML to the variant
    if (activeVariantId) {
      const updateVarRes = await fetch(
        `${SUPABASE_URL}/rest/v1/project_variants?id=eq.${encodeURIComponent(activeVariantId)}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ generated_html: generatedHtml }),
        }
      );
      if (!updateVarRes.ok) {
        console.error("Failed to save variant HTML:", updateVarRes.status);
      }
    }

    // Also keep projects.generated_html in sync for backward compat
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ generated_html: generatedHtml }),
      }
    );

    if (!updateRes.ok) {
      console.error("Failed to save generated HTML to project:", updateRes.status);
    }

    // 7. Extract editable content keys and save defaults to lp_editable_content
    const editableKeys = extractEditableKeys(generatedHtml);

    if (editableKeys.length > 0) {
      // Delete existing editable content for this variant (or project if no variant)
      const deleteFilter = activeVariantId
        ? `variant_id=eq.${encodeURIComponent(activeVariantId)}`
        : `project_id=eq.${encodeURIComponent(project_id)}`;

      await fetch(
        `${SUPABASE_URL}/rest/v1/lp_editable_content?${deleteFilter}`,
        {
          method: "DELETE",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );

      // Insert new editable content rows
      const rows = editableKeys.map((ek) => ({
        project_id: project_id,
        variant_id: activeVariantId || null,
        key: ek.key,
        value: ek.default_value,
      }));

      const insertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/lp_editable_content`,
        {
          method: "POST",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(rows),
        }
      );

      if (!insertRes.ok) {
        console.error("Failed to save editable content:", insertRes.status);
      }
    }

    // 7b. Save resolved images to lp_image_content (if with_images mode)
    if (imageMode === "with_images" && resolved_images && activeVariantId) {
      // Delete existing image content for this variant
      await fetch(
        `${SUPABASE_URL}/rest/v1/lp_image_content?variant_id=eq.${encodeURIComponent(activeVariantId)}`,
        {
          method: "DELETE",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );

      // Insert image rows
      const imageRows = [];
      if (resolved_images.hero) {
        imageRows.push({
          project_id,
          variant_id: activeVariantId,
          slot: "hero",
          image_url: resolved_images.hero.url,
          source: resolved_images.hero.source,
          source_meta: resolved_images.hero.meta || {},
        });
      }
      if (resolved_images.fold2) {
        imageRows.push({
          project_id,
          variant_id: activeVariantId,
          slot: "fold2",
          image_url: resolved_images.fold2.url,
          source: resolved_images.fold2.source,
          source_meta: resolved_images.fold2.meta || {},
        });
      }

      if (imageRows.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/lp_image_content`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(imageRows),
        });
      }
    }

    // 8. Send admin notification (non-blocking)
    sendAdminNotification(project, user.email);

    // 9. Return success response
    return res.status(200).json({
      success: true,
      preview_html: generatedHtml,
      editable_keys: editableKeys,
      variant_id: activeVariantId || null,
    });
  } catch (err) {
    console.error("generate-lp error:", err);
    return res.status(500).json({ error: "Internal server error: " + String(err.message || err) });
  }
}
