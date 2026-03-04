// Vercel Serverless Function — rewrites questionnaire answers via Claude API
import Anthropic from "@anthropic-ai/sdk";

const FIELD_PROMPTS = {
  what_you_do:
    "Rewrite this business description to be clear, specific, and compelling. Focus on the concrete service/product and the transformation it provides. Keep it to 1-2 punchy sentences.",
  target_audience:
    "Rewrite this target audience description to be specific and detailed. Include demographics, pain points, and aspirations. Make it actionable for marketing.",
  main_benefit:
    "Rewrite this as a powerful, headline-worthy value proposition. Use emotional triggers, be specific about the outcome, and make it impossible to ignore. One compelling sentence.",
  story:
    "Rewrite this brand story with narrative structure: the problem, the journey, the mission. Add emotional depth, authenticity, and a clear 'why'. Keep it 2-3 short paragraphs.",
  feature_title:
    "Rewrite this feature title to be benefit-driven and concise (3-6 words). Focus on the outcome, not the feature itself.",
  feature_description:
    "Rewrite this feature description to lead with the benefit, be specific, and create desire. One compelling sentence.",
  social_proof:
    "Rewrite this social proof to be specific, credible, and impressive. Include numbers, names, or concrete results where possible.",
  badges:
    "Rewrite this credentials/badges description to sound authoritative and trustworthy.",
  price_description:
    "Rewrite this price description to emphasize value, minimize price sensitivity, and create urgency.",
  cta_text:
    "Rewrite this CTA button text to be action-oriented, specific, and create urgency. 2-5 words max.",
  thankyou_text:
    "Rewrite this thank-you message to reinforce the decision, set expectations, and build excitement.",
  brief_text:
    "Rewrite this brief to be comprehensive and structured for an AI landing page generator. Organize the information clearly: what the business does, who it serves, key benefits, unique selling points, and desired tone. Make it specific and detailed.",
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { field, answer, context } = req.body || {};

  if (!field || !answer) {
    return res
      .status(400)
      .json({ error: "Missing required parameters: field, answer" });
  }

  const fieldPrompt = FIELD_PROMPTS[field];
  if (!fieldPrompt) {
    return res
      .status(400)
      .json({ error: `Unknown field: ${field}. Supported fields: ${Object.keys(FIELD_PROMPTS).join(", ")}` });
  }

  const projectName = (context && context.name) || "";
  const language = (context && context.language) || "en";
  const langLabel = language === "he" ? "Hebrew" : "English";

  try {
    const client = new Anthropic();

    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      system: `You are an expert marketing copywriter specializing in landing pages and conversion optimization. Your job is to take a user's rough answer and rewrite it to be more effective for landing page generation.\n\nRules:\n- Respond ONLY with the rewritten text. No explanations, no quotes, no labels.\n- Keep the same core meaning and facts — just make it better.\n- Respond in the SAME LANGUAGE as the user's input. If the input is in ${langLabel}, respond in ${langLabel}.`,
      messages: [
        {
          role: "user",
          content: `Field: ${field}\nInstruction: ${fieldPrompt}\n${projectName ? `Project name: ${projectName}\n` : ""}Language: ${langLabel}\n\nOriginal answer:\n${answer}`,
        },
      ],
    });

    const remixed =
      message.content &&
      message.content[0] &&
      message.content[0].type === "text"
        ? message.content[0].text.trim()
        : "";

    if (!remixed) {
      return res.status(500).json({ error: "Claude returned an empty response" });
    }

    return res.status(200).json({ remixed });
  } catch (err) {
    console.error("remix-answer error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error: " + String(err.message || err) });
  }
}
