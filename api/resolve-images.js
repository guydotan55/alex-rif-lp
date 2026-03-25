// Vercel Serverless Function — resolves images for LP generation
import Anthropic from "@anthropic-ai/sdk";
import { verifyUser, canAccessProject } from "./lib/auth-helper.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;

/**
 * Ask Haiku to generate a Pexels search query + Imagen prompt
 * based on the project brief and optional inspiration image.
 */
async function analyzeWithHaiku(briefText, inspirationUrl, slot) {
  const client = new Anthropic();
  const userContent = [];

  if (inspirationUrl) {
    userContent.push({
      type: "image",
      source: { type: "url", url: inspirationUrl },
    });
  }

  userContent.push({
    type: "text",
    text: `Based on this brief for a landing page, generate a stock photo search query and an AI image generation prompt for the ${slot === "hero" ? "hero section (main visual, top of page)" : "second fold (story/about section)"}.

The images should have a Mediterranean aesthetic — warm tones, authentic-looking people, not generic Western stock photos.
${slot === "hero" ? "Orientation: landscape, 16:9 aspect ratio." : "Orientation: portrait or square, 4:3 aspect ratio."}
${inspirationUrl ? "Use the attached image as mood/style reference — match its warmth, setting, and feeling." : ""}

BRIEF:
${briefText}

Respond in this exact JSON format (no markdown fences):
{
  "pexels_query": "english search query for Pexels, 3-5 words",
  "imagen_prompt": "detailed prompt for AI image generation, 1-2 sentences describing the exact scene"
}`,
  });

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content[0].text.trim();
  return JSON.parse(text);
}

/**
 * Search Pexels for stock photos.
 * Returns array of { url, thumbnail_url, pexels_id, photographer }.
 */
