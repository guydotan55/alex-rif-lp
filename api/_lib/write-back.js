// Pure guard logic for the one-time healed-HTML write-back folded into
// api/save-content.js (Task 5). Kept here so it is unit-testable without network.

/**
 * Is this POST body a write-back request? True only when BOTH variant_id and a
 * non-empty healed_html are present. (An empty healed_html must never blank out
 * the stored generated_html.)
 */
export function isWriteBackRequest(body) {
  if (!body) return false;
  return (
    typeof body.variant_id === "string" &&
    body.variant_id.length > 0 &&
    typeof body.healed_html === "string" &&
    body.healed_html.length > 0
  );
}

/**
 * Should we PATCH project_variants.generated_html?
 * No-op (false) when the healed HTML is empty/nullish or byte-equal to what is
 * already stored. True only when there is a real, different value to persist.
 */
export function shouldWriteBack(storedHtml, healedHtml) {
  if (typeof healedHtml !== "string" || healedHtml.length === 0) return false;
  return healedHtml !== storedHtml;
}
