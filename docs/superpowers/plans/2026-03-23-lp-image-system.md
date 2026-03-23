# LP Image System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add image support to the LP generator with 3 sources (upload, Pexels stock, Google Imagen), post-generation image swapping, and CSS-only fallback.

**Architecture:** Two-phase generation: client calls `/api/resolve-images` first (Haiku + Pexels + Imagen), then `/api/generate-lp` with resolved URLs. Post-generation image swap via `/api/image-directions`, `/api/search-images`, `/api/apply-image`. Served images swapped at render time in `serve-lp.js` using `data-image-slot` attributes, mirroring the existing `data-editable` text override pattern.

**Tech Stack:** Anthropic Claude API (Haiku for image analysis, Opus for LP generation), Pexels API, Google Imagen API, Supabase (Postgres + Storage), Vercel Serverless Functions, vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-03-23-lp-image-system-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `supabase/migrations/add_image_support.sql` | DB migration: `lp_image_content` table + `projects.image_mode` column + RLS policies |
| `api/resolve-images.js` | Image resolution pipeline: Haiku analysis → Pexels + Imagen parallel fetch → auto-pick → cache to storage |
| `api/image-directions.js` | Generate 3 visual directions from brief via Haiku |
| `api/search-images.js` | Search Pexels or generate Imagen for a given direction |
| `api/apply-image.js` | Cache selected image to storage + upsert `lp_image_content` |

### Modified Files
| File | What Changes |
|------|-------------|
| `api/generate-lp.js` | Accept `resolved_images` param, conditional prompt (CSS-only vs with-images), save images to `lp_image_content` |
| `api/serve-lp.js` | Fetch image overrides from `lp_image_content`, replace `src` on `data-image-slot` elements |
| `new.html` | New Step 6 (Image Preferences): image mode toggle, upload with direct/inspiration choice, fold2 toggle |
| `dashboard.html` | Image hover overlay on preview, Image Picker modal (3 tabs), two-phase generation progress, regeneration warning |

---

## IMPORTANT NOTES FOR IMPLEMENTERS

1. **Dashboard Supabase client variable:** The dashboard uses `sb` (not `supabase`) as the Supabase client. All dashboard JS must use `sb.from(...)`, `sb.auth.getSession()`, etc.
2. **Step cards use `data-step` attribute:** In `new.html`, steps are selected via `.step-card[data-step="${n}"]`. New steps must use `data-step="N"` not `id="stepN"`.
3. **Step card HTML structure:** Use `step-num`, `step-title`, `step-subtitle` classes inside `step-header`. See existing steps for exact pattern.
4. **Dashboard progress UI:** Uses `gen-progress` with `gen-spinner` and `gen-progress-text` (not a progress bar with fill). Toggle visibility via `.classList.add('show')` / `.remove('show')`.
5. **Supabase Storage bucket `lp-images`:** Verify it exists before running any image operations. If it doesn't exist, create it in the Supabase dashboard.
6. **Google Imagen API:** Verify the exact endpoint and request format for your authentication method (API key vs service account). The code in this plan uses the Generative Language API format — adjust if using Vertex AI.
7. **Escaping user content:** Direction text from Haiku is inserted into DOM — always use `textContent` or escape HTML before `innerHTML`.

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/add_image_support.sql`

- [ ] **Step 0: Verify `lp-images` storage bucket exists**

In the Supabase dashboard → Storage, verify the `lp-images` bucket exists. If not, create it as a public bucket. The existing codebase uses it for uploads.

- [ ] **Step 1: Write the migration SQL**

```sql
-- Migration: Add image support to LP generator
-- Run via Supabase SQL editor

-- 1. Add image_mode column to projects
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS image_mode TEXT NOT NULL DEFAULT 'css_only';

-- 2. Create lp_image_content table
CREATE TABLE IF NOT EXISTS public.lp_image_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES public.project_variants(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  image_url TEXT NOT NULL,
  source TEXT NOT NULL,
  source_meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (variant_id, slot)
);

-- 3. RLS policies for lp_image_content (mirrors lp_editable_content pattern)
ALTER TABLE public.lp_image_content ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own images" ON public.lp_image_content
  FOR SELECT USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can insert own images" ON public.lp_image_content
  FOR INSERT WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can update own images" ON public.lp_image_content
  FOR UPDATE USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can delete own images" ON public.lp_image_content
  FOR DELETE USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

CREATE POLICY "Managers can read all images" ON public.lp_image_content
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid() AND up.is_manager = true
    )
  );

CREATE POLICY "Managers can update all images" ON public.lp_image_content
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid() AND up.is_manager = true
    )
  );

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_image_content_variant ON public.lp_image_content(variant_id);
CREATE INDEX IF NOT EXISTS idx_image_content_project ON public.lp_image_content(project_id);
```

- [ ] **Step 2: Run migration in Supabase SQL editor**

Copy the SQL and run it in the Supabase dashboard SQL editor. Verify:
- `projects` table has `image_mode` column with default `'css_only'`
- `lp_image_content` table exists with correct columns
- RLS policies are active (check via `SELECT * FROM pg_policies WHERE tablename = 'lp_image_content'`)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/add_image_support.sql
git commit -m "feat: add lp_image_content table and image_mode column"
```

---

## Task 2: Image Resolution Pipeline (`api/resolve-images.js`)

**Files:**
- Create: `api/resolve-images.js`

**Context:** This endpoint is called by the dashboard client before `generate-lp`. It analyzes the brief, searches Pexels, generates via Imagen, auto-picks the best result, caches it to Supabase Storage, and returns resolved URLs. Reference `api/remix-answer.js` for endpoint structure (CORS headers, auth pattern).

- [ ] **Step 1: Create the endpoint with Haiku analysis**

```javascript
// Vercel Serverless Function — resolves images for LP generation
import Anthropic from "@anthropic-ai/sdk";

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
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${GOOGLE_AI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const b64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return null;
    return { base64: b64, prompt };
  } catch (e) {
    console.error("Imagen generation failed:", e.message);
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

    // Verify user owns this project
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${access_token}` },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Invalid token" });
    const user = await userRes.json();

    // Fetch project
    const projRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}&select=*`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const projects = await projRes.json();
    if (!projects?.length) return res.status(404).json({ error: "Project not found" });
    const project = projects[0];
    if (user.id !== project.user_id) return res.status(403).json({ error: "Forbidden" });

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
```

- [ ] **Step 2: Add environment variables**

Add to Vercel environment:
- `PEXELS_API_KEY` — get from https://www.pexels.com/api/
- `GOOGLE_AI_API_KEY` — get from Google AI Studio

- [ ] **Step 3: Test the endpoint locally**

```bash
cd "/Users/a/Claude-Projects/בבואה/LPs Generator (alex_rif_style)"
npx vercel dev
```

