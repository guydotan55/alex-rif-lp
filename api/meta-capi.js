// Vercel Serverless Function — Meta Conversions API (server-side event dedup)
import crypto from "crypto";

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_CAPI_TOKEN = process.env.META_CAPI_TOKEN;
const APP_ORIGIN = process.env.APP_URL || "https://messaginglab-guydotan55s-projects.vercel.app";

function sha256(value) {
  return crypto.createHash("sha256").update(value.toLowerCase().trim()).digest("hex");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!META_PIXEL_ID || !META_CAPI_TOKEN) {
    return res.status(200).json({ skipped: true, reason: "Meta CAPI not configured" });
  }

  const { event_name, event_id, email, source_url, fbc, fbp } = req.body || {};

  if (!event_name || !event_id) {
    return res.status(400).json({ error: "Missing event_name or event_id" });
  }

  // Build user_data with hashed PII
  const userData = {};
  if (email) userData.em = [sha256(email)];
  if (fbc) userData.fbc = fbc;
  if (fbp) userData.fbp = fbp;

  // Extract IP and user agent from request headers
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.headers["x-real-ip"]
    || req.socket?.remoteAddress;
  const clientUa = req.headers["user-agent"];

  if (clientIp) userData.client_ip_address = clientIp;
  if (clientUa) userData.client_user_agent = clientUa;

  const eventData = {
    event_name,
    event_time: Math.floor(Date.now() / 1000),
    event_id,
    action_source: "website",
    user_data: userData,
  };
  if (source_url) eventData.event_source_url = source_url;

  try {
    const capiRes = await fetch(
      `https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [eventData],
          access_token: META_CAPI_TOKEN,
        }),
      }
    );

    const capiData = await capiRes.json();

    if (!capiRes.ok) {
      console.error("Meta CAPI error:", capiData);
      return res.status(200).json({ sent: false, error: capiData });
    }

    return res.status(200).json({ sent: true, events_received: capiData.events_received });
  } catch (err) {
    console.error("Meta CAPI fetch error:", err);
    return res.status(200).json({ sent: false, error: String(err.message) });
  }
}
