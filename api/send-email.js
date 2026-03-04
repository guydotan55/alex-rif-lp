// Vercel Serverless Function — sends welcome email via Brevo
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BREVO_API_KEY = process.env.BREVO_API_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, project_id } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }

  // --- Project-based email template path ---
  if (project_id) {
    try {
      // Fetch the project row from Supabase
      const projRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?id=eq.${project_id}&select=*&limit=1`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );

      const projRows = await projRes.json();
      const project = projRows && projRows[0];

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      // If email is disabled for this project, skip sending
      if (!project.email_enabled) {
        return res.status(200).json({ success: true, skipped: true });
      }

      const subject = project.email_subject || `Welcome to ${project.name || 'our page'}!`;
      const bodyText = project.email_body || "Thank you for signing up!";

      const bodyHtml = `
        <div style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
          ${bodyText.split("\n").map(line => `<p style="margin: 0 0 10px;">${line || "&nbsp;"}</p>`).join("")}
        </div>
      `;

      const senderName = project.name || "LP Builder";

      // Send via Brevo
      const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": BREVO_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender: { name: senderName, email: "libby.negev.ai@gmail.com" },
          to: [{ email }],
          subject,
          htmlContent: bodyHtml,
          textContent: bodyText,
        }),
      });

      const brevoData = await brevoRes.json();

      if (!brevoRes.ok) {
        console.error("Brevo error:", brevoData);
        return res.status(500).json({ error: brevoData });
      }

      return res.status(200).json({ success: true, messageId: brevoData.messageId });

    } catch (err) {
      console.error("Unexpected error (project email):", err);
      return res.status(500).json({ error: String(err) });
    }
  }

  try {
    // Pick settings keys based on source
    const source = (req.body && req.body.source) || 'cheburashka';
    const subjectKey = source === 'alex-rif' ? 'alex_rif_email_subject' : 'welcome_email_subject';
    const bodyKey = source === 'alex-rif' ? 'alex_rif_email_body' : 'welcome_email_body';

    // Fetch email template from Supabase settings
    const settingsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?key=in.(${subjectKey},${bodyKey})&select=key,value`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    const settingsRows = await settingsRes.json();
    const settings = {};
    for (const row of settingsRows) settings[row.key] = row.value;

    const subject = settings[subjectKey] || "קיבלנו את פרטיך!";
    const bodyText = settings[bodyKey] || "תודה שהתעניינת!";

    const bodyHtml = `
      <div dir="rtl" style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.7; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
        <div style="background: #0d2240; border-radius: 16px; padding: 20px 24px; margin-bottom: 24px; text-align: center;">
          <p style="font-size: 22px; font-weight: 900; margin: 0; color: #f5c842;">צ׳יבורשקה בישראל 🐻</p>
        </div>
        ${bodyText.split("\n").map(line => `<p style="margin: 0 0 10px;">${line || "&nbsp;"}</p>`).join("")}
        <hr style="border: none; border-top: 1px solid #eee; margin: 28px 0;" />
        <p style="font-size: 12px; color: #aaa; text-align: center;">רוסית לילדים בישראל</p>
      </div>
    `;

    // Send via Brevo
    const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: "צ׳יבורשקה בישראל", email: "libby.negev.ai@gmail.com" },
        to: [{ email }],
        subject,
        htmlContent: bodyHtml,
        textContent: bodyText,
      }),
    });

    const brevoData = await brevoRes.json();

    if (!brevoRes.ok) {
      console.error("Brevo error:", brevoData);
      return res.status(500).json({ error: brevoData });
    }

    return res.status(200).json({ success: true, messageId: brevoData.messageId });

  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: String(err) });
  }
}
