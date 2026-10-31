/**
 * server/src/replay/units.test.ts
 */

import { describe, it, expect } from 'vitest';
import { extractUnits, applyUnits } from './units.js';
import type { ContextData } from '../contexts/hash.js';

describe('Replay units extraction and application', () => {
  const baseline: ContextData = {
    model: 'v1',
    promptText: 'Line 1\nLine 2',
    config: { chunkSize: 512, temperature: 0.5 },
    toolSchemas: { toolA: { type: 'function' } },
    deps: { libX: '1.0' },
  };

  const bad: ContextData = {
    model: 'v2',
    promptText: 'Line 1 changed\nLine 2',
    config: { chunkSize: 256, temperature: 0.5 },
    toolSchemas: { toolA: { type: 'function' }, toolB: { type: 'function' } },
    deps: { libX: '2.0' },
  };

  it('extracts change units generically from context diff', () => {
    const units = extractUnits(baseline, bad);
    expect(units).toEqual([
      'config.chunkSize',
      'dep.libX',
      'model',
      'prompt',
      'toolSchema.toolB',
    ]);
  });

  it('applyUnits with empty set returns identical copy of baseline', () => {
    const res = applyUnits(baseline, bad, []);
    expect(res.model).toBe('v1');
    expect(res.promptText).toBe('Line 1\nLine 2');
    expect(res.config?.['chunkSize']).toBe(512);
    expect(res.deps?.['libX']).toBe('1.0');
    expect(res.toolSchemas?.['toolB']).toBeUndefined();
  });

  it('applyUnits applies only the selected units', () => {
    const res = applyUnits(baseline, bad, ['model', 'config.chunkSize']);
    expect(res.model).toBe('v2'); // changed
    expect(res.config?.['chunkSize']).toBe(256); // changed
    expect(res.promptText).toBe('Line 1\nLine 2'); // baseline preserved
    expect(res.deps?.['libX']).toBe('1.0'); // baseline preserved
  });

  it('applyUnits with all units produces exact bad context', () => {
    const units = extractUnits(baseline, bad);
    const res = applyUnits(baseline, bad, units);
    expect(res.model).toBe('v2');
    expect(res.promptText).toBe('Line 1 changed\nLine 2');
    expect(res.config?.['chunkSize']).toBe(256);
    expect(res.deps?.['libX']).toBe('2.0');
    expect(res.toolSchemas?.['toolB']).toBeDefined();
  });
});

