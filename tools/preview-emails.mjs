// One-off mockup generator: writes 8 sample emails + an index.html to /tmp.
// Uses the real email renderers from api/lib/email-templates.js.
// Real customer-test data from "ליפז אלה - בדיקת מסרים והתכנות" (2026-05-05).
//
// Run: node tools/preview-emails.mjs

import {
  renderKickoffEmail,
  renderMilestoneEmail,
  renderSummaryEmail,
  renderStallAlertEmail,
} from '../api/lib/email-templates.js';
import fs from 'node:fs';
import path from 'node:path';

process.env.APP_URL = 'https://messaginglab-guydotan55s-projects.vercel.app';

const OUT_DIR = '/tmp/email-mockups';
fs.mkdirSync(OUT_DIR, { recursive: true });

const test = {
  name: 'ליפז אלה - בדיקת מסרים והתכנות',
  slug: 'lypz-alh-bdykt-msrym-vhtknvt-tqxb',
  target_sample_size: 500,
  baseline_cvr: 0.06,
  mde: 1.00,
  expected_cpc: 3.00,
};

// Real current state: A leads at 8.13%, C in middle at 6.20%, B trailing at 3.42%
const NAME_A = 'התפתחות אישית רוחנית דרך המסורת היהודית';
const NAME_B = 'מסע אישי';
const NAME_C = 'התפתחות אישית רוחנית - גרסה שנייה';

const URL_A = `${process.env.APP_URL}/lp/lipaz-ela-1`;
const URL_B = `${process.env.APP_URL}/lp/lipaz-ela-2`;
const URL_C = `${process.env.APP_URL}/lp/lipaz-ela-3`;

const at25 = [
  { label: 'A', name: NAME_A, visitors: 142, conversions: 11, lpUrl: URL_A },  // ~7.7%
  { label: 'B', name: NAME_B, visitors: 117, conversions: 4,  lpUrl: URL_B },  // ~3.4%
  { label: 'C', name: NAME_C, visitors: 137, conversions: 8,  lpUrl: URL_C },  // ~5.8%
];
const current = [
  { label: 'A', name: NAME_A, visitors: 283, conversions: 23, lpUrl: URL_A },  // 8.13%
  { label: 'B', name: NAME_B, visitors: 234, conversions: 8,  lpUrl: URL_B },  // 3.42%
  { label: 'C', name: NAME_C, visitors: 274, conversions: 17, lpUrl: URL_C },  // 6.20%
];
const at75 = current.map(v => ({ ...v, visitors: Math.round(v.visitors * 1.4), conversions: Math.round(v.conversions * 1.4) }));
const at100 = current.map(v => ({ ...v, visitors: Math.round(v.visitors * 1.9), conversions: Math.round(v.conversions * 1.9) }));
const tieData = at100.map(v => ({ ...v, conversions: 32 })); // all variants ~same

const numVariants = 3;
const daysEstimate = 14;

const emails = [
  {
    id: 1,
    title: 'KICKOFF — fires when you click "הפעל" in the dashboard',
    note: 'Sent synchronously the moment you activate the test. Confirms the plan and what to expect.',
    out: renderKickoffEmail(test, numVariants, daysEstimate),
  },
  {
    id: 2,
    title: 'MILESTONE 25% — first checkpoint',
    note: '"Quarter of the way" — too early to call a winner. Shows current standings.',
    out: renderMilestoneEmail(test, 25, at25),
  },
  {
    id: 3,
    title: 'MILESTONE 50% — current state of your live test',
    note: '"Halfway" — the gap is starting to settle. Still not statistically significant yet.',
    out: renderMilestoneEmail(test, 50, current),
  },
  {
    id: 4,
    title: 'MILESTONE 75% — projected (if test continues)',
    note: '"Three quarters" — start preparing the winning variant for ship.',
    out: renderMilestoneEmail(test, 75, at75),
  },
  {
    id: 5,
    title: 'SUMMARY — Winner found 🏆 (most likely outcome for your test)',
    note: 'Auto-fires when P(best variant) > 0.80 + ≥20 conversions + ≥100 visitors. Recommends shipping the winner.',
    out: renderSummaryEmail(
      test,
      { verdict: 'WINNER_FOUND', winnerLabel: 'A', winnerName: NAME_A, liftPct: 31 },
      at100
    ),
  },
  {
    id: 6,
    title: 'SUMMARY — Practical tie ⚪ (if all 3 had performed similarly)',
    note: 'Fires when test reaches 100% sample but no variant clearly wins. Recommends a bigger change next time.',
    out: renderSummaryEmail(
      test,
      { verdict: 'PRACTICAL_TIE' },
      tieData
    ),
  },
  {
    id: 7,
    title: 'SUMMARY — Trending but not significant 🟡 (borderline)',
    note: 'Fires at 100% sample when leader has 0.65-0.80 confidence. Offers 3 paths: extend, decide anyway, restart.',
    out: renderSummaryEmail(
      test,
      { verdict: 'TRENDING_UNDERPOWERED', winnerLabel: 'A', winnerName: NAME_A, liftPct: 18 },
      at100
    ),
  },
  {
    id: 8,
    title: 'STALL — fires if 0 visitors for 48 hours',
    note: 'Diagnostic checklist for paid-Meta stall: campaign / pixel / URL.',
    out: renderStallAlertEmail(test),
  },
];