Test with curl:
```bash
curl -X POST http://localhost:3000/api/resolve-images \
  -H "Content-Type: application/json" \
  -d '{"project_id":"<test_project_id>","access_token":"<test_token>"}'
```

Expected: JSON with `{ hero: { url, source, meta }, fold2: null, mode: "with_images" }`

- [ ] **Step 4: Commit**

```bash
git add api/resolve-images.js
git commit -m "feat: add resolve-images endpoint with Haiku + Pexels + Imagen pipeline"
```

---

## Task 3: Image Directions Endpoint (`api/image-directions.js`)

**Files:**
- Create: `api/image-directions.js`

**Context:** Called when user opens the image swap modal. Returns 3 visual direction descriptions based on the brief. Simple Haiku call.

- [ ] **Step 1: Create the endpoint**

```javascript
// Vercel Serverless Function — generates 3 visual directions for image swapping
import Anthropic from "@anthropic-ai/sdk";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

    // Verify user
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${access_token}` },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Invalid token" });
    const user = await userRes.json();

    // Fetch project
    const projRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}&select=*`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const projects = await projRes.json();
    if (!projects?.length) return res.status(404).json({ error: "Project not found" });
    const project = projects[0];
    if (user.id !== project.user_id) return res.status(403).json({ error: "Forbidden" });

    // Build brief summary
    const q = project.questionnaire_data || {};
    const briefLines = [];
    briefLines.push(`Business: ${project.name || "Untitled"}`);
    if (q.what_you_do) briefLines.push(`What they do: ${q.what_you_do}`);
    if (q.target_audience) briefLines.push(`Audience: ${q.target_audience}`);
    if (q.main_benefit) briefLines.push(`Benefit: ${q.main_benefit}`);
    if (q.story) briefLines.push(`Story: ${q.story}`);
    if (q.brief) briefLines.push(`Brief: ${q.brief}`);

    const client = new Anthropic();
    const userContent = [];

    // Include inspiration image if available
    if (project.image_url) {
      userContent.push({
        type: "image",
        source: { type: "url", url: project.image_url },
      });
    }

    userContent.push({
      type: "text",
      text: `Based on this landing page brief, suggest 3 different visual directions for imagery. Each direction should be a short description (8-15 words) of a scene or mood that would work as a hero/section image.

The directions should:
- All be relevant to the brand and its story
- Each take a DIFFERENT visual approach (e.g., people/community, environment/setting, symbolic/abstract)
- Have a Mediterranean aesthetic — warm tones, authentic, not generic stock
${project.image_url ? "- Be inspired by the mood and style of the attached reference image" : ""}

BRIEF:
${briefLines.join("\n")}

Respond in this exact JSON format (no markdown fences):
{
  "directions": [
    "direction 1 description",
    "direction 2 description",
    "direction 3 description"
  ]
}`,
    });

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content[0].text.trim();
    const parsed = JSON.parse(text);
    return res.status(200).json(parsed);
  } catch (err) {
    console.error("image-directions error:", err);
    return res.status(500).json({ error: "Failed to generate directions" });
  }
}
```

- [ ] **Step 2: Test locally**

```bash
curl -X POST http://localhost:3000/api/image-directions \
  -H "Content-Type: application/json" \
  -d '{"project_id":"<test_id>","access_token":"<test_token>"}'
```

Expected: `{ "directions": ["...", "...", "..."] }`

- [ ] **Step 3: Commit**

```bash
git add api/image-directions.js
git commit -m "feat: add image-directions endpoint for swap modal"
```

---

## Task 4: Search Images Endpoint (`api/search-images.js`)

**Files:**
- Create: `api/search-images.js`

**Context:** Called when user picks a direction in the swap modal. Searches Pexels or generates via Imagen.

- [ ] **Step 1: Create the endpoint**

```javascript
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
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${GOOGLE_AI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const b64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return null;

    // Cache to Supabase Storage
    const buffer = Buffer.from(b64, "base64");
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const path = `generated/${timestamp}_${rand}.png`;

    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/lp-images/${path}`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "image/png",
          "x-upsert": "true",
        },
        body: buffer,
      }
    );
    if (!uploadRes.ok) return null;

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/lp-images/${path}`;
    return [{
      url: publicUrl,
      thumbnail_url: publicUrl,
      source_meta: { prompt, aspect_ratio: aspectRatio },
    }];
  } catch (e) {
    console.error("Imagen failed:", e.message);
    return null;
  }
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
    console.error("search-images error:", err);
    return res.status(500).json({ error: "Image search failed" });
  }
}
```

- [ ] **Step 2: Test locally with Pexels**

```bash
curl -X POST http://localhost:3000/api/search-images \
  -H "Content-Type: application/json" \
  -d '{"direction":"warm candlelit gathering intimate","source_type":"pexels","slot":"hero","access_token":"<token>"}'
```

Expected: `{ "results": [{ "url": "...", "thumbnail_url": "...", "source_meta": {...} }, ...] }`

- [ ] **Step 3: Test with Imagen**

```bash
curl -X POST http://localhost:3000/api/search-images \
  -H "Content-Type: application/json" \
  -d '{"direction":"Warm Mediterranean community gathering at sunset","source_type":"imagen","slot":"hero","access_token":"<token>"}'
```

Expected: `{ "results": [{ "url": "https://...supabase.co/storage/...", "source_meta": { "prompt": "..." } }] }`

- [ ] **Step 4: Commit**

```bash
git add api/search-images.js
git commit -m "feat: add search-images endpoint for Pexels and Imagen"
```

---

## Task 5: Apply Image Endpoint (`api/apply-image.js`)

**Files:**
- Create: `api/apply-image.js`

**Context:** Called when user confirms an image selection in the swap modal. Caches external images to Supabase Storage and upserts into `lp_image_content`.

- [ ] **Step 1: Create the endpoint**

```javascript
// Vercel Serverless Function — apply (save) a selected image to a slot
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

    // Verify user owns the project
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${access_token}` },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Invalid token" });
    const user = await userRes.json();

    const projRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(project_id)}&select=user_id`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const projects = await projRes.json();
    if (!projects?.length || projects[0].user_id !== user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

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
        }),
      }
    );

    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      console.error("Upsert failed:", err);
      return res.status(500).json({ error: "Failed to save image" });
    }

    return res.status(200).json({ success: true, cached_url: cachedUrl });
  } catch (err) {
    console.error("apply-image error:", err);
    return res.status(500).json({ error: "Failed to apply image" });
  }
}
```

- [ ] **Step 2: Test locally**

```bash
curl -X POST http://localhost:3000/api/apply-image \
  -H "Content-Type: application/json" \
  -d '{"project_id":"<id>","variant_id":"<id>","slot":"hero","image_url":"https://images.pexels.com/photos/12345/pexels-photo-12345.jpeg","source":"pexels","source_meta":{"pexels_id":"12345"},"access_token":"<token>"}'
```

