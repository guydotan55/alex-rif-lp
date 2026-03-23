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
