// Piece 2B — auto-heal un-hooked single-event LPs.
//
// PURE module. healEventHooks(htmlString, parser) -> { html, healed, reason }.
// `parser` is an injected DOMParser instance: the browser passes `new DOMParser()`,
// node tests pass linkedom's DOMParser (node's runtime has no DOMParser).
//
// SAFETY-CRITICAL GATE: single-vs-multi-event is decided by COUNTING the 📅
// DATE-EMOJI occurrences in the parsed DOM — NOT by class names.
//   • 0  📅 → no event block        → { healed:false, reason:'no-event-block' }, ORIGINAL html.
//   • 1  📅 → single event          → heal in place.
//   • >=2 📅 → multi-event          → BAIL { healed:false, reason:'multi-event' }, ORIGINAL html.
//
// Bail / no-heal paths NEVER serialize — they return the byte-identical original
// string. Only the heal path reserializes (and is re-parsed by a validity guard).

const DATE_EMOJI = "📅";
const LOCATION_EMOJI = "📍";
// Cost can be any of these glyphs; if none match we fall back to the THIRD detail row.
const COST_EMOJIS = ["🎟️", "🎫", "💫", "✨", "💰", "💵", "🎁"];

// Hebrew labels (with/without trailing colon) we strip off the value run.
const LABELS = ["מתי", "איפה", "עלות"];

// Match a leading emoji (with optional VS16 / ZWJ sequences) at the start of a string.
// Broad enough to cover the date/location/cost glyphs plus their selectors.
const LEADING_EMOJI_RE =
  /^[\s‍]*(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)+[\s‍]*/u;

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

// Strip a leading emoji run + an optional Hebrew label (bare or "label:") from text.
// Returns the value run with leading emoji/label removed (trailing text untouched).
function stripEmojiAndLabel(text) {
  let out = text;
  // Remove a leading emoji run.
  out = out.replace(LEADING_EMOJI_RE, "");
  // Remove a leading label like "מתי:" / "מתי" / "מתי: " (with optional surrounding ws).
  const labelRe = new RegExp(`^[\\s]*(?:${LABELS.join("|")})\\s*:?\\s*`);
  out = out.replace(labelRe, "");
  return out;
}

// True if a text run is "just an emoji" (icon-only node) — nothing left after stripping.
function isEmojiOnly(text) {
  return text.replace(LEADING_EMOJI_RE, "").trim() === "";
}

// True if a text run is "just a label" (e.g. "מתי:").
function isLabelOnly(text) {
  const t = text.trim().replace(/:$/, "").trim();
  return LABELS.includes(t);
}

// Does this element (or any descendant) already carry an event_* value hook?
function hasEventHook(el, key) {
  return !!el.querySelector(`[data-editable="${key}"]`);
}

// Find the detail-row container that holds a given leading emoji.
// We look for the smallest element whose OWN text (excluding nested rows) begins
// with the emoji, then climb to the row-level container that also holds the value.
function findRowByEmoji(root, emoji) {
  const all = root.querySelectorAll("*");
  for (const el of all) {
    // The emoji must appear as direct text of this element (icon node) — check
    // children for a node whose text content starts with the emoji.
    const txt = (el.textContent || "");
    if (!txt.includes(emoji)) continue;
    // Find the icon-bearing element: the deepest element whose trimmed text is the emoji.
    if (isEmojiOnly(el.textContent || "") && (el.textContent || "").includes(emoji)) {
      // climb to a parent that also contains a non-emoji, non-label value.
      let row = el.parentElement;
      while (row && !rowHasValue(row)) row = row.parentElement;
      if (row) return row;
    }
  }
  // Fallback: the inline "📅 text" case (emoji + value in the SAME text node).
  for (const el of all) {
    const direct = directText(el);
    if (direct && direct.trimStart().startsWith(emoji) && !isEmojiOnly(direct)) {
      return el;
    }
  }
  return null;
}

// Concatenated DIRECT text of an element (its own text nodes only).
function directText(el) {
  let s = "";
  for (const n of el.childNodes) {
    if (n.nodeType === 3) s += n.nodeValue || "";
  }
  return s;
}

// Does a row contain a value text node (non-emoji, non-label, non-empty)?
function rowHasValue(row) {
  return !!findValueTextNode(row);
}

// Locate the value-bearing TEXT NODE inside a row: the first text node, in document
// order, that is non-empty, not emoji-only, and not label-only.
function findValueTextNode(row) {
  const queue = [];
  walk(row, queue);
  for (const n of queue) {
    if (n.nodeType !== 3) continue;
    const v = n.nodeValue || "";
    if (v.trim() === "") continue;
    if (isEmojiOnly(v)) continue;
    if (isLabelOnly(v)) continue;
    // A text node that is "label: value" inline (S2: " 15.7.2026" after <strong>) —
    // after stripping label/emoji it must still have content.
    if (stripEmojiAndLabel(v).trim() === "") continue;
    return n;
  }
  return null;
}