Expected: `{ "success": true, "cached_url": "https://...supabase.co/storage/..." }`

Verify: row exists in `lp_image_content` table with correct data.

- [ ] **Step 3: Commit**

```bash
git add api/apply-image.js
git commit -m "feat: add apply-image endpoint for caching and saving image selections"
```

---

## Task 6: Modify `generate-lp.js` for Image Support

**Files:**
- Modify: `api/generate-lp.js:67-121` (buildSystemPrompt), `api/generate-lp.js:258-307` (user content), `api/generate-lp.js:433-478` (post-generation save)

- [ ] **Step 1: Update `buildSystemPrompt` to accept image mode**

In `api/generate-lp.js`, change the function signature and rule 11:

```javascript
// Change: function buildSystemPrompt()
// To: function buildSystemPrompt(imageMode, resolvedImages)
function buildSystemPrompt(imageMode, resolvedImages) {
```

Replace rule 11 (lines 106-110) conditionally. Current rule 11:
```
11. Create a UNIQUE, visually striking design inspired by the uploaded image's color palette, mood, and style:
    - Extract dominant colors from the image and use them as the page palette
    - Use CSS gradients, shapes, patterns, and decorative elements for visual interest
    - Do NOT use any external images or placeholder image URLs
    - All visual elements must be pure CSS (gradients, borders, shadows, shapes)
```

New logic — after the return template literal for the system prompt, make rule 11 conditional:

Replace the entire `buildSystemPrompt` function body. In the template literal, change rule 11 to use a ternary:

```javascript
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
```

- [ ] **Step 2: Update the handler to accept `resolved_images` and pass to prompt**

In the handler function, after fetching the project (around line 240), add:

```javascript
    // Check for resolved_images from client (two-phase generation)
    const resolved_images = req.body.resolved_images || null;
    const imageMode = project.image_mode || "css_only";
```

Update the `buildSystemPrompt` call (line 259):

```javascript
    const systemPrompt = buildSystemPrompt(imageMode, resolved_images);
```

Update the user content brief intro (lines 293-302) to include image URLs:

```javascript
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
```

- [ ] **Step 3: Save resolved images to `lp_image_content` after generation**

After the editable keys insertion (after line 478), add:

```javascript
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
```

- [ ] **Step 4: Test end-to-end locally**

1. Set a test project's `image_mode` to `'with_images'` in Supabase
2. Call `resolve-images` → get resolved URLs
3. Call `generate-lp` with the resolved URLs in `resolved_images`
4. Verify the generated HTML contains `data-image-slot="hero"` and the correct `src` URL
5. Verify `lp_image_content` has rows for the variant

- [ ] **Step 5: Commit**

```bash
git add api/generate-lp.js
git commit -m "feat: update generate-lp to support with_images mode and resolved_images"
```

---

## Task 7: Modify `serve-lp.js` for Image Overrides

**Files:**
- Modify: `api/serve-lp.js:20-36` (add image override function), `api/serve-lp.js:262-275` (apply overrides)

- [ ] **Step 1: Add `applyImageOverrides` function**

Add after the existing `applyOverrides` function (after line 36):

