/**
 * server/src/embed/index.ts
 */

import { config } from '../config.js';
import {
  type EmbeddingProvider,
  AtlasVoyageEmbeddingProvider,
  OllamaEmbeddingProvider,
  NoneEmbeddingProvider,
} from './provider.js';

let providerInstance: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (providerInstance) return providerInstance;

  if (config.EMBED_PROVIDER === 'atlas_voyage' || config.EMBED_PROVIDER === 'voyage') {
    if (!config.EMBED_API_KEY) {
      console.warn(
        '[Waypoint] Warning: EMBED_API_KEY not configured. Falling back to NoneEmbeddingProvider (text_only recall).',
      );
      providerInstance = new NoneEmbeddingProvider(config.EMBED_DIM || 1024);
      return providerInstance;
    }
    providerInstance = new AtlasVoyageEmbeddingProvider({
      apiKey: config.EMBED_API_KEY,
      model: config.EMBED_MODEL || 'voyage-4',
      dim: config.EMBED_DIM || 1024,
      baseUrl: config.EMBED_BASE_URL || 'https://ai.mongodb.com/v1',
    });
  } else if (config.EMBED_PROVIDER === 'ollama') {
    providerInstance = new OllamaEmbeddingProvider({
      baseUrl: config.EMBED_BASE_URL || 'http://localhost:11434',
      model: config.EMBED_MODEL || 'nomic-embed-text',
      dim: config.EMBED_DIM || 768,
    });
  } else {
    providerInstance = new NoneEmbeddingProvider(config.EMBED_DIM || 1024);
  }

  return providerInstance;
}

export function setEmbeddingProviderForTest(provider: EmbeddingProvider | null): void {
  providerInstance = provider;
}
