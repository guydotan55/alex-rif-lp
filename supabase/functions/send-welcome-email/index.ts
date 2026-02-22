import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

Deno.serve(async (req: Request) => {
  try {
    // Only accept POST from Supabase webhook
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const payload = await req.json();

    // Supabase database webhook sends: { type, table, record, old_record }
    const record = payload.record;
    if (!record?.email) {
      return new Response("No email in record", { status: 400 });
    }

    const toEmail = record.email;

    // Fetch email template from settings table
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: settings, error: settingsError } = await supabase
      .from("settings")
      .select("key, value")
      .in("key", ["welcome_email_subject", "welcome_email_body", "resend_api_key"]);

    if (settingsError) {
      console.error("Failed to fetch settings:", settingsError);
      return new Response("Failed to fetch settings", { status: 500 });
    }

    const settingsMap: Record<string, string> = {};
    for (const row of settings ?? []) {
      settingsMap[row.key] = row.value;
    }

    const subject = settingsMap["welcome_email_subject"] || "קיבלנו את פרטיך!";
    const bodyText = settingsMap["welcome_email_body"] || "תודה שהתעניינת!";
    // Use Resend API key from settings if available, otherwise from env
    const resendKey = settingsMap["resend_api_key"] !== "RESEND_API_KEY_PLACEHOLDER"
      ? settingsMap["resend_api_key"]
      : RESEND_API_KEY;

    // Convert plain text body to simple HTML (preserve newlines)
    const bodyHtml = `
      <div dir="rtl" style="font-family: Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #1a1a1a; max-width: 500px; margin: 0 auto; padding: 24px;">
        ${bodyText.split("\n").map((line: string) => `<p style="margin: 0 0 8px;">${line || "&nbsp;"}</p>`).join("")}
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="font-size: 12px; color: #999;">צ'יבורשקה בישראל 🐻</p>
      </div>
    `;

    // Send via Resend
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "צ'יבורשקה בישראל <onboarding@resend.dev>",
        to: [toEmail],
        subject: subject,
        html: bodyHtml,
        text: bodyText,
      }),
    });

    const resendData = await resendRes.json();

    if (!resendRes.ok) {
      console.error("Resend error:", resendData);
      return new Response(JSON.stringify({ error: resendData }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`Email sent to ${toEmail}, id: ${resendData.id}`);
    return new Response(JSON.stringify({ success: true, id: resendData.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