```javascript
/**
 * Apply image overrides: replace src of elements with data-image-slot="slot"
 * Each override has a `slot` and `image_url` from the lp_image_content table.
 */
function applyImageOverrides(html, imageOverrides) {
  if (!imageOverrides || imageOverrides.length === 0) return html;

  for (const { slot, image_url } of imageOverrides) {
    if (!slot || !image_url) continue;
    // Match <img ... data-image-slot="slot" ... src="..." ...>
    // Handle src before or after data-image-slot
    const regex1 = new RegExp(
      `(<img\\b[^>]*data-image-slot\\s*=\\s*"${slot}"[^>]*\\bsrc=")([^"]*)(")`,
      "gi"
    );
    const regex2 = new RegExp(
      `(<img\\b[^>]*\\bsrc=")([^"]*)("[^>]*data-image-slot\\s*=\\s*"${slot}")`,
      "gi"
    );
    html = html.replace(regex1, `$1${image_url}$3`);
    html = html.replace(regex2, `$1${image_url}$3`);
  }

  return html;
}
```

- [ ] **Step 2: Fetch and apply image overrides in the handler**

After the text overrides are applied (after line 274), add:

```javascript
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
```

Also add the same block in the backward-compat fallback path (around line 237, where `project.generated_html` is used without variants). In that path, fetch by `project_id` instead of `variant_id`.

- [ ] **Step 3: Test locally**

1. Generate an LP with images (from Task 6)
2. Manually update `lp_image_content.image_url` to a different URL
3. Visit `/lp/<slug>` and verify the served HTML has the updated image URL
4. Verify existing text overrides still work

- [ ] **Step 4: Commit**

```bash
git add api/serve-lp.js
git commit -m "feat: add image override support to serve-lp"
```

---

## Task 8: Update Creation Form (`new.html`)

**Files:**
- Modify: `new.html`

**Context:** Add a new Step 6 (Image Preferences) to the questionnaire wizard. Current step 6 (Email Settings) becomes step 7. The step includes: image mode toggle, hero upload with direct/inspiration choice, fold2 toggle.

- [ ] **Step 1: Add Step 6 HTML and renumber existing steps**

First, renumber the current Step 6 (Email Settings) to Step 7:
- In `new.html`, find `<div class="step-card" data-step="6">` (the Email Settings step, around line 1131)
- Change `data-step="6"` to `data-step="7"`
- Change `<div class="step-num">שלב 6 מתוך 6</div>` to `<div class="step-num">שלב 7 מתוך 7</div>`

Then update ALL existing steps' "מתוך 6" text to "מתוך 7" (steps 1-5).

Insert the new step card after Step 5's closing `</div>` (after the Visual Identity step, around line 1129) and before the renumbered Step 7:

```html
<!-- ── Step 6: Image Preferences ─────────────────────────── -->
<div class="step-card" data-step="6">
  <div class="step-header">
    <div class="step-num">שלב 6 מתוך 7</div>
    <h2 class="step-title">תמונות</h2>
    <p class="step-subtitle">האם תרצו תמונות בדף הנחיתה?</p>
  </div>

  <div class="toggle-group" style="display:flex;gap:10px;justify-content:center;margin-bottom:24px;">
    <button type="button" class="toggle-btn active" onclick="setImageMode('with_images')" id="btn-with-images">
      כן, עם תמונות
    </button>
    <button type="button" class="toggle-btn" onclick="setImageMode('css_only')" id="btn-css-only">
      לא, עיצוב בלבד
    </button>
  </div>

  <div id="image-options" style="margin-top:16px;">
    <!-- Hero image upload -->
    <div class="field-group">
      <label class="field-label">תמונת Hero</label>
      <p class="field-hint">התמונה הראשית בראש העמוד</p>
      <div class="upload-zone" id="heroUploadZone" onclick="document.getElementById('heroFileInput').click()">
        <input type="file" id="heroFileInput" accept="image/*" style="display:none;" onchange="handleHeroUpload(event)">
        <img id="heroUploadPreview" style="display:none;max-width:100%;border-radius:8px;">
        <div id="heroUploadPrompt">
          <div style="font-size:28px;margin-bottom:8px;">📷</div>
          <div>העלו תמונה</div>
          <div style="font-size:12px;color:#999;margin-top:4px;">JPG, PNG, WebP עד 5MB</div>
        </div>
        <div class="upload-progress" id="heroUploadProgress" style="display:none;">
          <div class="upload-progress-fill" id="heroUploadProgressFill"></div>
        </div>
      </div>
      <div class="hero-image-mode-choice" id="heroModeChoice" style="display:none;margin-top:12px;text-align:center;">
        <p style="font-size:13px;color:#777;margin-bottom:10px;">איך להשתמש בתמונה?</p>
        <div style="display:flex;gap:8px;justify-content:center;">
          <button type="button" class="toggle-btn active" onclick="setHeroImageMode('direct')" id="btn-hero-direct">
            השתמשו בתמונה הזו
          </button>
          <button type="button" class="toggle-btn" onclick="setHeroImageMode('inspiration')" id="btn-hero-inspiration">
            השתמשו כהשראה
          </button>
        </div>
        <p style="font-size:11px;color:#aaa;margin-top:8px;max-width:360px;margin-left:auto;margin-right:auto;">
          "השראה" אומר שננתח את האווירה, הסגנון והצבעים כדי למצוא או ליצור תמונה מתאימה עבורכם
        </p>
      </div>
      <p id="heroSkipHint" style="text-align:center;color:#bbb;font-size:12px;margin-top:10px;">
        או דלגו — נמצא תמונה מתאימה אוטומטית לפי התיאור שלכם
      </p>
      <p id="err-hero-image" class="error-msg" style="display:none;"></p>
    </div>

    <!-- Fold 2 toggle -->
    <div class="field-group" style="margin-top:20px;border-top:1px solid #eee;padding-top:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <label class="field-label">תמונת Fold שני</label>
          <p class="field-hint">אופציונלי — מוסיף תמונה לחלק הסיפור</p>
        </div>
        <label class="switch">
          <input type="checkbox" id="fold2Toggle" onchange="toggleFold2()">
          <span class="slider"></span>
        </label>
      </div>
      <div id="fold2UploadSection" style="display:none;margin-top:12px;">
        <!-- Same upload zone structure as hero, with fold2 prefix -->
        <div class="upload-zone" id="fold2UploadZone" onclick="document.getElementById('fold2FileInput').click()">
          <input type="file" id="fold2FileInput" accept="image/*" style="display:none;" onchange="handleFold2Upload(event)">
          <img id="fold2UploadPreview" style="display:none;max-width:100%;border-radius:8px;">
          <div id="fold2UploadPrompt">
            <div style="font-size:28px;margin-bottom:8px;">📷</div>
            <div>העלו תמונה</div>
          </div>
        </div>
        <div id="fold2ModeChoice" style="display:none;margin-top:12px;text-align:center;">
          <div style="display:flex;gap:8px;justify-content:center;">
            <button type="button" class="toggle-btn active" onclick="setFold2ImageMode('direct')" id="btn-fold2-direct">
              השתמשו בתמונה הזו
            </button>
            <button type="button" class="toggle-btn" onclick="setFold2ImageMode('inspiration')" id="btn-fold2-inspiration">
              השתמשו כהשראה
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add JavaScript handlers**

Add these variables and functions to the script section:

```javascript
let imageMode = 'with_images';
let heroImageUrl = null;
let heroImageMode = 'direct'; // 'direct' or 'inspiration'
let fold2Enabled = false;
let fold2ImageUrl = null;
let fold2ImageMode = 'direct';

function setImageMode(mode) {
  imageMode = mode;
  document.getElementById('btn-with-images').classList.toggle('active', mode === 'with_images');
  document.getElementById('btn-css-only').classList.toggle('active', mode === 'css_only');
  document.getElementById('image-options').style.display = mode === 'with_images' ? 'block' : 'none';
}

function setHeroImageMode(mode) {
  heroImageMode = mode;
  document.getElementById('btn-hero-direct').classList.toggle('active', mode === 'direct');
  document.getElementById('btn-hero-inspiration').classList.toggle('active', mode === 'inspiration');
}

function setFold2ImageMode(mode) {
  fold2ImageMode = mode;
  document.getElementById('btn-fold2-direct').classList.toggle('active', mode === 'direct');
  document.getElementById('btn-fold2-inspiration').classList.toggle('active', mode === 'inspiration');
}

function toggleFold2() {
  fold2Enabled = document.getElementById('fold2Toggle').checked;
  document.getElementById('fold2UploadSection').style.display = fold2Enabled ? 'block' : 'none';
}

async function handleHeroUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  // Reuse existing upload logic pattern from the current image upload
  // Upload to Supabase Storage lp-images/uploads/
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const ext = file.name.split('.').pop();
  const path = `uploads/${timestamp}_${rand}.${ext}`;

  document.getElementById('heroUploadProgress').style.display = 'block';
  document.getElementById('heroUploadPrompt').style.display = 'none';

  const { data, error } = await supabase.storage.from('lp-images').upload(path, file);
  if (error) {
    document.getElementById('err-hero-image').textContent = 'שגיאה בהעלאה: ' + error.message;
    document.getElementById('err-hero-image').style.display = 'block';
    document.getElementById('heroUploadProgress').style.display = 'none';
    document.getElementById('heroUploadPrompt').style.display = 'block';
    return;
  }

  const { data: urlData } = supabase.storage.from('lp-images').getPublicUrl(path);
  heroImageUrl = urlData.publicUrl;

  document.getElementById('heroUploadPreview').src = heroImageUrl;
  document.getElementById('heroUploadPreview').style.display = 'block';
  document.getElementById('heroUploadProgress').style.display = 'none';
  document.getElementById('heroModeChoice').style.display = 'block';
  document.getElementById('heroSkipHint').style.display = 'none';
}

async function handleFold2Upload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const ext = file.name.split('.').pop();
  const path = `uploads/${timestamp}_${rand}.${ext}`;

  document.getElementById('fold2UploadPrompt').style.display = 'none';

  const { data, error } = await supabase.storage.from('lp-images').upload(path, file);
  if (error) return;

  const { data: urlData } = supabase.storage.from('lp-images').getPublicUrl(path);
  fold2ImageUrl = urlData.publicUrl;

  document.getElementById('fold2UploadPreview').src = fold2ImageUrl;
  document.getElementById('fold2UploadPreview').style.display = 'block';
  document.getElementById('fold2ModeChoice').style.display = 'block';
}
```

