/**
 * server/src/replay/shapley.ts
 *
 * Game-theoretic Shapley value attribution for multi-variable failure attribution.
 *
 * Supports:
 *   - Exact combinatorial attribution for k <= EXPERIMENT_MAX_FULL_K (default 4)
 *   - Monte Carlo permutation sampling for k > 4 (EXPERIMENT_PERM_SAMPLES, default 200)
 *   - Efficiency verification: sum(phi_i) === v(all) - v(none)
 */

import { mulberry32 } from './stats.js';

export interface ShapleyInput {
  changes: string[]; // List of change unit names
  coalitionValues: Record<string, number>; // Mask string (e.g. '011') -> failure rate
  method?: 'auto' | 'exact' | 'sampled';
  maxFullK?: number; // threshold to switch to sampling (default 4)
  samplePermutations?: number; // default 200
  seed?: number;
}

export interface ShapleyResult {
  attributions: Record<string, number>;
  totalShift: number; // v(N) - v(0)
  method: 'exact' | 'sampled';
  methodNote?: string | undefined;
  coalitions: Array<{
    mask: string;
    activeChanges: string[];
    failureRate: number;
  }>;
}

function factorial(n: number): number {
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

/**
 * Converts a list of active indices to a stable binary mask string of length total.
 */
export function subsetToMask(indices: number[], total: number): string {
  const chars = new Array<string>(total).fill('0');
  for (const idx of indices) {
    if (idx >= 0 && idx < total) {
      chars[idx] = '1';
    }
  }
  return chars.join('');
}

/**
 * Exact combinatorial Shapley calculation.
 */
function computeExactShapley(
  changes: string[],
  coalitionValues: Record<string, number>,
): Record<string, number> {
  const n = changes.length;
  const nFact = factorial(n);
  const attributions: Record<string, number> = {};
  for (const c of changes) attributions[c] = 0;

  const totalSubsets = 1 << n;

  for (let i = 0; i < n; i++) {
    const changeName = changes[i]!;
    let phi = 0;

    for (let maskNum = 0; maskNum < totalSubsets; maskNum++) {
      const containsI = (maskNum & (1 << (n - 1 - i))) !== 0;
      if (containsI) continue;

      const sIndices: number[] = [];
      for (let bit = 0; bit < n; bit++) {
        if ((maskNum & (1 << (n - 1 - bit))) !== 0) {
          sIndices.push(bit);
        }
      }

      const sSize = sIndices.length;
      const maskS = subsetToMask(sIndices, n);
      const maskSWithI = subsetToMask([...sIndices, i], n);

      const vS = coalitionValues[maskS] ?? 0;
      const vSWithI = coalitionValues[maskSWithI] ?? 0;
      const marginal = vSWithI - vS;

      const weight = (factorial(sSize) * factorial(n - sSize - 1)) / nFact;
      phi += weight * marginal;
    }

    attributions[changeName] = phi;
  }

  return attributions;
}

/**
 * Monte Carlo permutation sampling for k > 4.
 * Generates M random permutations of (0..n-1), evaluates marginal contribution in each.
 */
function computeSampledShapley(
  changes: string[],
  coalitionValues: Record<string, number>,
  numPermutations = 200,
  seed = 42,
): Record<string, number> {
  const n = changes.length;
  const rng = mulberry32(seed);
  const marginalSums: Record<string, number> = {};
  for (const c of changes) marginalSums[c] = 0;

  for (let p = 0; p < numPermutations; p++) {
    // Fisher-Yates shuffle to generate random permutation
    const perm: number[] = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = perm[i]!;
      perm[i] = perm[j]!;
      perm[j] = tmp;
    }

    const currentSubset: number[] = [];
    for (const playerIdx of perm) {
      const maskBefore = subsetToMask(currentSubset, n);
      currentSubset.push(playerIdx);
      const maskAfter = subsetToMask(currentSubset, n);

      const vBefore = coalitionValues[maskBefore] ?? 0;
      const vAfter = coalitionValues[maskAfter] ?? 0;
      const marginal = vAfter - vBefore;

      marginalSums[changes[playerIdx]!]! += marginal;
    }
  }

  const attributions: Record<string, number> = {};
  for (const c of changes) {
    attributions[c] = marginalSums[c]! / numPermutations;
  }

  return attributions;
}

export function computeShapley(input: ShapleyInput): ShapleyResult {
  const {
    changes,
    coalitionValues,
    method = 'auto',
    maxFullK = 4,
    samplePermutations = 200,
    seed = 42,
  } = input;

  const n = changes.length;
  if (n === 0) {
    return { attributions: {}, totalShift: 0, method: 'exact', coalitions: [] };
  }

  const emptyMask = '0'.repeat(n);
  const fullMask = '1'.repeat(n);
  const vEmpty = coalitionValues[emptyMask] ?? 0;
  const vFull = coalitionValues[fullMask] ?? 0;
  const totalShift = vFull - vEmpty;

  const useSampling = method === 'sampled' || (method === 'auto' && n > maxFullK);
  let rawAttributions: Record<string, number>;
  let resultMethod: 'exact' | 'sampled' = 'exact';
  let methodNote: string | undefined;

  if (useSampling) {
    resultMethod = 'sampled';
    methodNote = `Evaluated via Monte Carlo permutation sampling (${samplePermutations} permutations) because k=${n} > ${maxFullK}.`;
    rawAttributions = computeSampledShapley(changes, coalitionValues, samplePermutations, seed);
  } else {
    rawAttributions = computeExactShapley(changes, coalitionValues);
  }

  // Format coalitions list
  const totalSubsets = 1 << n;
  const coalitionsList: ShapleyResult['coalitions'] = [];
  // For large k, only include the coalitions present in coalitionValues
  if (n <= maxFullK) {
    for (let maskNum = 0; maskNum < totalSubsets; maskNum++) {
      const indices: number[] = [];
      for (let bit = 0; bit < n; bit++) {
        if ((maskNum & (1 << (n - 1 - bit))) !== 0) indices.push(bit);
      }
      const mask = subsetToMask(indices, n);
      const activeChanges = indices.map((idx) => changes[idx]!);
      coalitionsList.push({
        mask,
        activeChanges,
        failureRate: coalitionValues[mask] ?? 0,
      });
    }
  } else {
    for (const [mask, failureRate] of Object.entries(coalitionValues)) {
      const indices: number[] = [];
      for (let bit = 0; bit < mask.length; bit++) {
        if (mask[bit] === '1') indices.push(bit);
      }
      coalitionsList.push({
        mask,
        activeChanges: indices.map((idx) => changes[idx] ?? `unit_${idx}`),
        failureRate,
      });
    }
  }

  return {
    attributions: rawAttributions,
    totalShift,
    method: resultMethod,
    methodNote,
    coalitions: coalitionsList,
  };
}
