# CLAUDE.md — Messaging Lab (LP Generator for NGOs)

> ⚠️ Folder used to be named "LPs Generator (alex_rif_style)" — that name is legacy.
> Current product: **Messaging Lab.**

## What This Is
Multi-tenant landing page generator for NGOs. Customers fill a brief
(what they do, audience, value prop, story, features) + upload a hero
image, and the tool generates LP HTML via Claude API. LPs are served
at public URLs (`/lp/:slug` and `/lp/:slug/:variant`) used in real
Facebook + Google Display ad campaigns.

The unit of value is **testing messaging AND value propositions**:
1 project = N variants, each generated from a different brief + image,
run in parallel to see which approach converts best. Variants test
*either* HOW the offer is communicated (messaging) *or* WHAT is being
offered (value proposition) — often both at once.

## Status
**Pilot — 1 NGO customer live with real ad spend running.**
Real traffic on `/lp/*`. **Don't break public LP routes.**

## Suite Context
Sold alongside `whatsapp-survey` (sister project at
`/Users/a/Claude-Projects/בבואה/whatsapp survey/`) as a
**business suite for NGOs**. Independent products — separate auth,
separate Supabase, separate data. Suite integration is packaging only.

---

## The Two Audiences

### 1. Tool user — NGO admin / marketer
Profile: community managers in their 30s–50s, **NOT tech-savvy**, NOT
early adopters. Non-profits, religious orgs, municipalities. **If the
tool needs explaining, it's broken.** They must complete the entire
flow alone.

→ Full UX rules + self-serve flow checklist live in
`.claude/rules/admin-ux.md` (auto-loads when working on admin UI).

### 2. LP viewer — the NGO's ad audience
Lands here from FB / Google Display ads. ~90% mobile. ~3 seconds of
patience. The page must feel hand-crafted, intentional, trustworthy —
not AI-generic.

→ Full quality bar, voice, visual rules, variant model, and
"valid test" tiers live in `.claude/rules/lp-design.md`
(auto-loads when working on LP generation files).

---

## How Claude Should Work On This Codebase

### Don't break public LP routes
`/lp/:slug` and `/lp/:slug/:variant` are LIVE. A 500 here costs real
customer ad budget. Before touching `api/serve-lp.js`,
`api/serve-test.js`, or `vercel.json` rewrites — deploy a preview,
hit the live URL, confirm it loads.

### Pick simple over clever
50 boring lines beat 20 clever ones. Codebase is vanilla HTML + small
Vercel functions on purpose. Don't refactor it into a framework unless
I explicitly ask.

### Fail loud, never silent
Every error must log and surface to the admin. **No `catch {}`** without
re-throwing or logging. Silent failure here = the customer clicks
"generate" and stares at nothing.

### Do exactly what was asked
Don't add features, redesign dashboards, or "improve" generation prompts
unprompted. Suggest in chat; don't build.

### Testing policy
Tests for your own changes only — no suite to backfill. Co-locate tests
next to code (`api/foo.test.js`).

### Verification after edits
- API changes → deploy preview to Vercel, hit the endpoint manually
- LP rendering changes → visit `/lp/lipaz-ela-1`, visually confirm no regression
- Frontend HTML → open in browser, check console for errors

---

## Tech Stack

- **Frontend:** Vanilla HTML + JS (no framework). Files: `index.html`,
  `dashboard.html`, `admin.html`, `new.html`, `settings.html`, `404.html`.
- **Backend:** Vercel serverless functions in `api/*.js`
- **AI:** `@anthropic-ai/sdk` — Claude generates LP HTML
- **Database + Auth:** Supabase (anon key in HTML is intentional — RLS enforces access)
- **Email:** Brevo (NOT Resend — confirm before changing)
- **Deployment:** Vercel
- **Provisional domain:** `messaginglab-guydotan55s-projects.vercel.app`

---

## Secrets & Config

Required env vars on Vercel:
- `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `BREVO_API_KEY`, `ADMIN_EMAIL`, `APP_URL`

Supabase **anon** key in `index.html` is **deliberate and safe** —
RLS enforces access. Don't try to "fix" by removing it.
