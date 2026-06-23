/*
 * feedback-widget.js — shared "report a problem" widget.
 * Included on every logged-in admin page (dashboard / new / settings / admin).
 * Self-contained: injects its own styles, depends only on the page's global
 * Supabase client `sb` for the session + storage upload. Renders ONLY with a
 * live session. Never loads on /lp/* (it is simply not referenced there).
 *
 * Round 👷 FAB → light panel: text + urgency (חוסם לי / מעצבן) + attachments
 * (screenshot via html2canvas, image upload) + "mark the spot on the page".
 * Posts { text, page_url, urgency, page_target, attachments[], access_token }
 * to /api/feedback. Fail-loud; typed text + attachments survive close/error.
 */
(function () {
  'use strict';
  if (window.__fbwLoaded) return;
  window.__fbwLoaded = true;

  var BUCKET = 'feedback-attachments';
  var MAX_ATTACHMENTS = 4;

  var COPY = {
    fab: 'דיווח על תקלה',
    heading: 'מה קרה?',
    placeholder: "לדוגמה: לחצתי על 'שליחת קמפיין' והכפתור לא הגיב",
    screenshot: 'צילום מסך',
    image: 'צירוף תמונה',
    locate: 'סימון המקום בעמוד',
    located: 'המקום סומן',
    urgencyQ: 'כמה זה דחוף?',
    blocking: 'חוסם לי',
    annoying: 'מעצבן',
    send: 'שליחה',
    sending: 'שולח…',
    locHint: 'הצביעו על האזור שבו קרתה התקלה ולחצו עליו  ·  Esc ליציאה',
    success: 'תודה! קיבלנו את הדיווח ונטפל בזה.',
    error: 'משהו השתבש בשליחה. אפשר לנסות שוב — מה שכתבת נשמר.',
    shotError: 'לא הצלחנו לצלם את המסך. אפשר לצרף תמונה במקום.',
  };

  var CSS = [
    '.fbw-fab{position:fixed;bottom:22px;left:22px;z-index:999998;width:56px;height:56px;border-radius:50%;',
    'border:0;cursor:pointer;background:#1c1c1e;color:#fff;font-size:26px;line-height:1;display:grid;place-items:center;',
    'box-shadow:0 8px 22px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.2);transition:transform .12s}',
    '.fbw-fab:hover{transform:translateY(-2px)}',
    '.fbw-ov{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:999997;display:none}',
    '.fbw-ov.fbw-show{display:block}',
    '.fbw-panel{position:fixed;left:22px;bottom:88px;z-index:999999;width:390px;max-width:calc(100vw - 28px);',
    'background:#fff;color:#1d1d1f;border-radius:20px;box-shadow:0 24px 60px rgba(0,0,0,.28);padding:18px 18px 16px;',
    'display:none;direction:rtl;text-align:right;font-family:inherit}',
    '.fbw-panel.fbw-show{display:block}',
    '.fbw-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}',
    '.fbw-head h3{margin:0;font-size:21px;font-weight:800;color:#111}',
    '.fbw-x{background:none;border:0;font-size:22px;line-height:1;color:#86868b;cursor:pointer;padding:2px 6px}',
    '.fbw-x:hover{color:#1d1d1f}',
    '.fbw-ta{width:100%;min-height:104px;resize:vertical;font:inherit;font-size:15px;color:#1d1d1f;background:#fff;',
    'border:1.5px solid #d2d2d7;border-radius:14px;padding:13px 14px;box-sizing:border-box}',
    '.fbw-ta::placeholder{color:#a1a1a6}',
    '.fbw-ta:focus{outline:none;border-color:#1c1c1e}',
    '.fbw-chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 4px}',
    '.fbw-chip{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #d2d2d7;color:#1d1d1f;',
    'border-radius:22px;padding:8px 14px;font:inherit;font-size:13.5px;cursor:pointer;transition:border-color .1s,background .1s}',
    '.fbw-chip:hover{border-color:#86868b}',
    '.fbw-chip.fbw-on{background:#1c1c1e;color:#fff;border-color:#1c1c1e}',
    '.fbw-thumbs{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0}',
    '.fbw-thumb{position:relative;width:56px;height:56px;border-radius:10px;overflow:hidden;border:1px solid #d2d2d7;background:#f5f5f7}',
    '.fbw-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
    '.fbw-thumb button{position:absolute;top:-6px;left:-6px;width:20px;height:20px;border-radius:50%;border:0;background:#1c1c1e;',
    'color:#fff;font-size:12px;line-height:1;cursor:pointer;display:grid;place-items:center}',
    '.fbw-urg-q{margin:16px 0 7px;color:#86868b;font-size:13px}',
    '.fbw-urg{display:flex;gap:8px}',
    '.fbw-urg button{flex:0 0 auto;background:#fff;border:1px solid #d2d2d7;color:#1d1d1f;border-radius:11px;padding:9px 18px;',
    'font:inherit;font-size:14px;cursor:pointer}',
    '.fbw-urg button.fbw-on{background:#1c1c1e;color:#fff;border-color:#1c1c1e}',
    '.fbw-send{width:100%;margin-top:16px;border:0;border-radius:13px;padding:13px;font:inherit;font-size:16px;font-weight:700;',
    'cursor:pointer;background:#1c1c1e;color:#fff;display:flex;align-items:center;justify-content:center;gap:8px}',
    '.fbw-send:disabled{background:#e8e8ed;color:#a1a1a6;cursor:not-allowed}',
    '.fbw-spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;',
    'display:inline-block;animation:fbw-rot .7s linear infinite}',
    '@keyframes fbw-rot{to{transform:rotate(360deg)}}',
    '.fbw-lochint{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:1000002;background:#1c1c1e;color:#fff;',
    'padding:11px 20px;border-radius:24px;font-size:14px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.5);direction:rtl;pointer-events:none}',
    '.fbw-hl{position:fixed;z-index:1000000;pointer-events:none;display:none;border:2px solid #f5c842;border-radius:5px;',
    'background:rgba(245,200,66,.12);box-shadow:0 0 0 9999px rgba(0,0,0,.45)}',
    '.fbw-pick-label{position:fixed;z-index:1000001;pointer-events:none;display:none;background:#f5c842;color:#1a1408;',
    'font-weight:700;font-size:13px;padding:4px 10px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.45);',
    'white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis;direction:rtl}',
    '.fbw-locrow{display:flex;align-items:center;gap:8px;margin:10px 0 0;background:#f5f5f7;border:1px solid #e0e0e5;',
    'border-radius:10px;padding:8px 12px;font-size:13px;color:#1d1d1f}',
    '.fbw-loc-txt{flex:1;word-break:break-word}',
    '.fbw-loc-clear{background:none;border:0;color:#86868b;cursor:pointer;font-size:15px;line-height:1;padding:0 2px}',
    '.fbw-toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(20px);z-index:1000000;',
    'background:#1c1c1e;color:#fff;padding:12px 18px;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.4);font-size:14.5px;',
    'max-width:90vw;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;direction:rtl}',
    '.fbw-toast.fbw-show{opacity:1;transform:translateX(-50%) translateY(0)}',
    '.fbw-toast.fbw-ok{background:#1d6b3a}',
    '.fbw-toast.fbw-err{background:#9b2c2c}',
  ].join('');

  if (typeof sb === 'undefined' || !sb || !sb.auth) return;
  sb.auth.getSession().then(function (r) {
    var session = r && r.data && r.data.session;
    if (session) build();
  }).catch(function (err) { console.error('[feedback-widget] session check failed:', err); });

  function el(tag, props, text) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) { n[k] = props[k]; });
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    var style = el('style'); style.textContent = CSS; document.head.appendChild(style);

    // state
    var urgency = null;             // 'blocking' | 'annoying'
    var pageTarget = null;          // short description of the clicked element
    var attachments = [];           // [{ blob, kind, url }]

    // toast
    var toast = el('div', { className: 'fbw-toast' }); document.body.appendChild(toast);
    var toastTimer = null;
    function flash(kind, msg) {
      toast.textContent = msg;
      toast.className = 'fbw-toast fbw-show ' + (kind === 'ok' ? 'fbw-ok' : 'fbw-err');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.className = 'fbw-toast ' + (kind === 'ok' ? 'fbw-ok' : 'fbw-err'); }, 3400);
    }

    // FAB
    var fab = el('button', { className: 'fbw-fab', type: 'button', title: COPY.fab }, '👷');
    fab.setAttribute('aria-haspopup', 'dialog');
    document.body.appendChild(fab);

    // overlay + panel
    var ov = el('div', { className: 'fbw-ov' });
    var panel = el('div', { className: 'fbw-panel' });
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', COPY.heading);

    var head = el('div', { className: 'fbw-head' });
    head.appendChild(el('h3', null, COPY.heading));
    var xBtn = el('button', { className: 'fbw-x', type: 'button', title: 'סגירה' }, '✕');
    head.appendChild(xBtn);
    panel.appendChild(head);

    var ta = el('textarea', { className: 'fbw-ta', placeholder: COPY.placeholder, maxLength: 5000 });
    panel.appendChild(ta);

    // option chips
    var chips = el('div', { className: 'fbw-chips' });
    var shotChip = chip('📷', COPY.screenshot);
    var imgChip = chip('🖼', COPY.image);
    var locChip = chip('📍', COPY.locate);
    chips.appendChild(shotChip); chips.appendChild(imgChip); chips.appendChild(locChip);
    panel.appendChild(chips);

    var fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    fileInput.style.display = 'none';
    panel.appendChild(fileInput);

    var thumbs = el('div', { className: 'fbw-thumbs' });
    panel.appendChild(thumbs);

    // confirmation of the marked spot (hidden until something is picked)
    var locDisplay = el('div', { className: 'fbw-locrow' });
    locDisplay.style.display = 'none';
    panel.appendChild(locDisplay);

    // urgency
    panel.appendChild(el('div', { className: 'fbw-urg-q' }, COPY.urgencyQ));
    var urg = el('div', { className: 'fbw-urg' });
    var blockingBtn = el('button', { type: 'button' }, COPY.blocking);
    var annoyingBtn = el('button', { type: 'button' }, COPY.annoying);
    urg.appendChild(blockingBtn); urg.appendChild(annoyingBtn);
    panel.appendChild(urg);

    // send
    var send = el('button', { className: 'fbw-send', type: 'button', disabled: true });
    var planeIcon = el('span', null, '➤'); var sendLabel = el('span', null, COPY.send);
    send.appendChild(sendLabel); send.appendChild(planeIcon);
    panel.appendChild(send);

    document.body.appendChild(ov); document.body.appendChild(panel);

    function chip(icon, label) {
      var c = el('button', { className: 'fbw-chip', type: 'button' });
      c.appendChild(el('span', null, icon));
      c.appendChild(el('span', null, label));
      return c;
    }

    // ---- behavior ----
    function open() { ov.classList.add('fbw-show'); panel.classList.add('fbw-show'); setTimeout(function () { ta.focus(); }, 30); syncSend(); }
    function close() { ov.classList.remove('fbw-show'); panel.classList.remove('fbw-show'); send.disabled = false; sendLabel.textContent = COPY.send; syncSend(); }
    function syncSend() { send.disabled = ta.value.trim().length === 0 && attachments.length === 0; }

    fab.addEventListener('click', open);
    xBtn.addEventListener('click', close);
    ov.addEventListener('click', close);
    ta.addEventListener('input', syncSend);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel.classList.contains('fbw-show')) close(); });

    // attachments
    function addAttachment(blob, kind) {
      if (attachments.length >= MAX_ATTACHMENTS) { flash('err', 'אפשר לצרף עד ' + MAX_ATTACHMENTS + ' קבצים'); return; }
      var url = URL.createObjectURL(blob);
      var item = { blob: blob, kind: kind, url: url };
      attachments.push(item);
      var t = el('div', { className: 'fbw-thumb' });
      t.appendChild(el('img', { src: url, alt: kind }));
      var rm = el('button', { type: 'button', title: 'הסרה' }, '✕');
      rm.addEventListener('click', function () {
        var i = attachments.indexOf(item);
        if (i > -1) attachments.splice(i, 1);
        URL.revokeObjectURL(url); t.remove(); syncSend();
      });
      t.appendChild(rm); thumbs.appendChild(t); syncSend();
    }

    imgChip.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (f) addAttachment(f, 'image');
      fileInput.value = '';
    });

    shotChip.addEventListener('click', function () { captureScreenshot(); });
    async function captureScreenshot() {
      panel.style.visibility = 'hidden'; ov.style.visibility = 'hidden';
      try {
        await ensureHtml2canvas();
        var canvas = await window.html2canvas(document.body, { useCORS: true, logging: false, scale: Math.min(window.devicePixelRatio || 1, 2) });
        var blob = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
        panel.style.visibility = ''; ov.style.visibility = '';
        if (blob) addAttachment(blob, 'screenshot');
      } catch (err) {
        console.error('[feedback-widget] screenshot failed:', err);
        panel.style.visibility = ''; ov.style.visibility = '';
        flash('err', COPY.shotError);
      }
    }
    function ensureHtml2canvas() {
      if (window.html2canvas) return Promise.resolve();
      return new Promise(function (res, rej) {
        var s = el('script', { src: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js' });
        s.onload = res; s.onerror = rej; document.head.appendChild(s);
      });
    }

    // locate-on-page: hover highlights + NAMES the element under the pointer; click to pick.
    function cut(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
    // A plain-Hebrew description of an element, so the user understands what they're picking.
    function friendlyLabel(elm) {
      if (!elm || !elm.tagName) return 'אזור';
      var tag = elm.tagName.toLowerCase();
      var role = elm.getAttribute && elm.getAttribute('role');
      var TYPES = { button:'כפתור', a:'קישור', input:'שדה', textarea:'שדה טקסט', select:'תפריט',
                    img:'תמונה', h1:'כותרת', h2:'כותרת', h3:'כותרת', h4:'כותרת', label:'תווית',
                    li:'פריט', table:'טבלה', svg:'אייקון' };
      var type = (role === 'button') ? 'כפתור' : (TYPES[tag] || 'אזור');
      if (tag === 'img') { var alt = (elm.getAttribute('alt') || '').trim(); return alt ? 'תמונה: ' + cut(alt, 40) : 'תמונה'; }
      if (tag === 'input') { var ph = (elm.getAttribute('placeholder') || elm.value || '').trim(); return ph ? 'שדה: ' + cut(ph, 40) : 'שדה'; }
      var txt = (elm.textContent || '').trim().replace(/\s+/g, ' ');
      return txt ? type + ': ' + cut(txt, 45) : type;
    }
    function showLocDisplay() {
      locDisplay.textContent = '';
      locDisplay.appendChild(el('span', { className: 'fbw-loc-txt' }, '📍 ' + pageTarget));
      var clr = el('button', { className: 'fbw-loc-clear', type: 'button', title: 'הסרה' }, '✕');
      clr.addEventListener('click', clearLoc);
      locDisplay.appendChild(clr);
      locDisplay.style.display = 'flex';
    }
    function clearLoc() {
      pageTarget = null; locDisplay.style.display = 'none';
      locChip.classList.remove('fbw-on'); locChip.lastChild.textContent = COPY.locate;
    }

    locChip.addEventListener('click', function () { startLocate(); });
    function startLocate() {
      ov.classList.remove('fbw-show'); panel.classList.remove('fbw-show');
      document.body.style.cursor = 'pointer';
      var hint = el('div', { className: 'fbw-lochint' }, COPY.locHint);
      var hl = el('div', { className: 'fbw-hl' });
      var lbl = el('div', { className: 'fbw-pick-label' });
      document.body.appendChild(hint); document.body.appendChild(hl); document.body.appendChild(lbl);
      function onMove(e) {
        var t = e.target;
        if (!t || t === hl || t === lbl || t === hint || t === fab) return; // keep the last highlight
        var r = t.getBoundingClientRect();
        if (!r.width && !r.height) { hl.style.display = 'none'; lbl.style.display = 'none'; return; }
        hl.style.display = 'block';
        hl.style.top = r.top + 'px'; hl.style.left = r.left + 'px';
        hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
        lbl.textContent = friendlyLabel(t);
        lbl.style.display = 'block';
        var lt = r.top - 30; if (lt < 6) lt = r.bottom + 8;
        var ll = Math.min(r.left, window.innerWidth - lbl.offsetWidth - 8); if (ll < 8) ll = 8;
        lbl.style.top = lt + 'px'; lbl.style.left = ll + 'px';
      }
      function onClick(e) {
        if (e.target === fab) return; // ignore the FAB itself
        e.preventDefault(); e.stopPropagation();
        pageTarget = friendlyLabel(e.target);
        locChip.classList.add('fbw-on'); locChip.lastChild.textContent = COPY.located;
        showLocDisplay();
        cleanup(); open();
      }
      function onKey(e) { if (e.key === 'Escape') { cleanup(); open(); } }
      function cleanup() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        document.body.style.cursor = ''; hl.remove(); hint.remove(); lbl.remove();
      }
      setTimeout(function () {
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
      }, 0);
    }

    // urgency toggle
    function pickUrgency(val, btn) {
      if (urgency === val) { urgency = null; btn.classList.remove('fbw-on'); return; }
      urgency = val; blockingBtn.classList.remove('fbw-on'); annoyingBtn.classList.remove('fbw-on'); btn.classList.add('fbw-on');
    }
    blockingBtn.addEventListener('click', function () { pickUrgency('blocking', blockingBtn); });
    annoyingBtn.addEventListener('click', function () { pickUrgency('annoying', annoyingBtn); });

    // technical info for debugging (sent with the ticket)
    function collectClientInfo() {
      try {
        return {
          ua: navigator.userAgent,
          viewport: window.innerWidth + 'x' + window.innerHeight,
          screen: window.screen ? window.screen.width + 'x' + window.screen.height : '',
          dpr: window.devicePixelRatio,
          lang: navigator.language,
          platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
        };
      } catch (e) { return null; }
    }

    // submit
    send.addEventListener('click', function () { submit(); });
    async function submit() {
      var text = ta.value.trim();
      if (!text && attachments.length === 0) return;
      send.disabled = true; sendLabel.textContent = COPY.sending;
      planeIcon.className = 'fbw-spin'; planeIcon.textContent = '';
      try {
        var sess = await sb.auth.getSession();
        var session = sess && sess.data && sess.data.session;
        if (!session) throw new Error('no active session');
        var uploaded = await uploadAttachments(session.user.id);
        var res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text, page_url: window.location.href,
            urgency: urgency, page_target: pageTarget,
            attachments: uploaded, client_info: collectClientInfo(),
            access_token: session.access_token,
          }),
        });
        if (!res.ok) { var d = await res.text().catch(function () { return ''; }); throw new Error('submit ' + res.status + ' ' + d); }
        resetForm(); close(); flash('ok', COPY.success);
      } catch (err) {
        console.error('[feedback-widget] submit failed:', err);
        send.disabled = false; sendLabel.textContent = COPY.send; planeIcon.className = ''; planeIcon.textContent = '➤';
        flash('err', COPY.error);
      }
    }

    async function uploadAttachments(userId) {
      var out = [];
      for (var i = 0; i < attachments.length; i++) {
        var a = attachments[i];
        var ext = a.kind === 'screenshot' ? 'png' : (String(a.blob.type).split('/')[1] || 'png');
        var path = userId + '/' + (self.crypto && crypto.randomUUID ? crypto.randomUUID() : String(i) + '-' + ta.value.length) + '.' + ext;
        var up = await sb.storage.from(BUCKET).upload(path, a.blob, { contentType: a.blob.type, upsert: false });
        if (up.error) throw new Error('upload failed: ' + up.error.message);
        out.push({ path: path, kind: a.kind });
      }
      return out;
    }

    function resetForm() {
      ta.value = '';
      urgency = null; blockingBtn.classList.remove('fbw-on'); annoyingBtn.classList.remove('fbw-on');
      pageTarget = null; locChip.classList.remove('fbw-on'); locChip.lastChild.textContent = COPY.locate;
      locDisplay.style.display = 'none';
      attachments.forEach(function (a) { URL.revokeObjectURL(a.url); });
      attachments = []; thumbs.textContent = '';
      planeIcon.className = ''; planeIcon.textContent = '➤';
    }
  }
})();
