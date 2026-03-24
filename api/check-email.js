// POST /api/check-email
// Body: { email }
// Returns: { allowed: true/false }
// No auth required (pre-login check)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "email is required" });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const rows = await r.json();
    return res.status(200).json({ allowed: rows?.length > 0 });
  } catch (err) {
    console.error("check-email error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