async function searchPexels(query, orientation = "landscape") {
  const res = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=8&orientation=${orientation}`,
    { headers: { Authorization: PEXELS_API_KEY } }
  );
  if (!res.ok) {
    if (res.status === 429) console.warn("Pexels rate limit hit");
    return [];
  }
  const data = await res.json();
  return (data.photos || []).map((p) => ({
    url: p.src.large2x,
    thumbnail_url: p.src.medium,
    pexels_id: String(p.id),
    photographer: p.photographer,
  }));
}

/**
 * Generate an image via Google Imagen API.
 * Returns { url, prompt } or null on failure.
 */
async function generateImagen(prompt, aspectRatio = "16:9") {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GOOGLE_AI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `Generate a high-quality professional photograph: ${prompt}. Aspect ratio: ${aspectRatio}. Style: editorial, warm Mediterranean tones, authentic feel.` }]
          }],
          generationConfig: {
            responseModalities: ["IMAGE", "TEXT"],
          },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith("image/"));
    if (!imagePart) return null;
    return { base64: imagePart.inlineData.data, prompt };
  } catch (e) {
    console.error("Image generation failed:", e.message);
    return null;
  }
}

/**
 * Cache an image to Supabase Storage.
 * Returns the public URL.
 */
async function cacheToStorage(imageData, folder, filename) {
  let buffer, contentType;

  if (imageData.base64) {
    buffer = Buffer.from(imageData.base64, "base64");
    contentType = "image/png";
  } else if (imageData.url) {
    const res = await fetch(imageData.url);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
    contentType = res.headers.get("content-type") || "image/jpeg";
  }

  const path = `${folder}/${filename}`;
  const uploadRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/lp-images/${path}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": contentType,
        "x-upsert": "true",
      },
      body: buffer,
    }
  );

  if (!uploadRes.ok) {
    throw new Error(`Storage upload failed: ${uploadRes.status}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/lp-images/${path}`;
}

/**
 * Resolve a single image slot.
 * Returns { url, source, meta } or null.
 */
async function resolveSlot(briefText, project, slot) {
  const q = project.questionnaire_data || {};

  // Check for "use directly" upload — stored in questionnaire_data
  const directKey = slot === "hero" ? "hero_image_url" : "fold2_image_url";
  const directUrl = q[directKey];
  if (directUrl && q[`${directKey}_mode`] === "direct") {
    return { url: directUrl, source: "upload", meta: { original_url: directUrl } };
  }

  // Get inspiration image (either slot-specific or project-level)
  const inspirationUrl =
    (q[`${directKey}_mode`] === "inspiration" ? directUrl : null) ||
    project.image_url;

  // Haiku analysis
  let analysis;
  try {
    analysis = await analyzeWithHaiku(briefText, inspirationUrl, slot);
  } catch (e) {
    console.error("Haiku analysis failed:", e.message);
    // Fallback: use business name as search query
    analysis = {
      pexels_query: `${project.name || "professional"} background`,
      imagen_prompt: `Professional, warm-toned background image for ${project.name || "a business"} landing page`,
    };
  }

  // Run Pexels + Imagen in parallel
  const orientation = slot === "hero" ? "landscape" : "portrait";
  const aspectRatio = slot === "hero" ? "16:9" : "4:3";

  const [pexelsResults, imagenResult] = await Promise.all([
    searchPexels(analysis.pexels_query, orientation),
    generateImagen(analysis.imagen_prompt, aspectRatio),
  ]);

  // Auto-pick: prefer Pexels (free), fallback to Imagen
  if (pexelsResults.length > 0) {
    const picked = pexelsResults[0];
    const cachedUrl = await cacheToStorage(
      { url: picked.url },
      "cached",
      `pexels_${picked.pexels_id}.jpg`
    );
    return {
      url: cachedUrl,
      source: "pexels",
      meta: {
        pexels_id: picked.pexels_id,
        original_url: picked.url,
        photographer: picked.photographer,
        search_query: analysis.pexels_query,
      },
    };
  }

  if (imagenResult) {
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const cachedUrl = await cacheToStorage(
      { base64: imagenResult.base64 },
      "generated",
      `${timestamp}_${rand}.png`
    );
    return {
      url: cachedUrl,
      source: "imagen",
      meta: {
        prompt: imagenResult.prompt,
        aspect_ratio: aspectRatio,
      },
    };
  }

  // Both failed — return null (caller falls back to CSS-only)
  console.warn(`Both Pexels and Imagen failed for slot: ${slot}`);
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { project_id, access_token } = req.body;
    if (!project_id || !access_token) {
      return res.status(400).json({ error: "Missing project_id or access_token" });
    }

    // Verify user has access (role-based)
    const user = await verifyUser(access_token);
    if (!user) return res.status(401).json({ error: "Invalid token" });

    const hasAccess = await canAccessProject(user.id, project_id);
    if (!hasAccess) return res.status(403).json({ error: "You do not have access to this project" });

    // Fetch project
    const projRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}&select=*`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const projects = await projRes.json();
    if (!projects?.length) return res.status(404).json({ error: "Project not found" });
    const project = projects[0];

    if (project.image_mode !== "with_images") {
      return res.status(200).json({ hero: null, fold2: null, mode: "css_only" });
    }

    // Build brief for Haiku
    const q = project.questionnaire_data || {};
    const briefLines = [];
    briefLines.push(`Business: ${project.name || "Untitled"}`);
    if (q.what_you_do) briefLines.push(`What they do: ${q.what_you_do}`);
    if (q.target_audience) briefLines.push(`Audience: ${q.target_audience}`);
    if (q.main_benefit) briefLines.push(`Benefit: ${q.main_benefit}`);
    if (q.story) briefLines.push(`Story: ${q.story}`);
    if (q.brief) briefLines.push(`Brief: ${q.brief}`);
    const briefText = briefLines.join("\n");

    // Resolve hero (required)
    const hero = await resolveSlot(briefText, project, "hero");
    if (!hero) {
      // Hero failed — fall back to CSS-only for entire LP
      return res.status(200).json({ hero: null, fold2: null, mode: "css_only_fallback" });
    }

    // Resolve fold2 (optional — check if user enabled it)
    let fold2 = null;
    if (q.fold2_enabled) {
      fold2 = await resolveSlot(briefText, project, "fold2");
      // fold2 failure is non-fatal — just skip it
    }

    return res.status(200).json({ hero, fold2, mode: "with_images" });
  } catch (err) {
    console.error("resolve-images error:", err);
    return res.status(500).json({ error: "Image resolution failed" });
  }
}
