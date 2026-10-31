/**
 * server/src/embed/index.ts
 */

import { config } from '../config.js';
import {
  type EmbeddingProvider,
  VoyageEmbeddingProvider,
  MongoSemanticEmbeddingProvider,
  OllamaEmbeddingProvider,
  NoneEmbeddingProvider,
} from './provider.js';

let providerInstance: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (providerInstance) return providerInstance;

  if (config.EMBED_PROVIDER === 'voyage') {
    if (config.EMBED_API_KEY) {
      providerInstance = new VoyageEmbeddingProvider({
        apiKey: config.EMBED_API_KEY,
        model: config.EMBED_MODEL || 'voyage-3-lite',
        dim: config.EMBED_DIM,
        baseUrl: config.EMBED_BASE_URL,
      });
    } else {
      // In-engine deterministic vector provider matching MongoDB Atlas 1024-dim index
      providerInstance = new MongoSemanticEmbeddingProvider(config.EMBED_DIM);
    }
  } else if (config.EMBED_PROVIDER === 'mongodb') {
    providerInstance = new MongoSemanticEmbeddingProvider(config.EMBED_DIM);
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
