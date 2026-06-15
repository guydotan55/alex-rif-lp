---
paths:
  - "api/generate-lp.js"
  - "api/remix-answer.js"
  - "api/serve-lp.js"
  - "api/serve-test.js"
  - "api/lib/lp-renderer.js"
  - "api/save-content.js"
  - "api/apply-image.js"
  - "api/resolve-images.js"
  - "api/search-images.js"
---

# LP Design — Quality Bar for Generated Landing Pages

These rules apply whenever Claude touches generation prompts, templates,
post-processing, or LP rendering.

## What this tool is FOR

NGOs use this to **test both messaging AND value propositions** —
*HOW* an offer is communicated and *WHAT* the offer actually is. The unit
of value is *"1 project = N variants, each from a different brief +
different image, running in parallel on FB / Google Display ads."*

A variant might change just the headline (messaging test), just the
core offer (value-prop test), or both. The tool must support all three.

We're optimizing for **valid, trustworthy, fast-iterating LP variants** —
not one-off art pieces.

---

## Quality benchmark — TASTE, not look

The Lipaz Ela LP (live customer, April 2026) is a **TASTE benchmark**,
not a visual template. It sets the bar for: no AI cliches, real human
voice, restraint, intentional choices.

It is NOT a style template. Each LP must match its OWN brief's brand —
not Lipaz Ela's aesthetic.

Reference: https://messaginglab-guydotan55s-projects.vercel.app/lp/lipaz-ela-1

---

## Voice principle

**Voice should sound like a thoughtful editor wrote it for ONE specific
person — not a marketing department wrote it for "everyone."**

Concrete cliches to avoid:
- "act now!", "limited time!", "transform your life today!"
- "in today's fast-paced world..." openers
- emoji-heavy bullet lists
- 5-section funnel-formula structures

---

## Visual principle

- **Default to restraint:** generous whitespace, modern sans or serif
  typography, simple symbolic icons, max 2 fonts.
- **Deviate only when the brief explicitly demands** brighter/bolder
  (e.g., kids' education, youth movements).
- **The customer uploads ONE hero image per variant.** That image:
  - becomes the hero section
  - drives the palette (sample 3–5 dominant colors → derive harmonious
    accent / text / background)
  - sets the visual mood for the rest of the page
- Avoid: neon gradients, busy hero sections, >2 fonts, generic stock photos.

---

## Traffic + device assumptions

- **Traffic sources:** Facebook ads (mainly) + Google Display ads.
- **~90% of traffic is mobile.** Test mobile first, desktop second.
- Visitors have ~3 seconds of patience. Above-the-fold is everything.

---

## Minimum for a valid test — three tiers, all required

A variant that misses any tier isn't a "lower quality" LP — it's an
**invalid test.** The customer can't learn from it.

**Tier 1 — Must have for ANY LP:**
- Value prop above the fold
- ONE clear CTA button above the fold
- Email capture (inline form or CTA leading to one)

**Tier 2 — Must have for trust:**
- At least one trust signal (testimonial, logo strip, or "X people already...")

**Tier 3 — Must have for measurement:**
- UTM parameters parsed from URL and stored with conversion
- Analytics events fired on: page view, CTA click, email submit

---

## Variant model

- 1 project = N variants, generated upfront.
- Each variant has its OWN brief + OWN image (NOT "same content, different design").
- Variants test different hypotheses — could be messaging
  (origin story vs stat vs pain point), value prop (offer A vs offer B),
  or both at once.
- All variants must independently satisfy Tier 1 + 2 + 3.

---

## Self-check before shipping

Ask three questions, in order:
1. *Does this meet the Lipaz Ela TASTE bar?* (no cliches, real voice, restraint)
2. *Does it match the brief's OWN brand* (not Lipaz Ela's aesthetic)?
3. *Does it satisfy Tier 1 + 2 + 3?*

If any "no" → not ready.

---

## `api/` reference

```
generate-lp.js     — Main: brief → Claude API → LP HTML → save to Supabase
remix-answer.js    — Iterate / refine generated copy
search-images.js   — Image search
resolve-images.js  — Image URL resolution
apply-image.js     — Apply image to a section
save-content.js    — Persist LP content
serve-lp.js        — PUBLIC LP serving (handle with care)
serve-test.js      — Test/preview LP serving
lib/auth-helper.js — Supabase user verification
lib/lp-renderer.js — Shared LP HTML rendering
```