- [ ] **Step 3: Update step navigation**

Update the total step count from 6 to 7. Key changes:

1. Find `const TOTAL_STEPS = 6` (or equivalent) and change to 7
2. In the `goNext()` / final step button logic: the final step submit trigger was on step 6, now it's on step 7. Find where `currentStep === 6` triggers `submitQuestionnaire()` and change to `currentStep === 7`
3. In `goToStep()`: step navigation uses `.step-card[data-step="${step}"]` — no change needed since we used `data-step`
4. Step 6 validation: no required fields (image upload is optional). Add to the validation function:
   ```javascript
   if (currentStep === 6) return true; // Image step — all optional
   ```

- [ ] **Step 4: Update `submitQuestionnaire` to include image data**

In the `submitQuestionnaire` function, add image fields to the questionnaire data:

```javascript
// Add to the questionnaire_data object being saved:
const questionnaireData = {
  // ... existing fields ...
  hero_image_url: heroImageUrl || null,
  hero_image_url_mode: heroImageUrl ? heroImageMode : null,
  fold2_enabled: fold2Enabled,
  fold2_image_url: fold2ImageUrl || null,
  fold2_image_url_mode: fold2ImageUrl ? fold2ImageMode : null,
};
```

And add `image_mode` to the project insert:

```javascript
// In the project insert, add:
image_mode: imageMode,
```

- [ ] **Step 5: Update validation to make image upload optional**

In the step validation function, find where step 5 requires `uploadedImageUrl` (around line 1385-1388). Make it optional:

```javascript
// Change from:
// if (currentStep === 5 && !uploadedImageUrl) { ... }
// To: no validation on step 5 for image (or keep it only for the existing inspiration image)
```

- [ ] **Step 6: Test the form**

1. Open `/new.html`
2. Fill steps 1-5
3. On step 6: toggle between "With images" and "CSS only"
4. Upload a hero image → verify direct/inspiration choice appears
5. Toggle fold2 on → verify upload zone appears
6. Submit → verify project is created with `image_mode` and image data in `questionnaire_data`

- [ ] **Step 7: Commit**

```bash
git add new.html
git commit -m "feat: add image preferences step to creation form"
```

---

## Task 9: Update Dashboard — Two-Phase Generation & Progress

**Files:**
- Modify: `dashboard.html`

**Context:** The `generateLP()` function (line 1570) currently calls `generate-lp` directly. Update it to: (1) call `resolve-images` first if `image_mode = "with_images"`, (2) then call `generate-lp` with resolved URLs, (3) show progress states for each phase.

- [ ] **Step 1: Update `generateLP()` function**

Replace the existing `generateLP()` function (lines 1570-1642 in dashboard.html). **IMPORTANT:** The dashboard uses `sb` as the Supabase client, and progress UI uses `gen-progress` with `gen-progress-text` (a spinner, not a progress bar fill).

```javascript
async function generateLP() {
  if (!selectedProject) return;

  // Regeneration warning if images exist
  if (selectedProject.image_mode === 'with_images') {
    const existingImages = await sb
      .from('lp_image_content')
      .select('id')
      .eq('project_id', selectedProject.id)
      .limit(1);
    if (existingImages.data?.length > 0) {
      if (!confirm('יצירה מחדש תחליף את התמונות הנוכחיות. להמשיך?')) return;
    }
  }

  const btnGen = document.getElementById('btn-generate');
  const empty = document.getElementById('preview-empty');
  const progress = document.getElementById('gen-progress');
  const progressText = progress.querySelector('.gen-progress-text');
  const wrap = document.getElementById('preview-frame-wrap');

  // Remove old iframe
  const oldFrame = wrap.querySelector('iframe');
  if (oldFrame) oldFrame.remove();

  empty.style.display = 'none';
  progress.classList.add('show');
  btnGen.disabled = true;

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error('Not authenticated');

    let resolvedImages = null;

    // Phase 1: Resolve images (if with_images mode)
    if (selectedProject.image_mode === 'with_images') {
      progressText.textContent = 'מחפש תמונות...';

      const imgRes = await fetch('/api/resolve-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: selectedProject.id,
          access_token: session.access_token
        }),
      });
      const imgData = await imgRes.json();

      if (imgData.mode === 'with_images' && imgData.hero) {
        resolvedImages = { hero: imgData.hero, fold2: imgData.fold2 };
      }
      // If mode is css_only_fallback, resolvedImages stays null
    }

    // Phase 2: Generate LP
    progressText.textContent = 'מייצר את דף הנחיתה...';

    const body = {
      project_id: selectedProject.id,
      variant_id: selectedVariant?.id || null,
      access_token: session.access_token,
    };
    if (resolvedImages) {
      body.resolved_images = resolvedImages;
    }

    const resp = await fetch('/api/generate-lp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || 'Generation failed (' + resp.status + ')');
    }

    const result = await resp.json();

    // Refresh project data (same pattern as existing code)
    const { data } = await sb.from('projects').select('*').eq('id', selectedProject.id).single();
    if (data) {
      selectedProject = data;
      const idx = projects.findIndex(p => p.id === data.id);
      if (idx >= 0) projects[idx] = data;
    }

    // Refresh variant data
    if (selectedVariant) {
      const { data: updatedVariant } = await sb.from('project_variants')
        .select('*')
        .eq('id', selectedVariant.id)
        .single();
      if (updatedVariant) {
        selectedVariant = updatedVariant;
        const vIdx = projectVariants.findIndex(v => v.id === updatedVariant.id);
        if (vIdx >= 0) projectVariants[vIdx] = updatedVariant;
      }
    }

    progress.classList.remove('show');
    renderVariantBar();
    loadPreview();
    showToast('דף הנחיתה נוצר בהצלחה!', 'success');

  } catch (err) {
    progress.classList.remove('show');
    empty.style.display = 'flex';
    showToast('שגיאה ביצירת הדף: ' + err.message, 'error');
    console.error('generate-lp:', err);
  } finally {
    btnGen.disabled = false;
  }
}
```

- [ ] **Step 2: Add progress text element to HTML**

Find the generate progress bar HTML and add a text element. Locate `generate-progress` and add:

```html
<span id="generate-progress-text" style="font-size:12px;color:#888;margin-top:4px;display:block;text-align:center;"></span>
```

- [ ] **Step 3: Test two-phase generation**

