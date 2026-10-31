/**
 * server/src/embed/provider.ts
 *
 * Pluggable embedding providers for Waypoint:
 *   - 'atlas_voyage' / 'voyage': Official MongoDB Atlas Embedding and Reranking API
 *     serving Voyage AI models (e.g. voyage-4, voyage-4-large, voyage-4-lite)
 *     via serverless endpoints at https://ai.mongodb.com/v1
 *   - 'ollama': Local Ollama dedicated embedding endpoint
 *   - 'none': Text-only fallback mode
 *
 * Implements 10s timeouts via AbortSignal, 3x exponential backoff on 429/5xx,
 * batching up to 128 items, strict key secrecy, and startup dimension validation.
 */

export type EmbeddingInputType = 'document' | 'query';

export interface EmbeddingProvider {
  readonly name: 'atlas_voyage' | 'voyage' | 'ollama' | 'none';
  readonly dim: number;
  readonly model: string;
  embed(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]>;
}

export interface AtlasVoyageConfig {
  apiKey: string;
  model: string;
  dim: number;
  baseUrl?: string | undefined;
  maxRpm?: number | undefined;
}

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  dim: number;
}

export class EmbeddingDimensionMismatchError extends Error {
  constructor(expected: number, actual: number, providerName: string) {
    super(
      `Embedding dimension mismatch for provider "${providerName}": expected ${expected}, got ${actual}. Check EMBED_DIM and EMBED_MODEL configuration.`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

/**
 * NoneEmbeddingProvider: returns empty vectors; signals text-only recall mode.
 */
export class NoneEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none' as const;
  readonly model = 'none';
  constructor(readonly dim: number = 1024) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}

/**
 * AtlasVoyageEmbeddingProvider:
 * Direct client for the official MongoDB Atlas Embedding and Reranking API (Voyage AI models).
 * Endpoint defaults to https://ai.mongodb.com/v1/embeddings.
 * Authenticated with MongoDB Atlas Voyage Model API Keys.
 */
export class AtlasVoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'atlas_voyage' as const;
  readonly dim: number;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRpm: number;
  private lastRequestTime = 0;
  private queuePromise: Promise<void> = Promise.resolve();

  constructor(cfg: AtlasVoyageConfig) {
    if (!cfg.apiKey) {
      throw new Error(
        'Atlas Voyage embedding provider requires an API key. Generate a Model API Key in MongoDB Atlas and set EMBED_API_KEY in .env.',
      );
    }
    this.apiKey = cfg.apiKey;
    this.model = cfg.model || 'voyage-4';
    this.dim = cfg.dim || 1024;
    this.maxRpm = cfg.maxRpm && cfg.maxRpm > 0 ? cfg.maxRpm : 3;
    let url = (cfg.baseUrl || 'https://ai.mongodb.com/v1').trim().replace(/\/+$/, '');
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }
    if (!url.endsWith('/v1')) {
      url = `${url}/v1`;
    }
    this.baseUrl = url;
  }

  private async waitForSlot(): Promise<void> {
    const minIntervalMs = Math.ceil(60_000 / this.maxRpm);
    const prev = this.queuePromise;
    let release: () => void = () => {};
    this.queuePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prev;
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < minIntervalMs && this.lastRequestTime > 0) {
      await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
    }
    this.lastRequestTime = Date.now();
    release();
  }

  async embed(texts: string[], inputType: EmbeddingInputType = 'document'): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batchSize = 128;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await this.embedBatch(batch, inputType);
      allEmbeddings.push(...batchResults);
    }

    if (allEmbeddings.length > 0) {
      const actualDim = allEmbeddings[0]?.length ?? 0;
      if (actualDim > 0 && actualDim !== this.dim) {
        throw new EmbeddingDimensionMismatchError(this.dim, actualDim, this.name);
      }
    }

    return allEmbeddings;
  }

  private sanitizeError(errMessage: string): string {
    // Redact any occurrence of the API key
    if (this.apiKey) {
      return errMessage.replaceAll(this.apiKey, '[REDACTED_API_KEY]');
    }
    return errMessage;
  }

  private async embedBatch(batch: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    const maxRetries = 3;
    let delayMs = 500;
    let lastErr: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await this.waitForSlot();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const payload: Record<string, unknown> = {
          input: batch,
          model: this.model,
          input_type: inputType,
          output_dimension: this.dim,
        };

        const res = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          const status = res.status;
          const rawErr = await res.text().catch(() => '');
          const safeErr = this.sanitizeError(rawErr);

          if ((status === 429 || status >= 500) && attempt < maxRetries) {
            const retryHeader = res.headers.get('retry-after');
            const waitTime = retryHeader
              ? parseInt(retryHeader, 10) * 1000
              : status === 429
                ? 25_000
                : delayMs;
            console.log(`[Voyage API] HTTP ${status} received. Backing off for ${Math.round(waitTime / 1000)}s (attempt ${attempt}/${maxRetries})...`);
            await new Promise((r) => setTimeout(r, waitTime));
            delayMs *= 2;
            continue;
          }
          throw new Error(`MongoDB Atlas Voyage API HTTP ${status}: ${safeErr}`);
        }

        const data = (await res.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        const sorted = data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
        return sorted;
      } catch (err) {
        clearTimeout(timeoutId);
        const rawMsg = err instanceof Error ? err.message : String(err);
        lastErr = new Error(this.sanitizeError(rawMsg));
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs *= 2;
        }
      }
    }

    throw lastErr ?? new Error('Atlas Voyage embedding request failed after retries');
  }
}

/**
 * Backward compatibility alias for AtlasVoyageEmbeddingProvider
 */
export const VoyageEmbeddingProvider = AtlasVoyageEmbeddingProvider;

/**
 * OllamaEmbeddingProvider: calls local Ollama endpoint for embeddings.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama' as const;
  readonly dim: number;
  readonly model: string;
  private readonly baseUrl: string;

  constructor(cfg: OllamaConfig) {
    this.model = cfg.model;
    this.dim = cfg.dim;
    this.baseUrl = (cfg.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];
    for (const text of texts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const res = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text }),
        });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
        const data = (await res.json()) as { embedding: number[] };
        results.push(data.embedding);
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    }

    if (results.length > 0) {
      const actualDim = results[0]?.length ?? 0;
      if (actualDim > 0 && actualDim !== this.dim) {
        throw new EmbeddingDimensionMismatchError(this.dim, actualDim, this.name);
      }
    }

    return results;
  }
}

/**
 * Validates provider dimension at startup by running a test embed on 1 token.
 * Throws EmbeddingDimensionMismatchError if actual != expected.
 */
export async function verifyEmbeddingDimension(provider: EmbeddingProvider): Promise<void> {
  if (provider.name === 'none') return;

  const sample = await provider.embed(['test'], 'query');
  const actualDim = sample[0]?.length ?? 0;

  if (actualDim !== provider.dim) {
    throw new EmbeddingDimensionMismatchError(provider.dim, actualDim, provider.name);
  }
}
