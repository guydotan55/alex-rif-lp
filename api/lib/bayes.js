// api/lib/bayes.js
// Pure statistical helpers for the test planner. No I/O.

// Inverse standard normal CDF (Beasley-Springer-Moro approximation).
// Accurate to ~1e-9 for p ∈ (0, 1). Good enough for sample-size math.
function quantileNormal(p) {
  if (p <= 0 || p >= 1) throw new Error('quantileNormal requires 0 < p < 1');
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
              1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
              6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5]) /
           ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5; r = q*q;
    return (((((a[0]*r + a[1])*r + a[2])*r + a[3])*r + a[4])*r + a[5])*q /
           (((((b[0]*r + b[1])*r + b[2])*r + b[3])*r + b[4])*r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5]) /
          ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1);
}

/**
 * Required sample size per variant for a two-proportion z-test.
 * @param {number} baselineCr - baseline conversion rate (0..1)
 * @param {number} mde - relative minimum detectable effect (0.20 = +20%)
 * @param {number} numVariants - total variants including control (>=2)
 * @returns {number} sample size per variant (ceiling)
 */
export function sampleSizePerVariant(baselineCr, mde, numVariants = 2) {
  if (baselineCr <= 0 || baselineCr >= 1) throw new Error('baselineCr must be 0..1');
  if (mde <= 0) throw new Error('mde must be > 0');
  if (numVariants < 2) throw new Error('numVariants must be >= 2');

  const k = numVariants - 1;
  const alpha = k > 1 ? 0.05 / k : 0.05;       // Bonferroni for 3+ variants
  const power = 0.80;
  const z_a = quantileNormal(1 - alpha / 2);
  const z_b = quantileNormal(power);

  const p1 = baselineCr;
  const p2 = baselineCr * (1 + mde);
  if (p2 >= 1) throw new Error('mde would push baselineCr above 100%');
  const pBar = (p1 + p2) / 2;

  const num = Math.pow(
    z_a * Math.sqrt(2 * pBar * (1 - pBar)) +
    z_b * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)),
    2
  );
  return Math.ceil(num / Math.pow(p2 - p1, 2));
}

/**
 * Sample n draws from a Beta(alpha, beta) distribution using the
 * gamma-ratio identity: X ~ Gamma(alpha,1), Y ~ Gamma(beta,1) → X/(X+Y) ~ Beta(alpha,beta).
 * Uses Marsaglia-Tsang rejection sampling for Gamma; works for shape >= 1
 * (boost via shape+1, scale by U^(1/shape) when shape < 1).
 */
export function sampleBeta(alpha, beta, n) {
  if (alpha <= 0 || beta <= 0) throw new Error('alpha and beta must be > 0');
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = sampleGamma(alpha);
    const y = sampleGamma(beta);
    out[i] = x / (x + y);
  }
  return out;
}

function sampleGamma(shape) {
  // Marsaglia & Tsang (2000), with shape-boost for shape < 1.
  if (shape < 1) {
    const u = Math.random();
    return sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = sampleNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleNormal() {
  // Box-Muller
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