1. Set a test project's `image_mode` to `'with_images'`
2. Click Generate
3. Verify "Finding images..." appears first, then "Generating page..."
4. Verify the preview shows an LP with actual images
5. Verify `lp_image_content` has rows

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat: add two-phase generation with image resolution progress"
```

---

## Task 10: Dashboard — Image Swap UI (Image Picker Modal)

**Files:**
- Modify: `dashboard.html`

**Context:** Add hover overlay on images in the LP preview, and an Image Picker modal with 3 tabs (Upload, Stock, AI Generated). This is the largest UI task.

- [ ] **Step 1: Add Image Picker modal HTML**

Add the modal HTML before `</body>` in dashboard.html:

```html
<!-- Image Picker Modal -->
<div id="image-picker-modal" class="modal" style="display:none;">
  <div class="modal-content" style="max-width:680px;max-height:85vh;overflow-y:auto;">
    <div class="modal-header" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <h3 id="image-picker-title">החלפת תמונה</h3>
        <p style="font-size:13px;color:#999;" id="image-picker-subtitle">בחרו מקור לתמונה חדשה</p>
      </div>
      <button onclick="closeImagePicker()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#999;">&times;</button>
    </div>

    <!-- Tabs -->
    <div class="image-picker-tabs" style="display:flex;border-bottom:1px solid #eee;margin-top:16px;">
      <button class="picker-tab active" onclick="switchPickerTab('upload')" id="tab-upload">📷 העלאה</button>
      <button class="picker-tab" onclick="switchPickerTab('stock')" id="tab-stock">🔍 Stock Photo</button>
      <button class="picker-tab" onclick="switchPickerTab('ai')" id="tab-ai">✨ AI Generated</button>
    </div>

    <!-- Upload Tab -->
    <div id="picker-upload" class="picker-tab-content" style="padding:24px;">
      <div class="upload-zone" onclick="document.getElementById('pickerFileInput').click()" style="padding:32px;text-align:center;">
        <input type="file" id="pickerFileInput" accept="image/*" style="display:none;" onchange="handlePickerUpload(event)">
        <div style="font-size:28px;margin-bottom:8px;">📷</div>
        <div>גררו תמונה לכאן או לחצו להעלאה</div>
        <div style="font-size:12px;color:#999;margin-top:4px;">JPG, PNG, WebP עד 5MB</div>
      </div>
    </div>

    <!-- Stock Tab -->
    <div id="picker-stock" class="picker-tab-content" style="display:none;padding:24px;">
      <div id="stock-directions" style="margin-bottom:16px;">
        <p style="font-size:13px;color:#777;margin-bottom:10px;">בחרו כיוון ויזואלי:</p>
        <div id="stock-directions-list" style="display:flex;gap:8px;flex-wrap:wrap;">
          <div style="color:#999;font-size:13px;">טוען כיוונים...</div>
        </div>
      </div>
      <div id="stock-results" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;"></div>
      <div id="stock-loading" style="display:none;text-align:center;padding:20px;color:#999;">מחפש תמונות...</div>
    </div>

    <!-- AI Tab -->
    <div id="picker-ai" class="picker-tab-content" style="display:none;padding:24px;">
      <div id="ai-directions" style="margin-bottom:16px;">
        <p style="font-size:13px;color:#777;margin-bottom:10px;">בחרו כיוון ויזואלי:</p>
        <div id="ai-directions-list" style="display:flex;gap:8px;flex-wrap:wrap;">
          <div style="color:#999;font-size:13px;">טוען כיוונים...</div>
        </div>
      </div>
      <div id="ai-result" style="text-align:center;"></div>
      <div id="ai-loading" style="display:none;text-align:center;padding:20px;color:#999;">יוצר תמונה... (5-8 שניות)</div>
    </div>

    <!-- Apply button -->
    <div id="picker-apply-bar" style="display:none;padding:16px 24px;border-top:1px solid #eee;">
      <button onclick="applySelectedImage()" class="btn-primary" style="width:100%;">החל תמונה</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add Image Picker CSS**

```css
.picker-tab {
  flex: 1;
  padding: 12px;
  text-align: center;
  font-size: 14px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: #999;
}
.picker-tab.active {
  color: #2c2c2c;
  border-bottom-color: #2c2c2c;
  font-weight: 500;
}
.picker-tab-content { min-height: 200px; }
.stock-image-card {
  aspect-ratio: 3/2;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  border: 3px solid transparent;
  transition: border-color 0.2s;
}
.stock-image-card.selected { border-color: #2c2c2c; }
.stock-image-card img { width: 100%; height: 100%; object-fit: cover; }
.direction-chip {
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid #ddd;
  background: white;
  color: #555;
  transition: all 0.2s;
}
.direction-chip.active { background: #2c2c2c; color: white; border-color: #2c2c2c; }
```

- [ ] **Step 3: Add Image Picker JavaScript**

