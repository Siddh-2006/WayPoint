/**
 * server/src/embed/index.ts
 */

import { config } from '../config.js';
import {
  type EmbeddingProvider,
  VoyageEmbeddingProvider,
  OllamaEmbeddingProvider,
  NoneEmbeddingProvider,
} from './provider.js';

let providerInstance: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (providerInstance) return providerInstance;

  if (config.EMBED_PROVIDER === 'voyage') {
    if (!config.EMBED_API_KEY) {
      throw new Error('EMBED_API_KEY is required when EMBED_PROVIDER is "voyage"');
    }
    providerInstance = new VoyageEmbeddingProvider({
      apiKey: config.EMBED_API_KEY,
      model: config.EMBED_MODEL || 'voyage-3-lite',
      dim: config.EMBED_DIM,
      baseUrl: config.EMBED_BASE_URL,
    });
  } else if (config.EMBED_PROVIDER === 'ollama') {
    providerInstance = new OllamaEmbeddingProvider({
      baseUrl: config.EMBED_BASE_URL || 'http://localhost:11434',
      model: config.EMBED_MODEL || 'nomic-embed-text',
      dim: config.EMBED_DIM,
    });
  } else {
    providerInstance = new NoneEmbeddingProvider(config.EMBED_DIM);
  }

  return providerInstance;
}

export function setEmbeddingProviderForTesting(provider: EmbeddingProvider | null): void {
  providerInstance = provider;
}

