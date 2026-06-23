// Strip prompt-injection vectors while PRESERVING Hebrew. We remove only the
// dangerous formatting controls, expressed as explicit code points so the
// ranges stay reviewable:
//   U+202A–U+202E  bidi embedding / override (LRE RLE PDF LRO RLO)
//   U+2066–U+2069  bidi isolates (LRI RLI FSI PDI)
//   U+200B–U+200D  zero-width space / non-joiner / joiner
//   U+FEFF         BOM / zero-width no-break space
// We deliberately KEEP RLM (U+200F) and LRM (U+200E) — legitimate Hebrew/RTL
// text uses them, and they fall outside the ranges above by design.
// Ported from the sister repo (whatsapp-survey) for the LP-generator stack.
const DANGEROUS_CONTROLS = /[‪-‮⁦-⁩​-‍﻿]/g;
const HTML_COMMENTS = /<!--[\s\S]*?-->/g;

export function sanitizeUntrusted(input) {
  if (!input) return '';
  return String(input).replace(HTML_COMMENTS, '').replace(DANGEROUS_CONTROLS, '');
}
