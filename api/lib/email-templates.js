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
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard`;

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
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard`;

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

export function renderSummaryEmail(test, decision, variantCounts) {
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard`;
  const newTestUrl   = `${process.env.APP_URL || ''}/dashboard`;

  const sorted = [...variantCounts].sort((a, b) => (b.conversions / Math.max(1, b.visitors)) - (a.conversions / Math.max(1, a.visitors)));
  const standingsRows = sorted.map(v => {
    const cvr = v.visitors ? (v.conversions / v.visitors * 100).toFixed(1) : '0.0';
    return `<tr>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#1a1a1a;font-size:13px;">${escapeHtml(v.name || v.label)}</td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#666;font-size:13px;text-align:left;"><span dir="ltr">${fmtN(v.visitors)}</span></td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#666;font-size:13px;text-align:left;"><span dir="ltr">${v.conversions}</span></td>
      <td dir="rtl" style="padding:8px;border-bottom:1px solid #eee;color:#0d2240;font-size:13px;font-weight:600;text-align:left;"><span dir="ltr">${cvr}%</span></td>
    </tr>`;
  }).join('');

  const standingsTable = `<table dir="rtl" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;">
    <thead><tr>
      <th dir="rtl" style="padding:8px;text-align:right;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">וריאציה</th>
      <th dir="rtl" style="padding:8px;text-align:left;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">מבקרים</th>
      <th dir="rtl" style="padding:8px;text-align:left;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">לידים</th>
      <th dir="rtl" style="padding:8px;text-align:left;color:#666;font-size:12px;font-weight:500;border-bottom:2px solid #ddd;">המרה</th>
    </tr></thead>
    <tbody>${standingsRows}</tbody>
  </table>`;

  let subject, headline, body, cta;

  if (decision.verdict === 'WINNER_FOUND') {
    const winnerNameRaw  = decision.winnerName || decision.winnerLabel || '';
    const winnerNameHtml = escapeHtml(winnerNameRaw);
    const liftDisplay = Math.floor(decision.liftPct);
    subject = `יש מנצח: ${winnerNameRaw} (+${liftDisplay}% שיפור) | ${test.name}`;
    headline = `<div style="background:#e8f5e9;border-right:4px solid #43a047;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#2e7d32;font-size:18px;font-weight:700;margin-bottom:4px;">🏆 ${winnerNameHtml} מנצחת</div>
      <div style="color:#388e3c;font-size:14px;">שיפור של <span dir="ltr">+${liftDisplay}%</span> מעל הוורסיה השנייה.</div>
    </div>`;
    body = `<p style="margin:0 0 12px;color:#444;font-size:14px;">המלצה: החלף את ה-LP במטא ל-${winnerNameHtml} ועצור את הטסט.</p>`;
    cta = btn('הכרז מנצח ועצור את הטסט', dashboardUrl);
  } else if (decision.verdict === 'PRACTICAL_TIE') {
    subject = `הטסט הסתיים — אין הבדל מובהק בין הוורסיות | ${test.name}`;
    headline = `<div style="background:#fafafa;border-right:4px solid #9e9e9e;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#424242;font-size:18px;font-weight:700;margin-bottom:4px;">אין מנצח ברור</div>
      <div style="color:#616161;font-size:14px;">הוורסיות הניבו ביצועים דומים בטווח השונות הסטטיסטית.</div>
    </div>`;
    body = `<p style="margin:0 0 12px;color:#444;font-size:14px;">מה זה כן אומר: ה-LP הקיים שלך עומד בפני וריאציות גסות. בטסט הבא, נסה שינוי גדול יותר (לדוגמה: הצעת ערך אחרת לחלוטין, לא רק שינוי כותרת).</p>`;
    cta = btn('צור טסט חדש', newTestUrl);
  } else {
    // TRENDING_UNDERPOWERED
    const winnerNameRaw  = decision.winnerName || decision.winnerLabel || '';
    const winnerNameHtml = escapeHtml(winnerNameRaw);
    subject = `${winnerNameRaw} מוביל אך לא מובהק — להאריך או להחליט? | ${test.name}`;
    headline = `<div style="background:#fff8e1;border-right:4px solid #ffa000;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#e65100;font-size:18px;font-weight:700;margin-bottom:4px;">${winnerNameHtml} מוביל — אך לא מובהק</div>
      <div style="color:#ef6c00;font-size:14px;">המגמה ברורה אבל אין מספיק נתונים לקבוע סופית.</div>
    </div>`;
    body = `<p style="margin:0 0 12px;color:#444;font-size:14px;">אפשרויות:</p>
      <ul style="margin:0 0 14px;padding-right:18px;color:#444;font-size:13px;line-height:1.7;">
        <li>להאריך את הטסט ב-50% נוספים מהדגימה — סביר שתגיע למובהקות.</li>
        <li>להחליט לפי המגמה ולעלות עם ${winnerNameHtml} עכשיו.</li>
        <li>לעצור ולנסות וריאציה חדשה לגמרי.</li>
      </ul>`;
    cta = btn('פתח את לוח הבקרה', dashboardUrl);
  }

  const html = SHELL_OPEN + headline + body + standingsTable + cta + SHELL_CLOSE;
  const text = `${subject}\n\n${dashboardUrl}`;
  return { subject, html, text };
}

export function renderStallAlertEmail(test) {
  const dashboardUrl = `${process.env.APP_URL || ''}/dashboard`;
  const subject = `עצירה: 0 מבקרים ב-48 השעות האחרונות | ${test.name}`;
  const html = SHELL_OPEN + `
    <div style="background:#fff3e0;border-right:4px solid #ff9800;padding:14px;border-radius:8px;margin:0 0 14px;">
      <div style="color:#e65100;font-size:18px;font-weight:700;margin-bottom:4px;">לא ראינו תנועה ב-48 שעות</div>
      <div style="color:#ef6c00;font-size:14px;">הטסט שלך פעיל, אבל לא הגיעו מבקרים.</div>
    </div>
    <p style="margin:0 0 6px;color:#444;font-size:14px;font-weight:600;">3 בדיקות מהירות:</p>
    <ol style="margin:0 0 14px;padding-right:18px;color:#444;font-size:13px;line-height:1.7;">
      <li>הקמפיין במטא — האם הוא פעיל ולא הושהה?</li>
      <li>פיקסל — האם הוא יורה? (בדוק ב-Meta Events Manager)</li>
      <li>URL — האם הקישור בקריאייטיב מצביע לדף הנכון?</li>
    </ol>
    <p style="margin:0 0 14px;color:#666;font-size:13px;">הטסט נשמר. ימשיך אוטומטית כשתחזור תנועה.</p>
    ${btn('בדוק את הטסט', dashboardUrl)}
  ` + SHELL_CLOSE;
  const text = `${test.name}: 0 מבקרים ב-48 שעות. בדוק קמפיין/פיקסל/URL.\n\n${dashboardUrl}`;
  return { subject, html, text };
}
