// Vercel Serverless Function — sends welcome email via Resend
// Called by index.html after a lead is successfully captured

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

export default async function handler(req, res) {
  // CORS headers (needed for browser fetch)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }

  try {
    // Fetch email template from Supabase settings table
    const settingsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?key=in.(welcome_email_subject,welcome_email_body,resend_api_key)&select=key,value`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    const settingsRows = await settingsRes.json();
    const settings = {};
    for (const row of settingsRows) {
      settings[row.key] = row.value;
    }

    const subject = settings["welcome_email_subject"] || "קיבלנו את פרטיך!";
    const bodyText = settings["welcome_email_body"] || "תודה שהתעניינת!";

    // Use DB key if set, otherwise env var
    const resendKey =
      settings["resend_api_key"] &&
      settings["resend_api_key"] !== "RESEND_API_KEY_PLACEHOLDER"
        ? settings["resend_api_key"]
        : RESEND_API_KEY;

    if (!resendKey) {
      return res.status(500).json({ error: "Resend API key not configured" });
    }

    // Convert plain text to simple RTL HTML
    const bodyHtml = `
      <div dir="rtl" style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
        <div style="background: #f5f0d8; border-radius: 16px; padding: 20px 24px; margin-bottom: 24px; text-align: center;">
          <p style="font-size: 22px; font-weight: 900; margin: 0;">צ'יבורשקה בישראל 🐻</p>
        </div>
        ${bodyText
          .split("\n")
          .map((line) => `<p style="margin: 0 0 10px;">${line || "&nbsp;"}</p>`)
          .join("")}
        <hr style="border: none; border-top: 1px solid #eee; margin: 28px 0;" />
        <p style="font-size: 12px; color: #aaa; text-align: center;">רוסית לילדים בישראל</p>
      </div>
    `;

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "צ'יבורשקה בישראל <onboarding@resend.dev>",
        to: [email],
        subject,
        html: bodyHtml,
        text: bodyText,
      }),
    });

    const emailData = await emailRes.json();

    if (!emailRes.ok) {
      console.error("Resend error:", emailData);
      return res.status(500).json({ error: emailData });
    }

    return res.status(200).json({ success: true, id: emailData.id });
  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: String(err) });
  }
}
