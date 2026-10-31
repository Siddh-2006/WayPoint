/**
 * server/src/embed/cache.ts
 *
 * In-memory Least-Recently-Used (LRU) cache for query vector embeddings.
 * Eliminates redundant remote embedding calls, protecting against trial-tier
 * rate limits (3 RPM / 10K TPM on MongoDB Atlas Voyage API).
 */

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  maxSize: number;
}

export class QueryEmbeddingLruCache {
  private readonly capacity: number;
  private readonly cache = new Map<string, number[]>();
  private hits = 0;
  private misses = 0;

  constructor(capacity = 256) {
    this.capacity = capacity > 0 ? capacity : 256;
  }

  private makeKey(model: string, query: string): string {
    return `${model}:${query.trim()}`;
  }

  get(model: string, query: string): number[] | undefined {
    const key = this.makeKey(model, query);
    const val = this.cache.get(key);
    if (val !== undefined) {
      this.hits++;
      // Refresh key for LRU ordering
      this.cache.delete(key);
      this.cache.set(key, val);
      return val;
    }
    this.misses++;
    return undefined;
  }

  set(model: string, query: string, vector: number[]): void {
    if (!query || vector.length === 0) return;
    const key = this.makeKey(model, query);
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Evict oldest (first) item
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, vector);
  }

  has(model: string, query: string): boolean {
    return this.cache.has(this.makeKey(model, query));
  }

  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      maxSize: this.capacity,
    };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

let globalCache: QueryEmbeddingLruCache | null = null;

export function getQueryEmbeddingCache(capacity = 256): QueryEmbeddingLruCache {
  if (!globalCache) {
    globalCache = new QueryEmbeddingLruCache(capacity);
  }
  return globalCache;
}

