// Vercel Serverless Function — search stock photos, generate AI images, or get directions
import Anthropic from "@anthropic-ai/sdk";
import { verifyUser, canAccessProject } from "./_lib/auth-helper.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const APP_ORIGIN = process.env.APP_URL || "https://messaginglab-guydotan55s-projects.vercel.app";

async function searchPexels(query, orientation = "landscape") {
  const res = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=8&orientation=${orientation}`,
    { headers: { Authorization: PEXELS_API_KEY } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.photos || []).map((p) => ({
    url: p.src.large2x,
    thumbnail_url: p.src.medium,
    source_meta: {
      pexels_id: String(p.id),
      original_url: p.src.large2x,
      photographer: p.photographer,
    },
  }));
}

async function generateImagen(prompt, aspectRatio = "16:9") {
  if (!GOOGLE_AI_API_KEY) throw new Error("GOOGLE_AI_API_KEY not configured");

  // Use Gemini 2.5 Flash Image model for native image generation
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GOOGLE_AI_API_KEY}`,
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

  if (!res.ok) {
    const errText = await res.text();
    console.error("Gemini image gen error:", res.status, errText);
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  // Find the image part in the response
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith("image/"));
  if (!imagePart) {
    console.error("Gemini returned no image:", JSON.stringify(data).slice(0, 300));
    throw new Error("Gemini returned no image in response");
  }
  const b64 = imagePart.inlineData.data;
  const mimeType = imagePart.inlineData.mimeType;
  const ext = mimeType.includes("png") ? "png" : "jpg";

  // Cache to Supabase Storage
  const buffer = Buffer.from(b64, "base64");
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `generated/${timestamp}_${rand}.${ext}`;

  const uploadRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/lp-images/${path}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": mimeType,
        "x-upsert": "true",
      },
      body: buffer,
    }
  );
  if (!uploadRes.ok) throw new Error("Failed to cache image to storage");

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/lp-images/${path}`;
  return [{
    url: publicUrl,
    thumbnail_url: publicUrl,
    source_meta: { prompt, aspect_ratio: aspectRatio },
  }];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { action, direction, source_type, slot, access_token, project_id } = req.body;

    // ── Action: directions ──────────────────────────────
    if (action === 'directions') {
      if (!project_id || !access_token) return res.status(400).json({ error: "Missing project_id or access_token" });
      const user = await verifyUser(access_token);
      if (!user) return res.status(401).json({ error: "Invalid token" });
      const hasAccess = await canAccessProject(user.id, project_id);
      if (!hasAccess) return res.status(403).json({ error: "No access" });

      const projRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}&select=*`,
        { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const projects = await projRes.json();
      if (!projects?.length) return res.status(404).json({ error: "Project not found" });
      const project = projects[0];

      const q = project.questionnaire_data || {};
      const briefLines = [`Business: ${project.name || "Untitled"}`];
      if (q.what_you_do) briefLines.push(`What they do: ${q.what_you_do}`);
      if (q.target_audience) briefLines.push(`Audience: ${q.target_audience}`);
      if (q.main_benefit) briefLines.push(`Benefit: ${q.main_benefit}`);
      if (q.story) briefLines.push(`Story: ${q.story}`);
      if (q.brief) briefLines.push(`Brief: ${q.brief}`);

      const client = new Anthropic();
      async function callClaude(includeImage) {
        const userContent = [];
        if (includeImage && project.image_url) {
          userContent.push({ type: "image", source: { type: "url", url: project.image_url } });
        }
        userContent.push({ type: "text", text: `Based on this landing page brief, suggest 3 different visual directions for imagery. Each direction should be a short description (8-15 words) of a scene or mood that would work as a hero/section image.\n\nThe directions should:\n- All be relevant to the brand and its story\n- Each take a DIFFERENT visual approach\n- Have a Mediterranean aesthetic — warm tones, authentic, not generic stock\n${includeImage && project.image_url ? "- Be inspired by the mood and style of the attached reference image" : ""}\n\nBRIEF:\n${briefLines.join("\n")}\n\nRespond in this exact JSON format (no markdown fences):\n{\n  "directions": [\n    "direction 1 description",\n    "direction 2 description",\n    "direction 3 description"\n  ]\n}` });
        return await client.messages.create({ model: "claude-haiku-4-5", max_tokens: 300, temperature: 1, messages: [{ role: "user", content: userContent }] });
      }

      let response;
      try { response = await callClaude(true); } catch { response = await callClaude(false); }
      let text = response.content[0].text.trim();
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      return res.status(200).json(JSON.parse(text));
    }

    // ── Action: search/generate (default) ───────────────
    if (!direction || !source_type || !access_token) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify user token is valid
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${access_token}` },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Invalid token" });

    const orientation = slot === "fold2" ? "portrait" : "landscape";
    const aspectRatio = slot === "fold2" ? "4:3" : "16:9";

    let results = [];

    if (source_type === "pexels") {
      results = await searchPexels(direction, orientation);
    } else if (source_type === "imagen") {
      results = await generateImagen(direction, aspectRatio) || [];
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error("search-images error:", err?.message || err);
    return res.status(500).json({ error: `Image search failed: ${err?.message || String(err)}` });
  }
}
