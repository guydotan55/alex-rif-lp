// api/lib/email-templates.js
// Pure email renderers — return {subject, html, text}. No I/O, no Brevo here.

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">`;

const SHELL_OPEN = `<!doctype html><html dir="rtl" lang="he"><head>${HEAD}</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Heebo','Assistant','Arial Hebrew',Arial,sans-serif;">
<table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
<tr><td align="center">
  <table dir="rtl" role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:14px;overflow:hidden;">
    <tr><td dir="rtl" style="background:#0d2240;padding:18px 22px;text-align:center;">
      <span style="color:#f5c842;font-weight:900;font-size:18px;">Messaging Lab</span>
    </td></tr>
    <tr><td dir="rtl" style="padding:24px 22px;color:#1a1a1a;font-size:15px;line-height:1.7;">`;

const SHELL_CLOSE = `    </td></tr>
    <tr><td dir="rtl" style="padding:14px 22px;background:#fafafa;color:#888;font-size:11px;text-align:center;">
      Messaging Lab · מערכת ניהול A/B testing לדפי נחיתה
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

function fmtN(n)   { return Number(n).toLocaleString('he-IL'); }
function fmtIls(n) { return `<span dir="ltr">₪${fmtN(Math.round(n))}</span>`; }

function tile(label, value) {
  return `<td dir="rtl" align="center" style="padding:12px 8px;background:#f8f8fa;border-radius:10px;width:33%;">
    <div style="color:#666;font-size:12px;margin-bottom:6px;">${label}</div>
    <div style="color:#0d2240;font-size:22px;font-weight:700;">${value}</div>
  </td>`;
}

function btn(text, href) {
  return `<table dir="rtl" role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;">
    <tr><td dir="rtl" align="center" style="background:#0d2240;border-radius:10px;">
      <a href="${href}" style="display:inline-block;padding:12px 28px;color:#f5c842;text-decoration:none;font-weight:700;font-size:14px;">${text}</a>
    </td></tr>
  </table>`;
}

export function renderKickoffEmail(test, numVariants, daysEstimate) {
  const totalVisitors = test.target_sample_size * numVariants;
  const budget = totalVisitors * Number(test.expected_cpc);
  const testKey = test.slug || test.id || '';
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard${testKey ? `?test=${encodeURIComponent(testKey)}` : ''}`;

  const subject = `הטסט עלה לאוויר — הנה התוכנית | ${test.name}`;
  const html = SHELL_OPEN + `
    <p style="margin:0 0 14px;font-size:16px;"><strong>${escapeHtml(test.name)}</strong> פעיל. אנחנו מנטרים אותו עבורך.</p>
    <table dir="rtl" role="presentation" width="100%" cellpadding="6" cellspacing="0" style="margin:8px 0 14px;">
      <tr>
        ${tile('יעד דגימה לכל וריאציה', fmtN(test.target_sample_size))}
        ${tile('תקציב משוער', fmtIls(budget))}
        ${tile('זמן צפוי', `~${fmtN(daysEstimate)} ימים`)}
      </tr>
    </table>
    <p style="margin:0 0 14px;font-size:13px;color:#666;">סה"כ מבקרים בטסט: <strong>${fmtN(totalVisitors)}</strong></p>
    <p style="margin:14px 0 6px;font-size:14px;color:#444;">מה תקבל בהמשך:</p>
    <ul style="margin:0 0 14px;padding-right:18px;color:#444;font-size:13px;line-height:1.7;">
      <li>עדכון רבע / חצי / שלושה רבעי הדרך</li>
      <li>סיכום סופי עם המלצה — האם לעצור ולשלוח את הוורסיה המנצחת</li>
      <li>התראה אם התנועה ממטא נעצרה ל-48 שעות</li>
    </ul>
    ${btn('פתח את לוח הבקרה', dashboardUrl)}
  ` + SHELL_CLOSE;

  const text = `${test.name} פעיל.\nיעד דגימה: ${fmtN(test.target_sample_size)} מבקרים לכל וריאציה.\nתקציב משוער: ₪${fmtN(Math.round(budget))}.\nזמן צפוי: ~${daysEstimate} ימים.\n\n${dashboardUrl}`;

  return { subject, html, text };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

const MILESTONE_COPY = {
  25: { subject: 'רבע מהדרך', headline: 'עברנו את רבע מהדרך', tone: 'מוקדם להכריז על מנצח. הנה תמונת המצב.' },
  50: { subject: 'חצי דרך — הפער מתחיל להתייצב', headline: 'חצי דרך', tone: 'הפער מתחיל להתבהר. עוד לא סטטיסטית מובהק.' },
  75: { subject: 'שלושת רבעי הדרך — מתחילים להתכונן להחלטה', headline: 'שלושת רבעי הדרך', tone: 'הכן את הוורסיה המנצחת לעלייה.' },
};

export function renderMilestoneEmail(test, milestone, variantCounts) {
  const copy = MILESTONE_COPY[milestone];
  if (!copy) throw new Error(`Unknown milestone: ${milestone}`);
  const totalVisitors = variantCounts.reduce((s, v) => s + v.visitors, 0);
  const testKey = test.slug || test.id;
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard${testKey ? `?test=${encodeURIComponent(testKey)}` : ''}`;

  // Build standings rows
  const sorted = [...variantCounts].sort((a, b) => (b.conversions / Math.max(1, b.visitors)) - (a.conversions / Math.max(1, a.visitors)));
  const rows = sorted.map(v => {
    const cvr = v.visitors ? (v.conversions / v.visitors * 100).toFixed(1) : '0.0';
    return `<tr>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#1a1a1a;font-size:13px;">${escapeHtml(v.name || v.label)}</td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#666;font-size:13px;text-align:left;"><span dir="ltr">${fmtN(v.visitors)}</span> מבקרים</td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#0d2240;font-size:13px;font-weight:600;text-align:left;"><span dir="ltr">${cvr}%</span></td>
    </tr>`;
  }).join('');

  const subject = `${copy.subject} | ${test.name}`;
  const pct = milestone;
  const totalTarget = test.target_sample_size * variantCounts.length;

  const html = SHELL_OPEN + `
    <p style="margin:0 0 12px;font-size:16px;"><strong>${escapeHtml(copy.headline)}</strong></p>
    <p style="margin:0 0 16px;color:#555;font-size:14px;">${copy.tone}</p>

    <div style="background:#f8f8fa;border-radius:10px;padding:14px;margin:0 0 14px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
        <span style="color:#666;font-size:13px;">${fmtN(totalVisitors)} / ${fmtN(totalTarget)} מבקרים</span>
        <span style="color:#0d2240;font-size:18px;font-weight:700;"><span dir="ltr">${pct}%</span></span>
      </div>
      <table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eee;border-radius:6px;height:8px;">
        <tr><td dir="rtl" style="background:#f5c842;width:${pct}%;border-radius:6px;height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>
      </table>
    </div>

    <table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
      ${rows}
    </table>

    ${btn('צפה בפירוט מלא', dashboardUrl)}
  ` + SHELL_CLOSE;

  const text = `${copy.headline} — ${fmtN(totalVisitors)}/${fmtN(totalTarget)} מבקרים (${pct}%)\n\n${copy.tone}\n\n${dashboardUrl}`;
  return { subject, html, text };
}
