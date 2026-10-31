/**
 * server/src/embed/provider.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  NoneEmbeddingProvider,
  verifyEmbeddingDimension,
  EmbeddingDimensionMismatchError,
  type EmbeddingProvider,
} from './provider.js';

describe('Embedding Provider & Dimension Verification', () => {
  it('NoneEmbeddingProvider returns empty vectors and preserves text_only mode', async () => {
    const provider = new NoneEmbeddingProvider(1024);
    expect(provider.name).toBe('none');
    expect(provider.dim).toBe(1024);

    const embeddings = await provider.embed(['hello', 'world']);
    expect(embeddings.length).toBe(2);
    expect(embeddings[0]).toEqual([]);
    expect(embeddings[1]).toEqual([]);

    // None provider verification is a no-op
    await expect(verifyEmbeddingDimension(provider)).resolves.not.toThrow();
  });

  it('(a) EMBED_DIM mismatch fails startup with a readable message', async () => {
    // Fake provider configured for dim 1024, but returning 512-dim vectors
    const fakeMismatchedProvider: EmbeddingProvider = {
      name: 'voyage',
      model: 'voyage-3-lite',
      dim: 1024,
      async embed() {
        return [new Array(512).fill(0.1)];
      },
    };

    await expect(verifyEmbeddingDimension(fakeMismatchedProvider)).rejects.toThrowError(
      EmbeddingDimensionMismatchError,
    );

    try {
      await verifyEmbeddingDimension(fakeMismatchedProvider);
    } catch (err: any) {
      expect(err.message).toContain('Embedding dimension mismatch for provider "voyage"');
      expect(err.message).toContain('expected 1024, got 512');
    }
  });

  it('passes verification when actual vector length matches configured dim', async () => {
    const fakeValidProvider: EmbeddingProvider = {
      name: 'voyage',
      model: 'voyage-3-lite',
      dim: 1024,
      async embed() {
        return [new Array(1024).fill(0.05)];
      },
    };

    await expect(verifyEmbeddingDimension(fakeValidProvider)).resolves.not.toThrow();
  });
});

