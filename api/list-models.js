// Temporary diagnostic endpoint — lists available Google AI models
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!GOOGLE_AI_API_KEY) return res.status(500).json({ error: "GOOGLE_AI_API_KEY not set" });

  const listRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${GOOGLE_AI_API_KEY}&pageSize=200`
  );
  if (!listRes.ok) {
    const err = await listRes.text();
    return res.status(listRes.status).json({ error: err });
  }
  const data = await listRes.json();
  const models = (data.models || []).map(m => ({
    name: m.name,
    methods: m.supportedGenerationMethods,
  }));

  // Filter to image-relevant models
  const imageModels = models.filter(m =>
    m.name?.includes("imagen") ||
    m.methods?.includes("generateImages") ||
    (m.name?.includes("gemini") && m.name?.includes("flash"))
  );

  return res.status(200).json({
    total: models.length,
    imageModels,
    allModels: models.map(m => m.name),
  });
}
