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

function variantClient() {
  const root = `${process.env.SUPABASE_URL}/rest/v1/`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return (path, opts = {}) => fetch(root + path, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...opts.headers },
  });
}
const failure = (status, error) => ({ status, body: { error } });
async function readRows(request, path) {
  const response = await request(path);
  if (!response.ok) throw new Error(`Variant operation query failed: ${path} (${response.status})`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error(`Invalid rows for ${path}`);
  return rows;
}

export async function duplicateVariant({ projectId, sourceVariantId, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), rng = Math.random }) {
  const request = variantClient();
  const project = encodeURIComponent(projectId);
  const sourceId = encodeURIComponent(sourceVariantId);
  try {
    const [source] = await readRows(request, `project_variants?id=eq.${sourceId}&select=*&limit=1`);
    if (!source) return failure(404, 'not_found');
    if (source.project_id !== projectId) return failure(403, 'wrong_project');
    if (!source.generated_html?.trim()) return failure(400, 'empty_source');
    const listPath = `project_variants?project_id=eq.${project}&select=variant_slug,variant_name`;
    let existing = await readRows(request, listPath);
    let variant;
    for (let attempt = 0; attempt < 10; attempt++) {
      const inserted = await request('project_variants', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          project_id: projectId,
          variant_slug: pickSlug(existing.map(v => v.variant_slug), { random: attempt > 0, rng }),
          variant_name: pickName(source, existing.map(v => v.variant_name)),
          generated_html: source.generated_html, status: 'draft', is_default: false,
        }),
      });
      const body = await inserted.json();
      if (inserted.ok) {
        if (!Array.isArray(body) || !body[0]?.id) throw new Error('Invalid inserted variant response');
        variant = body[0];
        break;
      }
      if (body?.code !== '23505') throw new Error(`Variant insert failed: ${JSON.stringify(body)}`);
      if (attempt === 9) return failure(409, 'slug_exhausted');
      existing = await readRows(request, listPath);
      await sleep(20 + rng() * 130);
    }

    try {
      const images = await readRows(request, `lp_image_content?variant_id=eq.${sourceId}&select=*`);
      if (images.length) {
        const response = await request('lp_image_content', {
          method: 'POST', body: JSON.stringify(images.map(({ slot, image_url, source, source_meta, enabled, display_size, display_shape }) => ({
            project_id: projectId, variant_id: variant.id, slot, image_url, source, source_meta, enabled, display_size, display_shape,
          }))),
        });
        if (!response.ok) throw new Error(`Image copy failed: ${response.status}`);
      }
      const content = await readRows(request, `lp_editable_content?variant_id=eq.${sourceId}&select=key,value`);
      if (content.length) {
        const response = await request('lp_editable_content', {
          method: 'POST', body: JSON.stringify(content.map(({ key, value }) => ({ project_id: projectId, variant_id: variant.id, key, value }))),
        });
        if (!response.ok) throw new Error(`Text copy failed: ${response.status}`);
      }
    } catch (err) {
      console.error('Variant child copy failed:', err);
      try {
        const rollback = await request(`project_variants?id=eq.${encodeURIComponent(variant.id)}`, { method: 'DELETE' });
        if (!rollback.ok) throw new Error(`Rollback status: ${rollback.status}`);
      } catch (rollbackError) {
        console.error(`Variant rollback failed; orphan variant id: ${variant.id}`, rollbackError);
      }
      return failure(500, 'copy_failed');
    }
    return { status: 200, body: { variant } };
  } catch (err) {
    console.error('duplicateVariant error:', err);
    return failure(500, 'server_error');
  }
}

export async function deleteDraftVariant({ projectId, variantId }) {
  const request = variantClient();
  const id = encodeURIComponent(variantId);
  try {
    const [variant] = await readRows(request, `project_variants?id=eq.${id}&select=id,project_id,status,is_default&limit=1`);
    if (!variant) return failure(404, 'not_found');
    if (variant.project_id !== projectId) return failure(403, 'wrong_project');
    if (variant.is_default) return failure(409, 'is_default');
    if (variant.status !== 'draft') return failure(409, 'not_draft');
    for (const table of ['leads', 'analytics_events', 'test_variants']) {
      const rows = await readRows(request, `${table}?variant_id=eq.${id}&select=id&limit=1`);
      if (rows.length) return failure(409, 'has_data');
    }
    const response = await request(`project_variants?id=eq.${id}&project_id=eq.${encodeURIComponent(projectId)}&status=eq.draft&is_default=eq.false`, {
      method: 'DELETE', headers: { Prefer: 'return=representation' },
    });
    if (!response.ok) throw new Error(`Variant delete failed: ${response.status}`);
    const deleted = await response.json();
    if (!Array.isArray(deleted)) throw new Error('Invalid delete response');
    if (!deleted.length) return failure(409, 'not_draft');
    return { status: 200, body: { ok: true } };
  } catch (err) {
    console.error('deleteDraftVariant error:', err);
    return failure(500, 'server_error');
  }
}
