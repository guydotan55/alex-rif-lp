// Piece 2B — auto-heal un-hooked single-event LPs.
//
// PURE module. healEventHooks(htmlString, parser) -> { html, healed, reason }.
// `parser` is an injected DOMParser instance: the browser passes `new DOMParser()`,
// node tests pass linkedom's DOMParser (node's runtime has no DOMParser).
//
// SAFETY-CRITICAL GATE: single-vs-multi-event is decided by COUNTING the 📅
// DATE-EMOJI occurrences in the parsed DOM — NOT by class names.
//   • 0  📅 → no event block → no heal, ORIGINAL html.
//   • 1  📅 → single event   → heal.
//   • >=2 📅 → multi-event    → BAIL, ORIGINAL html.
//
// HEALING IS BYTE-FAITHFUL. We use the DOM only to LOCATE each value string, then
// wrap that exact substring in the ORIGINAL html — and only when it occurs exactly
// once. Everything outside the wrapped values stays byte-for-byte identical; we
// never reserialize the document (a full DOM round-trip could re-encode
// <style>/<script>/entities on a live /lp page).
//
// SCOPING: location & cost are located ONLY inside the date row's container, so a
// decorative 📍/✨/💰 elsewhere on the page can never be mis-hooked as an event
// field (the bug that wrapped a story heading as event_cost).

const DATE_EMOJI = "📅";
const LOCATION_EMOJI = "📍";
// Cost can be any of these glyphs; if none match (within the event container) we
// fall back to the remaining detail row sharing the date row's parent.
const COST_EMOJIS = ["🎟️", "🎫", "💫", "✨", "💰", "💵", "🎁"];
const LABELS = ["מתי", "איפה", "עלות"];

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

// Strip a leading emoji run + an optional Hebrew label ("מתי" / "מתי:" …) off a run.
function stripEmojiAndLabel(text) {
  let out = text.replace(LEADING_EMOJI_RE, "");
  const labelRe = new RegExp(`^[\\s]*(?:${LABELS.join("|")})\\s*:?\\s*`);
  out = out.replace(labelRe, "");
  return out;
}

function isEmojiOnly(text) {
  return text.replace(LEADING_EMOJI_RE, "").trim() === "";
}

function isLabelOnly(text) {
  const t = text.trim().replace(/:$/, "").trim();
  return LABELS.includes(t);
}

// Concatenated DIRECT text of an element (its own text nodes only).
function directText(el) {
  let s = "";
  for (const n of el.childNodes) {
    if (n.nodeType === 3) s += n.nodeValue || "";
  }
  return s;
}

// Document-order traversal collecting nodes into `out`.
function walk(node, out) {
  for (const child of node.childNodes) {
    out.push(child);
    if (child.nodeType === 1) walk(child, out);
  }
}

// First value-bearing TEXT NODE inside a row: non-empty, not emoji-only, not
// label-only, and with content remaining after stripping any leading emoji/label.
function findValueTextNode(row) {
  const queue = [];
  walk(row, queue);
  for (const n of queue) {
    if (n.nodeType !== 3) continue;
    const v = n.nodeValue || "";
    if (v.trim() === "") continue;
    if (isEmojiOnly(v)) continue;
    if (isLabelOnly(v)) continue;
    if (stripEmojiAndLabel(v).trim() === "") continue;
    return n;
  }
  return null;
}

function rowHasValue(row) {
  return !!findValueTextNode(row);
}

// Find the row-level element that holds a given leading emoji, searched WITHIN
// `root` only. Climbs from the icon node to the nearest ancestor that has a value.
function findRowByEmoji(root, emoji) {
  const all = root.querySelectorAll("*");
  for (const el of all) {
    if (!(el.textContent || "").includes(emoji)) continue;
    if (isEmojiOnly(el.textContent || "")) {
      let row = el.parentElement;
      while (row && row !== root.parentElement && !rowHasValue(row)) row = row.parentElement;
      if (row && rowHasValue(row)) return row;
    }
  }
  // Inline "📅 value" case (emoji + value in the SAME text node).
  for (const el of all) {
    const direct = directText(el);
    if (direct && direct.trimStart().startsWith(emoji) && !isEmojiOnly(direct)) return el;
  }
  return null;
}