```javascript
let currentPickerSlot = null;  // 'hero' or 'fold2'
let pickerDirections = [];
let selectedPickerImage = null; // { url, source, source_meta }

function openImagePicker(slot) {
  currentPickerSlot = slot;
  selectedPickerImage = null;
  document.getElementById('image-picker-modal').style.display = 'flex';
  document.getElementById('image-picker-title').textContent =
    slot === 'hero' ? 'החלפת תמונת Hero' : 'החלפת תמונת Fold שני';
  document.getElementById('picker-apply-bar').style.display = 'none';
  switchPickerTab('upload');
  loadDirections();
}

function closeImagePicker() {
  document.getElementById('image-picker-modal').style.display = 'none';
  currentPickerSlot = null;
}

function switchPickerTab(tab) {
  document.querySelectorAll('.picker-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.picker-tab-content').forEach(c => c.style.display = 'none');
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('picker-' + tab).style.display = 'block';
}

async function loadDirections() {
  const { data: { session } } = await sb.auth.getSession();
  const token = session?.access_token;
  try {
    const res = await fetch('/api/image-directions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: selectedProject.id, access_token: token }),
    });
    const data = await res.json();
    pickerDirections = data.directions || [];
    renderDirections('stock-directions-list');
    renderDirections('ai-directions-list');
  } catch (e) {
    console.error('Failed to load directions:', e);
  }
}

function renderDirections(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  pickerDirections.forEach((d, i) => {
    const btn = document.createElement('button');
    btn.className = 'direction-chip';
    btn.dataset.index = i;
    btn.textContent = d; // Safe — uses textContent, not innerHTML
    btn.onclick = () => selectDirection(containerId, i);
    container.appendChild(btn);
  });
}

async function selectDirection(containerId, index) {
  const container = document.getElementById(containerId);
  container.querySelectorAll('.direction-chip').forEach((c, i) =>
    c.classList.toggle('active', i === index)
  );
  const direction = pickerDirections[index];
  const isStock = containerId.includes('stock');
  const { data: { session } } = await sb.auth.getSession();
  const token = session?.access_token;

  if (isStock) {
    document.getElementById('stock-loading').style.display = 'block';
    document.getElementById('stock-results').innerHTML = '';
    try {
      const res = await fetch('/api/search-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction, source_type: 'pexels', slot: currentPickerSlot, access_token: token
        }),
      });
      const data = await res.json();
      renderStockResults(data.results || []);
    } finally {
      document.getElementById('stock-loading').style.display = 'none';
    }
  } else {
    lastAiDirectionIndex = index;
    document.getElementById('ai-loading').style.display = 'block';
    document.getElementById('ai-result').innerHTML = '';
    try {
      const res = await fetch('/api/search-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction, source_type: 'imagen', slot: currentPickerSlot, access_token: token
        }),
      });
      const data = await res.json();
      renderAiResult(data.results || [], direction);
    } finally {
      document.getElementById('ai-loading').style.display = 'none';
    }
  }
}

function renderStockResults(results) {
  const container = document.getElementById('stock-results');
  container.innerHTML = results.map((r, i) =>
    `<div class="stock-image-card" onclick="selectStockImage(${i})">
      <img src="${r.thumbnail_url}" alt="Stock option ${i + 1}" loading="lazy">
    </div>`
  ).join('');
  // Store results for selection
  container._results = results;
}

function selectStockImage(index) {
  const container = document.getElementById('stock-results');
  container.querySelectorAll('.stock-image-card').forEach((c, i) =>
    c.classList.toggle('selected', i === index)
  );
  const result = container._results[index];
  selectedPickerImage = { url: result.url, source: 'pexels', source_meta: result.source_meta };
  document.getElementById('picker-apply-bar').style.display = 'block';
}

let lastAiDirectionIndex = 0; // Track which direction was last used for AI

function renderAiResult(results, direction) {
  if (!results.length) {
    document.getElementById('ai-result').innerHTML = '<p style="color:#999;">יצירת התמונה נכשלה. נסו כיוון אחר.</p>';
    return;
  }
  const r = results[0];
  const container = document.getElementById('ai-result');
  container.innerHTML = '';

  const img = document.createElement('img');
  img.src = r.url;
  img.alt = 'AI generated';
  img.style.cssText = 'width:100%;border-radius:12px;margin-bottom:12px;';
  container.appendChild(img);

  const retryBtn = document.createElement('button');
  retryBtn.style.cssText = 'padding:10px;background:white;border:1px solid #ddd;border-radius:8px;cursor:pointer;font-size:13px;';
  retryBtn.textContent = '🔄 יצירת וריאציה נוספת';
  retryBtn.onclick = () => selectDirection('ai-directions-list', lastAiDirectionIndex);
  container.appendChild(retryBtn);

  selectedPickerImage = { url: r.url, source: 'imagen', source_meta: r.source_meta };
  document.getElementById('picker-apply-bar').style.display = 'block';
}

async function handlePickerUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const ext = file.name.split('.').pop();
  const path = `uploads/${timestamp}_${rand}.${ext}`;

  const { error } = await sb.storage.from('lp-images').upload(path, file);
  if (error) { alert('שגיאה בהעלאה'); return; }

  const { data: urlData } = sb.storage.from('lp-images').getPublicUrl(path);
  selectedPickerImage = { url: urlData.publicUrl, source: 'upload', source_meta: {} };
  document.getElementById('picker-apply-bar').style.display = 'block';

  // Show preview
  document.getElementById('picker-upload').innerHTML = `
    <img src="${urlData.publicUrl}" style="width:100%;border-radius:8px;">
    <p style="text-align:center;color:#4ec9b0;margin-top:8px;">התמונה הועלתה בהצלחה</p>
  `;
}

async function applySelectedImage() {
  if (!selectedPickerImage || !currentPickerSlot) return;
  const { data: { session } } = await sb.auth.getSession();
  const token = session?.access_token;
  const variantId = selectedVariant?.id;
  if (!variantId) { alert('לא נבחר variant'); return; }

  try {
    const res = await fetch('/api/apply-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: selectedProject.id,
        variant_id: variantId,
        slot: currentPickerSlot,
        image_url: selectedPickerImage.url,
        source: selectedPickerImage.source,
        source_meta: selectedPickerImage.source_meta,
        access_token: token,
      }),
    });
    if (!res.ok) throw new Error('Apply failed');

    closeImagePicker();
    // Refresh preview to show new image
    loadPreview();
  } catch (e) {
    alert('שגיאה בשמירת התמונה');
  }
}
```

- [ ] **Step 4: Add image hover overlay to preview iframe**

In the `loadPreview()` function, after the iframe loads, inject a script that adds hover overlays on `data-image-slot` elements. Add this after the iframe content is set:

```javascript
// After iframe loads, inject image hover handlers
iframe.onload = function() {
  try {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    const imgSlots = iframeDoc.querySelectorAll('[data-image-slot]');
    imgSlots.forEach(img => {
      const slot = img.getAttribute('data-image-slot');
      const wrapper = iframeDoc.createElement('div');
      wrapper.style.cssText = 'position:relative;display:inline-block;width:100%;';
      img.parentNode.insertBefore(wrapper, img);
      wrapper.appendChild(img);

      const overlay = iframeDoc.createElement('div');
      overlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;cursor:pointer;z-index:100;';
      overlay.innerHTML = `<div style="background:white;padding:10px 20px;border-radius:8px;font-family:sans-serif;font-size:14px;font-weight:600;">🖼️ החלפת תמונה</div>`;

      wrapper.appendChild(overlay);
      wrapper.addEventListener('mouseenter', () => overlay.style.display = 'flex');
      wrapper.addEventListener('mouseleave', () => overlay.style.display = 'none');
      overlay.addEventListener('click', () => {
        window.parent.postMessage({ type: 'open-image-picker', slot }, '*');
      });
    });
  } catch(e) { /* cross-origin iframe — skip */ }
};
```

Add a message listener in the dashboard:

```javascript
window.addEventListener('message', (event) => {
  if (event.data?.type === 'open-image-picker') {
    openImagePicker(event.data.slot);
  }
});
```

- [ ] **Step 5: Test the full swap flow**

1. Generate an LP with images
2. Preview in dashboard
3. Hover over hero image → verify overlay appears
4. Click → modal opens
5. Test Upload tab: upload image → Apply → verify preview updates
6. Test Stock tab: directions load → pick direction → results show → select → Apply
7. Test AI tab: pick direction → image generates → Apply
8. Verify `lp_image_content` is updated with new URL

- [ ] **Step 6: Commit**

```bash
git add dashboard.html
git commit -m "feat: add Image Picker modal with upload, stock, and AI tabs"
```

---

## Task 11: A/B Variant Image Copying

