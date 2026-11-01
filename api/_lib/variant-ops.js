// Helpers for variant operations; this directory does not create Vercel functions.
export function pickSlug(existingSlugs, { random = false, rng = Math.random } = {}) {
  const taken = new Set(existingSlugs);
  let free = [...'abcdefghijklmnopqrstuvwxyz'].filter(slug => !taken.has(slug));
  if (!free.length) {
    for (let n = 1; free.length < (random ? 20 : 1); n++) {
      if (!taken.has(`v${n}`)) free.push(`v${n}`);
    }
  }
  return free[random ? Math.floor(rng() * free.length) : 0];
}

export function pickName(source, existingNames) {
  const base = source.is_default && (!source.variant_name || source.variant_name === 'Default')
    ? 'הדף הראשי' : source.variant_name || source.variant_slug;
  const taken = new Set(existingNames);
  for (let n = 1; ; n++) {
    const suffix = ` – עותק${n === 1 ? '' : ` ${n}`}`;
    const candidate = base.slice(0, 40 - suffix.length).trimEnd() + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
