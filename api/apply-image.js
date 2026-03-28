// Vercel Serverless Function — apply (save) a selected image to a slot
import { verifyUser, canAccessProject } from "./lib/auth-helper.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Cache an external image to Supabase Storage if not already cached.
 * Returns the Supabase Storage public URL.
 */
async function ensureCached(imageUrl, source, sourceMeta) {
  // Already in our storage — no caching needed
  if (imageUrl.includes(SUPABASE_URL)) return imageUrl;

  // Fetch and cache
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const ext = contentType.includes("png") ? "png" : "jpg";

  let filename;
  if (source === "pexels" && sourceMeta?.pexels_id) {
    filename = `pexels_${sourceMeta.pexels_id}.${ext}`;
  } else {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    filename = `${ts}_${rand}.${ext}`;
  }

  const folder = source === "pexels" ? "cached" : source === "imagen" ? "generated" : "uploads";
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
  if (!uploadRes.ok) throw new Error(`Storage upload failed: ${uploadRes.status}`);

  return `${SUPABASE_URL}/storage/v1/object/public/lp-images/${path}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { project_id, variant_id, slot, image_url, source, source_meta, access_token } = req.body;
    if (!project_id || !variant_id || !slot || !image_url || !source || !access_token) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify user has access (role-based)
    const user = await verifyUser(access_token);
    if (!user) return res.status(401).json({ error: "Invalid token" });

    const hasAccess = await canAccessProject(user.id, project_id);
    if (!hasAccess) return res.status(403).json({ error: "You do not have access to this project" });

    // Cache image to storage
    const cachedUrl = await ensureCached(image_url, source, source_meta || {});

    // Upsert into lp_image_content (on_conflict targets the UNIQUE constraint on variant_id, slot)
    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/lp_image_content?on_conflict=variant_id,slot`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({
          project_id,
          variant_id,
          slot,
          image_url: cachedUrl,
          source,
          source_meta: source_meta || {},
          enabled: true,
        }),
      }
    );

    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      console.error("Upsert failed:", err);
      return res.status(500).json({ error: "Failed to save image" });
    }

    // Also update the image URL inside generated_html so the preview reflects the change
    const variantRes = await fetch(
      `${SUPABASE_URL}/rest/v1/project_variants?id=eq.${encodeURIComponent(variant_id)}&select=generated_html`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const variants = await variantRes.json();
    if (variants?.length && variants[0].generated_html) {
      let html = variants[0].generated_html;
      // Replace src in <img data-image-slot="hero|fold2"> tags
      const regex = new RegExp(`(<img[^>]*data-image-slot=["']${slot}["'][^>]*src=["'])([^"']+)(["'])`, 'g');
      const updatedHtml = html.replace(regex, `$1${cachedUrl}$3`);
      // Also handle case where src comes before data-image-slot
      const regex2 = new RegExp(`(<img[^>]*src=["'])([^"']+)(["'][^>]*data-image-slot=["']${slot}["'])`, 'g');
      const finalHtml = updatedHtml.replace(regex2, `$1${cachedUrl}$3`);

      if (finalHtml !== html) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/project_variants?id=eq.${encodeURIComponent(variant_id)}`,
          {
            method: "PATCH",
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ generated_html: finalHtml }),
          }
        );
      }
    }

    return res.status(200).json({ success: true, cached_url: cachedUrl });
  } catch (err) {
    console.error("apply-image error:", err);
    return res.status(500).json({ error: "Failed to apply image" });
  }
}
