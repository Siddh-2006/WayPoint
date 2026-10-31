/**
 * server/src/contexts/hash.test.ts
 *
 * Unit tests for canonicalize, hashContext, and diffContexts.
 */

import { describe, expect, it } from 'vitest';
import { canonicalize, hashContext } from './hash.js';
import { diffContexts } from './diff.js';

describe('canonicalize', () => {
  it('sorts keys recursively regardless of insertion order', () => {
    const obj1 = { b: 2, a: 1, nested: { z: 26, y: 25 } };
    const obj2 = { a: 1, nested: { y: 25, z: 26 }, b: 2 };
    expect(canonicalize(obj1)).toBe(canonicalize(obj2));
  });

  it('drops undefined values', () => {
    const obj1 = { a: 1, b: undefined };
    const obj2 = { a: 1 };
    expect(canonicalize(obj1)).toBe(canonicalize(obj2));
  });

  it('normalizes -0 to 0', () => {
    expect(canonicalize({ num: -0 })).toBe('{"num":0}');
  });
});

describe('hashContext', () => {
  it('gives identical hash when keys are in different order', () => {
    const ctx1 = {
      model: 'gpt-4',
      promptText: 'Hello world',
      config: { temp: 0.7, topP: 1.0 },
    };
    const ctx2 = {
      config: { topP: 1.0, temp: 0.7 },
      promptText: 'Hello world',
      model: 'gpt-4',
    };
    expect(hashContext(ctx1)).toBe(hashContext(ctx2));
  });

  it('gives different hash on single-character prompt change', () => {
    const ctx1 = { model: 'gpt-4', promptText: 'Extract invoices.' };
    const ctx2 = { model: 'gpt-4', promptText: 'Extract invoices!' };
    expect(hashContext(ctx1)).not.toBe(hashContext(ctx2));
  });
});

describe('diffContexts', () => {
  it('correctly diffs planted change across model, prompt, and config', () => {
    const ctxA = {
      model: 'gpt-4',
      promptText: 'Line 1\nLine 2\nLine 3',
      config: { chunkSize: 512, cache: true },
    };
    const ctxB = {
      model: 'gpt-4o',
      promptText: 'Line 1\nLine 2 modified\nLine 3',
      config: { chunkSize: 256, cache: true },
    };

    const changes = diffContexts(ctxA, ctxB);
    expect(changes).toHaveLength(3);

    expect(changes[0]).toMatchObject({
      axis: 'model',
      path: 'model',
      before: 'gpt-4',
      after: 'gpt-4o',
    });

    expect(changes[1]).toMatchObject({
      axis: 'prompt',
      path: 'promptText',
    });

    expect(changes[2]).toMatchObject({
      axis: 'config',
      path: 'chunkSize',
      before: 512,
      after: 256,
    });
  });

  it('produces deterministic output across multiple invocations', () => {
    const ctxA = {
      model: 'v1',
      promptText: 'prompt a',
      config: { z: 1, a: 2, m: { nested: 1 } },
      deps: { pkgA: '1.0' },
    };
    const ctxB = {
      model: 'v2',
      promptText: 'prompt b',
      config: { z: 2, a: 3, m: { nested: 2 } },
      deps: { pkgA: '2.0' },
    };

    const first = JSON.stringify(diffContexts(ctxA, ctxB));
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(diffContexts(ctxA, ctxB))).toBe(first);
    }
  });
});