// The cost row, located ONLY inside the event container (never page-global).
function findCostRow(container, dateRow, locationRow) {
  for (const ce of COST_EMOJIS) {
    const row = findRowByEmoji(container, ce);
    if (row && row !== dateRow && row !== locationRow) return row;
  }
  // Positional fallback: the remaining detail row sharing the date row's parent.
  const siblings = [...container.children].filter(
    (c) => c !== dateRow && c !== locationRow && c.tagName !== "H3" && rowHasValue(c)
  );
  return siblings[0] || null;
}

// The leading plain-text value run of a row (emoji + label stripped), or null.
function extractValue(row) {
  if (!row) return null;
  const textNode = findValueTextNode(row);
  if (!textNode) return null;
  const value = stripEmojiAndLabel(textNode.nodeValue || "").trim();
  return value || null;
}

export function healEventHooks(htmlString, parser) {
  if (typeof htmlString !== "string" || !htmlString) {
    return { html: htmlString, healed: false, reason: "empty" };
  }

  let doc;
  try {
    // Production LPs are full <!DOCTYPE html> documents → parse as-is. A bare
    // fragment must be wrapped in <body> for the parser to expose its content
    // (linkedom leaves doc.body empty otherwise). Either way the string-splice
    // below operates on the ORIGINAL htmlString, so output stays byte-faithful.
    const looksFull = /^\s*(?:<!doctype\b|<html[\s>])/i.test(htmlString);
    const toParse = looksFull
      ? htmlString
      : `<!DOCTYPE html><html><body>${htmlString}</body></html>`;
    doc = parser.parseFromString(toParse, "text/html");
  } catch (e) {
    return { html: htmlString, healed: false, reason: "parse-error" };
  }
  const root = (doc && (doc.body || doc.documentElement)) || null;
  if (!root) return { html: htmlString, healed: false, reason: "parse-error" };

  // --- SAFETY GATE: count 📅 in DOM text (NOT class names) ---
  const dateCount = countOccurrences(root.textContent || "", DATE_EMOJI);
  if (dateCount === 0) return { html: htmlString, healed: false, reason: "no-event-block" };
  if (dateCount >= 2) return { html: htmlString, healed: false, reason: "multi-event" };

  // Anchor on the single date row; scope location + cost to its container.
  const dateRow = findRowByEmoji(root, DATE_EMOJI);
  if (!dateRow) return { html: htmlString, healed: false, reason: "no-date-row" };
  const container = dateRow.parentElement || dateRow;
  const locationRow = findRowByEmoji(container, LOCATION_EMOJI);
  const costRow = findCostRow(container, dateRow, locationRow);

  const targets = [
    { key: "event_date", value: extractValue(dateRow) },
    { key: "event_location", value: extractValue(locationRow) },
    { key: "event_cost", value: extractValue(costRow) },
  ];

  // --- BYTE-FAITHFUL string splice: wrap each value's UNIQUE occurrence ---
  let out = htmlString;
  let healed = false;
  for (const { key, value } of targets) {
    if (!value) continue;
    if (value.includes("<") || value.includes(">")) continue; // plain text only
    if (out.includes(`data-editable="${key}"`)) continue;     // idempotent
    if (countOccurrences(out, value) !== 1) continue;          // ambiguous → skip safely
    const wrapped = `<span data-editable="${key}">${value}</span>`;
    out = out.replace(value, () => wrapped); // fn replacement: no $-pattern surprises
    healed = true;
  }
  if (!healed) return { html: htmlString, healed: false, reason: "already-hooked" };

  // --- VALIDITY GUARD: we only ADDED balanced <span> pairs; verify + re-parse ---
  const addedOpen =
    (out.match(/<span\b/gi) || []).length - (htmlString.match(/<span\b/gi) || []).length;
  const addedClose =
    (out.match(/<\/span>/gi) || []).length - (htmlString.match(/<\/span>/gi) || []).length;
  if (addedOpen <= 0 || addedOpen !== addedClose) {
    return { html: htmlString, healed: false, reason: "validity-guard" };
  }
  try {
    const check = parser.parseFromString(out, "text/html");
    if (!check || !(check.body || check.documentElement)) {
      return { html: htmlString, healed: false, reason: "validity-guard" };
    }
  } catch (e) {
    return { html: htmlString, healed: false, reason: "validity-guard" };
  }

  return { html: out, healed: true, reason: "healed" };
}
