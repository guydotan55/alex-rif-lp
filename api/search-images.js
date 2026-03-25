// Vercel Serverless Function — search stock photos or generate AI image for a direction
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;

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

  // First, discover which models support image generation
  const listRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${GOOGLE_AI_API_KEY}`
  );
  if (listRes.ok) {
    const listData = await listRes.json();
    const imageModels = (listData.models || []).filter(m =>
      m.supportedGenerationMethods?.some(method =>
        method === "generateImages" || method === "generateContent"
      ) && (m.name?.includes("imagen") || m.name?.includes("gemini"))
    ).map(m => `${m.name} [${(m.supportedGenerationMethods||[]).join(",")}]`);
    console.log("Available image-capable models:", imageModels.join(" | "));
  }

  // Use Gemini 2.0 Flash with native image generation
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

  if (!res.ok) {
    const errText = await res.text();
    console.error("Gemini image gen error:", res.status, errText);
    // On 404, list available models to help diagnose
    if (res.status === 404 && listRes?.ok) {
      const listData = await listRes.json().catch(() => null);
      if (!listData) {
        // listRes already consumed, re-fetch
      }
    }
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { direction, source_type, slot, access_token } = req.body;
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
