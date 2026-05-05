// api/lib/economic-verdict.js
// Pure verdict engine: given CR leader + variant spend/leads + target_cpl → economic verdict.
// No I/O. Designed to run from cron worker AND email handler.

const SPEND_FLOOR_MULTIPLIER = 3;
const STALE_HARD_HIDE_DAYS   = 14;
const STALE_AMBER_DAYS       = 7;

export const ECONOMIC_VERDICT_CONSTANTS = {
  SPEND_FLOOR_MULTIPLIER, STALE_HARD_HIDE_DAYS, STALE_AMBER_DAYS,
};

export function computeEconomicVerdict({
  cr_leader_variant_id, variants, target_cpl, now = Date.now(),
}) {
  if (!target_cpl || target_cpl <= 0) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'no_target_cpl' };
  }

  const enriched = variants.map(v => ({
    variant_id: v.variant_id,
    cpl: (v.leads > 0 && v.spend != null) ? v.spend / v.leads : null,
    spend: v.spend ?? 0,
    spend_age_days: v.spend_updated_at
      ? Math.floor((now - new Date(v.spend_updated_at).getTime()) / 86400e3)
      : Infinity,
  }));

  const oldest_spend_age_days = Math.max(...enriched.map(e => e.spend_age_days));

  if (oldest_spend_age_days > STALE_HARD_HIDE_DAYS) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'stale_spend', oldest_spend_age_days };
  }

  const spend_floor = SPEND_FLOOR_MULTIPLIER * target_cpl;
  if (enriched.some(e => e.spend < spend_floor)) {
    return { verdict: 'INSUFFICIENT_SPEND', reason: 'below_floor', spend_floor, oldest_spend_age_days };
  }

  const cr_leader = enriched.find(e => e.variant_id === cr_leader_variant_id);
  if (!cr_leader || cr_leader.cpl == null) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'no_leader_cpl' };
  }

  if (cr_leader.cpl <= target_cpl) {
    return { verdict: 'VIABLE', cr_leader_cpl: cr_leader.cpl, target_cpl, oldest_spend_age_days };
  }

  const cpl_sorted = [...enriched].sort((a, b) => (a.cpl ?? Infinity) - (b.cpl ?? Infinity));
  const cpl_leader = cpl_sorted[0];
  if (cpl_leader && cpl_leader.variant_id !== cr_leader_variant_id && cpl_leader.cpl < cr_leader.cpl) {
    return {
      verdict: 'WINNER_BUT_CHEAPER_ELSEWHERE',
      cr_leader_cpl: cr_leader.cpl,
      cpl_leader_variant_id: cpl_leader.variant_id,
      cpl_leader_cpl: cpl_leader.cpl,
      target_cpl, gap: cr_leader.cpl - target_cpl, oldest_spend_age_days,
    };
  }

  return {
    verdict: 'NOT_VIABLE',
    cr_leader_cpl: cr_leader.cpl, target_cpl,
    gap: cr_leader.cpl - target_cpl, oldest_spend_age_days,
  };
}
