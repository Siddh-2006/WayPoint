/**
 * server/src/replay/shapley.test.ts
 */

import { describe, it, expect } from 'vitest';
import { computeShapley, subsetToMask } from './shapley.js';
import { mulberry32 } from './stats.js';

describe('Shapley attribution tests', () => {
  it('(a) Shapley efficiency: sum(phi) == v(all) - v(none) within 1e-9 on 100 random synthetic value functions', () => {
    const rng = mulberry32(12345);

    for (let iter = 0; iter < 100; iter++) {
      // Test random k in [1..4]
      const k = 1 + Math.floor(rng() * 4);
      const changes = Array.from({ length: k }, (_, i) => `u${i}`);
      const coalitionValues: Record<string, number> = {};

      const totalSubsets = 1 << k;
      for (let m = 0; m < totalSubsets; m++) {
        const mask = subsetToMask(
          Array.from({ length: k }, (_, i) => i).filter((i) => (m & (1 << (k - 1 - i))) !== 0),
          k,
        );
        // Random value in [0, 1]
        coalitionValues[mask] = rng();
      }

      const allMask = '1'.repeat(k);
      const emptyMask = '0'.repeat(k);
      const expectedShift = coalitionValues[allMask]! - coalitionValues[emptyMask]!;

      // Use raw exact values to test math precision
      const result = computeShapley({
        changes,
        coalitionValues,
        method: 'exact',
      });

      const phiSum = Object.values(result.attributions).reduce((acc, v) => acc + v, 0);

      // Core math asserts efficiency within 1e-9 literally
      expect(Math.abs(phiSum - expectedShift)).toBeLessThan(1e-9);
    }
  });

  it('verifies exact efficiency on synthetic 3-player game', () => {
    const changes = ['A', 'B', 'C'];
    const coalitionValues = {
      '000': 0.1,
      '100': 0.3,
      '010': 0.2,
      '001': 0.4,
      '110': 0.7,
      '101': 0.6,
      '011': 0.5,
      '111': 0.95,
    };
    const res = computeShapley({ changes, coalitionValues, method: 'exact' });
    const sum = Object.values(res.attributions).reduce((a, b) => a + b, 0);
    const expected = 0.95 - 0.1;
    expect(Math.abs(sum - expected)).toBeLessThan(1e-4);
  });

  it('(g) k = 6 synthetic: method sampled, phi estimates within 0.1 of exact answer', () => {
    const k = 6;
    const changes = Array.from({ length: k }, (_, i) => `c${i}`);
    const coalitionValues: Record<string, number> = {};

    // Synthetic additive + 1 interaction
    const totalSubsets = 1 << k;
    for (let m = 0; m < totalSubsets; m++) {
      const active: number[] = [];
      for (let bit = 0; bit < k; bit++) {
        if ((m & (1 << (k - 1 - bit))) !== 0) active.push(bit);
      }
      const mask = subsetToMask(active, k);
      let val = active.length * 0.1;
      // Pair interaction between c0 and c1
      if (active.includes(0) && active.includes(1)) {
        val += 0.3;
      }
      coalitionValues[mask] = val;
    }

    const exactRes = computeShapley({
      changes,
      coalitionValues,
      method: 'exact',
    });

    const sampledRes = computeShapley({
      changes,
      coalitionValues,
      method: 'sampled',
      samplePermutations: 300,
      seed: 999,
    });

    expect(sampledRes.method).toBe('sampled');
    expect(sampledRes.methodNote).toBeDefined();

    for (const c of changes) {
      const exactVal = exactRes.attributions[c]!;
      const sampledVal = sampledRes.attributions[c]!;
      expect(Math.abs(exactVal - sampledVal)).toBeLessThan(0.1);
    }
  });
});
