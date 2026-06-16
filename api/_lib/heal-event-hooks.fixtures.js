// Real LP event-block fixtures pulled READ-ONLY from Supabase (project
// uaspcafukqvgiztzdnfu) for testing healEventHooks. Trimmed to the event block
// + minimal surrounding markup. Used by heal-event-hooks.test.js.
//
// Each single-event fixture has EXACTLY ONE 📅 (date emoji). The multi-event
// fixture has TWO. The false-positive has ZERO.

// S1 — variant 33b6c54e — event__info-card grid; label in its own div, value in
// .value div with trailing <br> markup; cost emoji ✨.
export const S1 = `<div class="event__details reveal">
  <div class="event__info-grid">
    <div class="event__info-card">
      <div class="icon">📅</div>
      <div class="label">מתי</div>
      <div class="value">9.7.2026<br>בשעה 20:00</div>
    </div>
    <div class="event__info-card">
      <div class="icon">📍</div>
      <div class="label">איפה</div>
      <div class="value">מרחב בּיתי<br>הראובני 7, יפו</div>
    </div>
    <div class="event__info-card">
      <div class="icon">✨</div>
      <div class="label">עלות</div>
      <div class="value">100 ש״ח<br><span>כולל אוזניות וכיבוד קל</span></div>
    </div>
  </div>
</div>`;

// S2 — variant 6f886bfd — event-detail rows; <strong>label:</strong> inline, plain value; cost 🎟️.
export const S2 = `<div class="event-details reveal">
  <div class="event-detail">
    <div class="event-detail-icon">📅</div>
    <div><strong>מתי:</strong> 15.7.2026</div>
  </div>
  <div class="event-detail">
    <div class="event-detail-icon">📍</div>
    <div><strong>איפה:</strong> מרחב בִּיתי, רחוב הראובני 7, סמטאות יפו</div>
  </div>
  <div class="event-detail">
    <div class="event-detail-icon">🎟️</div>
    <div><strong>עלות:</strong> הכניסה חופשית, אך מותנית ברישום מראש</div>
  </div>
</div>`;

// S3 — variant 437b8bde — ALREADY HOOKED (idempotent test); location row has a
// trailing <small> that must stay OUTSIDE the span; cost 🎟️.
export const S3 = `<div class="event-details animate-on-scroll">
  <div class="event-detail-row">
    <span class="detail-icon">📅</span>
    <span><strong>מתי:</strong> <span data-editable="event_date">11/6/2026</span></span>
  </div>
  <div class="event-detail-row">
    <span class="detail-icon">📍</span>
    <span><strong>איפה:</strong> <span data-editable="event_location">מרחב בִּיתְי, סמטאות יפו</span> <small style="color:var(--text-light);">(כתובת מלאה תישלח לנרשמים)</small></span>
  </div>
  <div class="event-detail-row">
    <span class="detail-icon">🎟️</span>
    <span><strong>עלות:</strong> <span data-editable="event_cost">הכניסה חופשית</span></span>
  </div>
</div>`;

// S4 — variant d9f69f33 — event-detail-card; .detail-label + .detail-value divs; cost 🎁 (gift).
export const S4 = `<div class="event-details animate-on-scroll">
  <div class="event-detail-card">
    <div class="detail-icon">📅</div>
    <div class="detail-label">מתי</div>
    <div class="detail-value">11.6.2026</div>
  </div>
  <div class="event-detail-card">
    <div class="detail-icon">📍</div>
    <div class="detail-label">איפה</div>
    <div class="detail-value">מרחב בִּתְאָ, סמטאות יפו</div>
  </div>
  <div class="event-detail-card">
    <div class="detail-icon">🎁</div>
    <div class="detail-label">עלות</div>
    <div class="detail-value">הכניסה חופשית</div>
  </div>
</div>`;

// S5 — variant ee2c276a — detail-row; <span class="detail-label">מתי: </span><span class="detail-value">…</span>; cost 💫.
export const S5 = `<div class="event-details reveal">
  <h3>פרטי האירוע</h3>
  <div class="detail-row">
    <span class="detail-icon">📅</span>
    <div><span class="detail-label">מתי: </span><span class="detail-value">9/7/2025 בשעה 20:00</span></div>
  </div>
  <div class="detail-row">
    <span class="detail-icon">📍</span>
    <div><span class="detail-label">איפה: </span><span class="detail-value">מרחב בִּיתי, רחוב הראובני 7</span></div>
  </div>
  <div class="detail-row">
    <span class="detail-icon">💫</span>
    <div><span class="detail-label">עלות: </span><span class="detail-value">100 ש״ח (אירוע בוטיק)</span></div>
  </div>
</div>`;

// MULTI — variant fcaaab7d — TWO event-meta blocks, EACH with one 📅 → total 2 → BAIL.
export const MULTI = `<div class="events-wrap">
  <div class="event-card">
    <div class="event-meta">
      <span>📅 11/6/2026</span>
      <span>📍 מרחב בִּתְאָ, יפו</span>
      <span>💰 ללא תשלום</span>
    </div>
  </div>
  <div class="event-card">
    <div class="event-meta">
      <span>📅 17/6/2026</span>
      <span>📍 מרחב בִּתְאָ, יפו</span>
      <span>💰 100 ש"ח</span>
    </div>
  </div>
</div>`;

// FALSE_POSITIVE — variant 56ba2d1a (lipaz-ela-1) shape: no 📅 anywhere → no heal.
export const FALSE_POSITIVE = `<section class="hero">
  <h1>בית חי</h1>
  <p>מקום של שייכות ✨ קהילה חמה</p>
  <a class="cta-button" data-cta="true">להצטרף</a>
</section>`;