// Write each email to its own HTML file (kept for direct viewing too)
for (const e of emails) {
  fs.writeFileSync(path.join(OUT_DIR, `email-${e.id}.html`), e.out.html);
}

// HTML attribute encoder for srcdoc — only need to escape & and "
const escAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Write the index.html that loads them inline via srcdoc (bypasses file:// cross-origin)
const indexHtml = `<!doctype html>
<html dir="rtl" lang="he">
<head>
  <meta charset="utf-8">
  <title>תצוגה מקדימה של מיילים — Messaging Lab</title>
  <style>
    body { background:#e9eaee; margin:0; padding:32px 16px; font-family:-apple-system,BlinkMacSystemFont,'Heebo','Assistant',sans-serif; }
    h1 { text-align:center; color:#0d2240; margin:0 0 6px; font-weight:300; font-size:28px; }
    .lede { text-align:center; color:#666; margin:0 0 24px; font-size:14px; max-width:680px; margin-inline:auto; }
    .lede strong { color:#0d2240; }
    .preview { background:#fff; margin:0 auto 36px; max-width:680px; border-radius:14px; overflow:hidden; box-shadow:0 6px 28px rgba(13,34,64,.12); }
    .preview-header { background:#0d2240; color:#fff; padding:16px 22px; }
    .preview-title { font-size:14px; font-weight:700; color:#fff; line-height:1.3; }
    .preview-note { font-size:12px; color:#a8b3c4; margin-top:6px; line-height:1.5; }
    .subject { color:#f5c842; font-size:11px; margin-top:8px; direction:ltr; text-align:left; font-family:-apple-system,SFMono-Regular,Menlo,monospace; word-break:break-all; padding:6px 8px; background:rgba(0,0,0,0.25); border-radius:4px; }
    .subject-label { color:#f5c842; font-weight:700; opacity:0.7; }
    iframe { width:100%; border:none; min-height:680px; display:block; background:#f4f4f5; }
    @media (max-width:720px) {
      iframe { min-height:780px; }
    }
  </style>
</head>
<body>
  <h1>תצוגה מקדימה של מיילים אוטומטיים</h1>
  <div class="lede">
    מבוסס על הנתונים האמיתיים של <strong>"ליפז אלה - בדיקת מסרים והתכנות"</strong>.<br>
    A מובילה ב-8.13% · C ב-6.20% · B ב-3.42%. מצב נוכחי: ~50% מהדגימה.
  </div>
  ${emails.map(e => `
    <div class="preview">
      <div class="preview-header">
        <div class="preview-title">${e.id}. ${e.title}</div>
        <div class="preview-note">${e.note}</div>
        <div class="subject"><span class="subject-label">SUBJECT:</span> ${e.out.subject.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>
      </div>
      <iframe srcdoc="${escAttr(e.out.html)}" loading="lazy"></iframe>
    </div>
  `).join('')}
</body>
</html>`;

fs.writeFileSync(path.join(OUT_DIR, 'index.html'), indexHtml);
console.log(`Wrote ${emails.length} emails + index.html to ${OUT_DIR}`);
console.log(`Open: file://${OUT_DIR}/index.html`);