**Files:**
- Modify: `dashboard.html`

**Context:** When user creates a new A/B variant, images from the default variant should be copied. The variant creation happens in `showAddVariantModal()` (line 2134 in dashboard.html).

- [ ] **Step 1: Add image copying after variant creation**

In the `showAddVariantModal()` function, after the variant is successfully inserted (after line 2166 `projectVariants.push(data);`), add:

```javascript
  // Copy images from default variant to new variant
  const defaultVariant = projectVariants.find(v => v.is_default);
  if (defaultVariant) {
    const { data: existingImages } = await sb
      .from('lp_image_content')
      .select('*')
      .eq('variant_id', defaultVariant.id);

    if (existingImages?.length > 0) {
      const newImageRows = existingImages.map(img => ({
        project_id: img.project_id,
        variant_id: data.id, // new variant
        slot: img.slot,
        image_url: img.image_url,
        source: img.source,
        source_meta: img.source_meta,
      }));
      await sb.from('lp_image_content').insert(newImageRows);
    }
  }
```

- [ ] **Step 2: Test**

1. Create a project with images
2. Add a new A/B variant
3. Verify `lp_image_content` has rows for both the default variant and the new variant with the same image URLs

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "feat: copy images when creating A/B variant"
```

---

## Task 12: Brief Mode Image Support

**Files:**
- Modify: `new.html`

**Context:** Brief mode (line 1172 in new.html) is a separate form, not the step wizard. It needs the image mode toggle and upload zones added as a section.

- [ ] **Step 1: Add image section to brief mode**

After the existing brief mode fields (after the color/tone section), add:

```html
<!-- Image Preferences (Brief Mode) -->
<div class="field" style="margin-top:24px; border-top:1px solid var(--border); padding-top:24px;">
  <label class="field-label">תמונות בדף הנחיתה</label>
  <div style="display:flex;gap:10px;margin-bottom:16px;">
    <button type="button" class="color-mode-btn active" onclick="setBriefImageMode('with_images', this)" id="brief-btn-with-images">
      כן, עם תמונות
    </button>
    <button type="button" class="color-mode-btn" onclick="setBriefImageMode('css_only', this)" id="brief-btn-css-only">
      לא, עיצוב בלבד
    </button>
  </div>
  <div id="brief-image-options">
    <!-- Same upload zone as questionnaire mode hero, with brief- prefix -->
    <div class="upload-zone" id="briefHeroUploadZone" onclick="document.getElementById('briefHeroFileInput').click()">
      <input type="file" id="briefHeroFileInput" accept="image/*" style="display:none" onchange="handleBriefHeroUpload(event)">
      <div class="upload-placeholder" id="briefHeroUploadPrompt">
        <span class="upload-icon">&#x1F4F7;</span>
        <div class="upload-text">העלו תמונת Hero (אופציונלי)</div>
      </div>
      <img class="upload-preview" id="briefHeroUploadPreview" alt="Preview">
    </div>
    <div id="briefHeroModeChoice" style="display:none;margin-top:12px;text-align:center;">
      <div style="display:flex;gap:8px;justify-content:center;">
        <button type="button" class="color-mode-btn active" onclick="setBriefHeroImageMode('direct')">השתמשו בתמונה הזו</button>
        <button type="button" class="color-mode-btn" onclick="setBriefHeroImageMode('inspiration')">השתמשו כהשראה</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add brief mode JS handlers**

```javascript
let briefImageMode = 'with_images';
let briefHeroImageUrl = null;
let briefHeroImageUrlMode = 'direct';

function setBriefImageMode(mode, btn) {
  briefImageMode = mode;
  document.querySelectorAll('#brief-btn-with-images, #brief-btn-css-only').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('brief-image-options').style.display = mode === 'with_images' ? 'block' : 'none';
}

// handleBriefHeroUpload — same pattern as handleHeroUpload but with brief- prefixed element IDs
```

- [ ] **Step 3: Update `submitBrief()` to include image data**

In the `submitBrief()` function, add `image_mode` to the project insert and image data to questionnaire_data.

- [ ] **Step 4: Commit**

```bash
git add new.html
git commit -m "feat: add image preferences to brief mode"
```

---

## Task 13: Integration Testing & Polish

**Files:**
- All modified files

- [ ] **Step 1: End-to-end test — CSS-only mode (regression)**

1. Create new project via `/new.html` with "No images (CSS only)"
2. Generate LP → verify it works exactly as before (pure CSS, no `data-image-slot` in HTML)
3. Serve via `/lp/<slug>` → verify rendering

- [ ] **Step 2: End-to-end test — With images, auto-pick**

1. Create new project with "With images" mode, skip all uploads
2. Generate LP → verify:
   - "Finding images..." progress shows
   - "Generating page..." progress shows
   - LP preview has a real image in hero section
   - `data-image-slot="hero"` exists in HTML
   - `lp_image_content` has a row for hero
3. Visit `/lp/<slug>` → verify image renders correctly

- [ ] **Step 3: End-to-end test — With images, user upload (direct)**

1. Create project with "With images", upload a hero image, choose "Use this image"
2. Generate → verify the exact uploaded image appears in the LP

- [ ] **Step 4: End-to-end test — With images, user upload (inspiration)**

1. Create project with "With images", upload an image, choose "Use as inspiration"
2. Generate → verify a different (Pexels/Imagen) image appears, styled similar to the upload

- [ ] **Step 5: End-to-end test — Image swap**

1. From test 2's LP, click hero image → open picker
2. Go to Stock tab → select direction → pick different image → Apply
3. Verify preview updates without regeneration
4. Visit public `/lp/<slug>` → verify new image appears

- [ ] **Step 6: End-to-end test — A/B variant images**

1. Create a new variant for the test project
2. Verify images are copied from default variant
3. Swap hero image on variant B only
4. Verify variant A still has original, variant B has new image

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes for image system"
```

---

## Implementation Order & Dependencies

```
Task 1 (DB Migration + storage check) ← no dependencies, do first
    ↓
Task 2 (resolve-images) ← needs DB + env vars
Task 3 (image-directions) ← needs DB
Task 4 (search-images) ← needs env vars
Task 5 (apply-image) ← needs DB
    ↓ (Tasks 2-5 can be done in parallel)
Task 6 (generate-lp modifications) ← needs resolve-images to exist
Task 7 (serve-lp modifications) ← needs DB table
    ↓
Task 8 (new.html questionnaire form) ← needs DB column
Task 9 (dashboard generation flow) ← needs resolve-images + generate-lp changes
Task 10 (dashboard image picker) ← needs all API endpoints
Task 11 (A/B variant image copying) ← needs DB table + image picker
Task 12 (brief mode image support) ← needs Task 8 patterns
    ↓
Task 13 (integration testing) ← needs everything
```
