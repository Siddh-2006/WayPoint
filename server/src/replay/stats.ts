/**
 * server/src/replay/stats.ts
 *
 * Honest statistical metrics for replay experiments:
 *   - Wilson score 95% confidence intervals for binomial proportions
 *   - Cell verdict determination: 'failing' | 'ok' | 'inconclusive'
 *   - Seeded bootstrap confidence intervals for Shapley attributions
 *   - Pairwise interaction effect: v(AB) - v(A) - v(B) + v(0)
 */

export interface WilsonInterval {
  lower: number;
  upper: number;
  estimate: number;
}

/**
 * Wilson score interval with continuity correction option (standard z = 1.95996 for 95% CI).
 */
export function wilsonScoreInterval(
  successes: number,
  total: number,
  z = 1.95996,
): WilsonInterval {
  if (total <= 0) {
    return { lower: 0, upper: 1, estimate: 0 };
  }

  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const factor = (p * (1 - p)) / total + z2 / (4 * total * total);
  const spread = z * Math.sqrt(Math.max(0, factor));

  const lower = Math.max(0, (center - spread) / denominator);
  const upper = Math.min(1, (center + spread) / denominator);

  return {
    lower: Math.round(lower * 10000) / 10000,
    upper: Math.round(upper * 10000) / 10000,
    estimate: Math.round(p * 10000) / 10000,
  };
}

export type CellVerdict = 'failing' | 'ok' | 'inconclusive';

/**
 * Evaluates honest verdict against baseline cell:
 *   - failing: if lower bound > baseline upper bound
 *   - ok: if upper bound <= baseline upper bound + epsilon
 *   - inconclusive: otherwise
 */
export function determineVerdict(
  cellInterval: WilsonInterval,
  baselineInterval: WilsonInterval,
  epsilon = 0.05,
): CellVerdict {
  if (cellInterval.lower > baselineInterval.upper) {
    return 'failing';
  }
  if (cellInterval.upper <= baselineInterval.upper + epsilon) {
    return 'ok';
  }
  return 'inconclusive';
}

/**
 * Deterministic mulberry32 PRNG for reproducible bootstrap sampling.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resamples input outcomes to generate 95% bootstrap confidence intervals for Shapley values.
 */
export function bootstrapShapleyIntervals(
  inputOutcomes: Array<Record<string, number>>, // outcome per input per mask
  units: string[],
  shapleyComputer: (coalitionValues: Record<string, number>) => Record<string, number>,
  numDraws = 200,
  seed = 42,
): Record<string, { lower: number; upper: number }> {
  const nInputs = inputOutcomes.length;
  if (nInputs === 0) {
    const res: Record<string, { lower: number; upper: number }> = {};
    for (const u of units) res[u] = { lower: 0, upper: 0 };
    return res;
  }

  const rng = mulberry32(seed);
  const allShapleyDraws: Record<string, number[]> = {};
  for (const u of units) {
    allShapleyDraws[u] = [];
  }

  for (let draw = 0; draw < numDraws; draw++) {
    // Resample inputs with replacement
    const totalsPerMask: Record<string, number> = {};
    for (let i = 0; i < nInputs; i++) {
      const idx = Math.floor(rng() * nInputs);
      const chosen = inputOutcomes[idx]!;
      for (const [mask, val] of Object.entries(chosen)) {
        totalsPerMask[mask] = (totalsPerMask[mask] ?? 0) + val;
      }
    }

    // Average rates for this bootstrap sample
    const sampleCoalitions: Record<string, number> = {};
    for (const [mask, sum] of Object.entries(totalsPerMask)) {
      sampleCoalitions[mask] = sum / nInputs;
    }

    const drawShapley = shapleyComputer(sampleCoalitions);
    for (const u of units) {
      allShapleyDraws[u]!.push(drawShapley[u] ?? 0);
    }
  }

  const result: Record<string, { lower: number; upper: number }> = {};
  for (const u of units) {
    const draws = allShapleyDraws[u]!.sort((a, b) => a - b);
    const lowIdx = Math.floor(0.025 * draws.length);
    const highIdx = Math.min(draws.length - 1, Math.floor(0.975 * draws.length));
    result[u] = {
      lower: Math.round((draws[lowIdx] ?? 0) * 10000) / 10000,
      upper: Math.round((draws[highIdx] ?? 0) * 10000) / 10000,
    };
  }

  return result;
}

/**
 * Calculates pairwise interaction: v(AB) - v(A) - v(B) + v(0)
 */
export function calculatePairwiseInteraction(
  vAB: number,
  vA: number,
  vB: number,
  v0 = 0,
): number {
  const inter = vAB - vA - vB + v0;
  return Math.round(inter * 10000) / 10000;
}

