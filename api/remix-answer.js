// Vercel Serverless Function — rewrites questionnaire answers via Claude API
// Returns 2 variations: "keep style" (sharpened original voice) + "pro copy" (marketing copywriter)
import Anthropic from "@anthropic-ai/sdk";

const FIELD_PROMPTS = {
  what_you_do: {
    keepStyle:
      "Sharpen this business description. Keep the original voice and tone. Make it specific — name the concrete service/product and the transformation it delivers. Cut filler words. 1-2 sentences.",
    proCopy:
      "Rewrite as a professional copywriter. Lead with the outcome the customer gets, then explain what the business does. Be specific — avoid 'streamline' or 'optimize'. Use customer language. 1-2 punchy sentences.",
  },
  target_audience: {
    keepStyle:
      "Sharpen this audience description. Keep the original voice. Add specificity: who exactly are they, what problem keeps them up at night, what do they want instead? Make it actionable.",
    proCopy:
      "Rewrite as a marketing strategist. Define the audience with precision: demographics, psychographics, their #1 pain point, and the outcome they're seeking. Use language they'd use themselves.",
  },
  main_benefit: {
    keepStyle:
      "Sharpen this headline/benefit. Keep the original voice and energy. Make it specific — replace vague words with concrete outcomes. One powerful sentence that makes the reader stop scrolling.",
    proCopy:
      "Rewrite as a conversion copywriter crafting a landing page headline. Use one of these formulas: '{Achieve outcome} without {pain point}' or a bold specific claim. No buzzwords. One sentence that communicates the core value instantly.",
  },
  story: {
    keepStyle:
      "Sharpen this story. Keep the original voice and authenticity. Structure it: the problem you saw → the journey/turning point → your mission now. Add emotional depth. Cut anything generic. 2-3 short paragraphs.",
    proCopy:
      "Rewrite as a brand storyteller. Structure: open with a relatable problem the audience feels → the pivotal moment that sparked the solution → the mission and why it matters. Use sensory details, not abstractions. End with a forward-looking statement. 2-3 compelling paragraphs.",
  },
  feature_title: {
    keepStyle:
      "Sharpen this feature title. Keep the original tone. Make it benefit-driven — what does the user GET, not what the feature IS. 3-6 words.",
    proCopy:
      "Rewrite as a conversion copywriter. Lead with the benefit, not the feature name. Be specific about the outcome. 3-6 words max. Example: 'Ship 2x Faster' instead of 'Quick Deployment'.",
  },
  feature_description: {
    keepStyle:
      "Sharpen this feature description. Keep the original tone. Lead with the benefit, add a specific detail or proof point. One clear sentence.",
    proCopy:
      "Rewrite as a copywriter. Structure: benefit first → how it works → specific result. Avoid jargon the audience wouldn't use. One compelling sentence.",
  },
  social_proof: {
    keepStyle:
      "Sharpen this social proof. Keep the original tone. Add specificity — concrete numbers, real results, named outcomes. Make it credible and impressive.",
    proCopy:
      "Rewrite for maximum credibility. Use specific numbers, timeframes, and measurable outcomes. If possible, structure as: '[Metric] in [timeframe]' or '[Number] [specific result]'. Remove vague claims.",
  },
  badges: {
    keepStyle:
      "Sharpen this credentials description. Keep the original tone. Make it authoritative — lead with the most impressive credential.",
    proCopy:
      "Rewrite to maximize trust. Lead with the strongest credential. Use specific numbers and names. Structure for scannability.",
  },
  price_description: {
    keepStyle:
      "Sharpen this pricing description. Keep the original tone. Emphasize value over cost. Frame what they get, not what they pay.",
    proCopy:
      "Rewrite as a pricing page copywriter. Lead with value, not price. Use anchoring — compare to the cost of NOT having this. Add urgency if natural. Frame as investment, not expense.",
  },
  cta_text: {
    keepStyle:
      "Sharpen this CTA button text. Keep the original energy. Make it action-oriented and specific about what they get. 2-5 words.",
    proCopy:
      "Rewrite as a conversion optimizer. Formula: [Action Verb] + [What They Get]. Be specific: 'Start My Free Trial' beats 'Sign Up'. Create momentum. 2-5 words.",
  },
  thankyou_text: {
    keepStyle:
      "Sharpen this thank-you message. Keep the original warmth. Reinforce their decision, set clear expectations for what happens next, build excitement.",
    proCopy:
      "Rewrite as a post-conversion specialist. Structure: celebrate their decision → set expectations (what happens next) → build anticipation for the outcome. Be warm but specific.",
  },
  brief_text: {
    keepStyle:
      "Sharpen this brief. Keep the original voice. Organize clearly: what the business does → who it serves → key benefits → unique differentiators → desired tone. Add specificity wherever possible.",
    proCopy:
      "Rewrite as a creative director writing a brief for a copywriter. Structure with clear sections: Business (what + for whom), Value Proposition (key benefits + proof), Differentiators (what makes them unique), Tone & Style. Be specific and detailed.",
  },
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

  const language = (context && context.language) || "en";
  const langLabel = language === "he" ? "Hebrew" : "English";

  // Build rich context from all available questionnaire fields
  const contextLines = [];
  if (context) {
    if (context.name) contextLines.push(`Business name: ${context.name}`);
    if (context.what_you_do) contextLines.push(`What they do: ${context.what_you_do}`);
    if (context.target_audience) contextLines.push(`Target audience: ${context.target_audience}`);
    if (context.main_benefit) contextLines.push(`Main benefit/headline: ${context.main_benefit}`);
    if (context.story) contextLines.push(`Brand story: ${context.story}`);
    if (context.tone) contextLines.push(`Desired tone: ${context.tone}`);
    if (context.features && context.features.length > 0) {
      contextLines.push(`Features: ${context.features.map(f => f.title ? `${f.title}: ${f.desc || ''}` : '').filter(Boolean).join('; ')}`);
    }
    if (context.social_proof) contextLines.push(`Social proof: ${context.social_proof}`);
    if (context.price) contextLines.push(`Price: ${context.price}`);
    if (context.cta_text) contextLines.push(`CTA: ${context.cta_text}`);
  }
  const contextBlock = contextLines.length > 0
    ? `\n\nFull business context (use this to write more relevant copy):\n${contextLines.join('\n')}`
    : '';

  try {
    const client = new Anthropic();

    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1000,
      system: `You are an expert conversion copywriter who specializes in landing pages. You will receive a questionnaire answer and must provide exactly TWO rewrites separated by the delimiter |||SPLIT|||.

Rules:
- First rewrite: Keep the user's original voice, tone, and style — just sharpen the message, add specificity, cut filler
- Second rewrite: Write as a professional marketing copywriter — polished, benefit-driven, conversion-oriented
- Both rewrites must keep the same core meaning and facts
- Both must be in ${langLabel}
- Output ONLY the two texts separated by |||SPLIT||| — no labels, no explanations, no quotes
- Format: [keep-style version]|||SPLIT|||[pro-copy version]${contextBlock}`,
      messages: [
        {
          role: "user",
          content: `Field: ${field}
Keep-style instruction: ${fieldPrompt.keepStyle}
Pro-copy instruction: ${fieldPrompt.proCopy}
Language: ${langLabel}

Original answer:
${answer}`,
        },
      ],
    });

    const rawText =
      message.content &&
      message.content[0] &&
      message.content[0].type === "text"
        ? message.content[0].text.trim()
        : "";

    if (!rawText) {
      return res.status(500).json({ error: "Claude returned an empty response" });
    }

    // Parse the two variations
    const parts = rawText.split("|||SPLIT|||");
    const keepStyle = (parts[0] || "").trim();
    const proCopy = (parts[1] || keepStyle).trim(); // fallback to keepStyle if split fails

    return res.status(200).json({
      remixed: keepStyle, // backwards compatible
      keepStyle,
      proCopy,
    });
  } catch (err) {
    console.error("remix-answer error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error: " + String(err.message || err) });
  }
}