// Document-order traversal collecting nodes into `out`.
function walk(node, out) {
  for (const child of node.childNodes) {
    out.push(child);
    if (child.nodeType === 1) walk(child, out);
  }
}

// Heal one row: wrap the leading plain-text run of its value text node in
// <span data-editable="key">…</span>. Trailing markup stays OUTSIDE the span.
// Returns true if it wrapped, false if nothing to do.
function healRow(doc, row, key) {
  if (!row) return false;
  if (hasEventHook(row, key)) return false; // idempotent — skip already-hooked rows.

  const textNode = findValueTextNode(row);
  if (!textNode) return false;

  const raw = textNode.nodeValue || "";
  const stripped = stripEmojiAndLabel(raw);
  const value = stripped.trim();
  if (!value) return false;

  // Preserve the prefix (emoji/label/whitespace we stripped) and any trailing
  // whitespace after the value run, so surrounding layout is unchanged.
  const prefixLen = raw.length - stripped.length;
  const prefix = raw.slice(0, prefixLen);
  const afterValueIdx = raw.indexOf(value, prefixLen) + value.length;
  const suffix = raw.slice(afterValueIdx);

  const span = doc.createElement("span");
  span.setAttribute("data-editable", key);
  span.textContent = value;

  const parent = textNode.parentNode;
  // Replace the single text node with: [prefix text] [span] [suffix text].
  if (prefix) parent.insertBefore(doc.createTextNode(prefix), textNode);
  parent.insertBefore(span, textNode);
  if (suffix) parent.insertBefore(doc.createTextNode(suffix), textNode);
  parent.removeChild(textNode);
  return true;
}

export function healEventHooks(htmlString, parser) {
  if (typeof htmlString !== "string" || !htmlString) {
    return { html: htmlString, healed: false, reason: "empty" };
  }

  // Parse a copy for DECISION + LOCATION. We only serialize if we actually heal.
  const doc = parser.parseFromString(
    `<!DOCTYPE html><html><body>${htmlString}</body></html>`,
    "text/html"
  );
  const body = doc.body || doc.querySelector("body");
  if (!body) return { html: htmlString, healed: false, reason: "parse-error" };

  // --- SAFETY GATE: count 📅 in the parsed DOM text (NOT class names) ---
  const dateCount = countOccurrences(body.textContent || "", DATE_EMOJI);
  if (dateCount === 0) {
    return { html: htmlString, healed: false, reason: "no-event-block" };
  }
  if (dateCount >= 2) {
    // Multi-event LP — never auto-heal (would corrupt the page). Byte-identical bail.
    return { html: htmlString, healed: false, reason: "multi-event" };
  }

  // --- single event: locate the three rows by leading emoji ---
  const dateRow = findRowByEmoji(body, DATE_EMOJI);
  const locationRow = findRowByEmoji(body, LOCATION_EMOJI);
  let costRow = null;
  for (const ce of COST_EMOJIS) {
    costRow = findRowByEmoji(body, ce);
    if (costRow) break;
  }
  // Fallback: third detail row sharing the date row's parent.
  if (!costRow && dateRow && dateRow.parentElement) {
    const siblings = [...dateRow.parentElement.children].filter(
      (c) => c !== dateRow && c !== locationRow && (c.textContent || "").trim() !== ""
    );
    // Exclude obvious non-rows (headings) and the location row.
    costRow = siblings.find((c) => c.tagName !== "H3" && c !== locationRow) || null;
  }

  let healed = false;
  healed = healRow(doc, dateRow, "event_date") || healed;
  healed = healRow(doc, locationRow, "event_location") || healed;
  healed = healRow(doc, costRow, "event_cost") || healed;

  if (!healed) {
    // Nothing to wrap (already hooked / no extractable value) — byte-identical.
    return { html: htmlString, healed: false, reason: "already-hooked" };
  }

  const out = body.innerHTML;

  // --- VALIDITY GUARD: re-parse; if parse error or unbalanced spans, revert. ---
  try {
    const check = parser.parseFromString(
      `<!DOCTYPE html><html><body>${out}</body></html>`,
      "text/html"
    );
    const checkBody = check.body || check.querySelector("body");
    if (!checkBody) {
      return { html: htmlString, healed: false, reason: "validity-guard" };
    }
    const openSpans = (out.match(/<span\b/gi) || []).length;
    const closeSpans = (out.match(/<\/span>/gi) || []).length;
    if (openSpans !== closeSpans) {
      return { html: htmlString, healed: false, reason: "validity-guard" };
    }
    // Each editable value span must contain no nested '<' in its inner text.
    const innerRe = /data-editable="event_(?:date|location|cost)"[^>]*>([\s\S]*?)<\/span>/gi;
    let m;
    while ((m = innerRe.exec(out)) !== null) {
      if (m[1].includes("<")) {
        return { html: htmlString, healed: false, reason: "validity-guard" };
      }
    }
  } catch (e) {
    return { html: htmlString, healed: false, reason: "validity-guard" };
  }

  return { html: out, healed: true, reason: "healed" };
}
