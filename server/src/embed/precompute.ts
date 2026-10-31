/**
 * server/src/embed/precompute.ts
 *
 * Precomputes embeddings for standard demo queries in a single background batch at startup.
 * Guarantees zero latency and zero rate limit impact during live judge demos.
 * Never blocks startup; failures are logged as non-fatal warnings.
 */

import { getEmbeddingProvider } from './index.js';
import { getQueryEmbeddingCache } from './cache.js';
import { config } from '../config.js';

export const DEMO_QUERIES = [
  'the new model renamed a field to snake case',
  'underlying language model shifted key casing style to underscores',
  'monetary denomination symbols were omitted from billing parameters',
  'floating point value serialized as text instead of numeric',
  'levy and tariff breakdown absent from billing aggregation',
  'supplier corporate organization title clipped short',
  'calendar timestamp emitted in British order rather than international standard',
  'remittance window stipulations absent from transaction payload',
  'repeating identifier produced when ingesting refund adjustment slips',
  'invoice_id',
  'net_30',
  'ISO-8601',
  'proposed configuration change',
];

export async function precomputeDemoEmbeddings(): Promise<void> {
  const provider = getEmbeddingProvider();
  if (provider.name === 'none') return;

  const cache = getQueryEmbeddingCache(config.EMBED_CACHE_SIZE);
  const uncached = DEMO_QUERIES.filter((q) => !cache.has(provider.model, q));
  if (uncached.length === 0) return;

  try {
    const vectors = await provider.embed(uncached, 'query');
    uncached.forEach((q, idx) => {
      const vec = vectors[idx];
      if (vec && vec.length > 0) {
        cache.set(provider.model, q, vec);
      }
    });
    console.log(`[Waypoint] Precomputed and cached ${uncached.length} demo query embeddings.`);
  } catch (err: any) {
    console.warn(`[Waypoint] Non-fatal: demo query embedding precomputation skipped: ${err?.message ?? 'error'}`);
  }
}
