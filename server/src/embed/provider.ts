/**
 * server/src/embed/provider.ts
 *
 * Pluggable embedding provider supporting:
 *   - 'voyage': Official Voyage AI Embeddings API (https://api.voyageai.com/v1/embeddings)
 *   - 'ollama': Local Ollama embedding endpoint
 *   - 'none':   Text-only mode; returns zero-vectors or bypasses embedding
 *
 * Implements 10s timeouts, 3x exponential backoff, batching up to 128 items,
 * and startup dimension validation.
 */

export type EmbeddingInputType = 'document' | 'query';

export interface EmbeddingProvider {
  readonly name: 'voyage' | 'ollama' | 'none';
  readonly dim: number;
  embed(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]>;
}

export interface VoyageConfig {
  apiKey: string;
  model: string;
  dim: number;
  baseUrl?: string;
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
 * NoneProvider: returns zero-length vectors; signals text-only recall mode.
 */
export class NoneEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none' as const;
  constructor(readonly dim: number = 1024) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}

/**
 * Voyage AI Provider: calls official https://api.voyageai.com/v1/embeddings
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage' as const;
  readonly dim: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(cfg: VoyageConfig) {
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.dim = cfg.dim;
    this.baseUrl = (cfg.baseUrl || 'https://api.voyageai.com/v1').replace(/\/$/, '');
  }

  async embed(texts: string[], inputType: EmbeddingInputType = 'document'): Promise<number[][]> {
    if (texts.length === 0) return [];

    const BATCH_SIZE = 128;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const batchEmbeddings = await this.embedBatchWithRetry(batch, inputType);
      allEmbeddings.push(...batchEmbeddings);
    }

    return allEmbeddings;
  }

  private async embedBatchWithRetry(
    batch: string[],
    inputType: EmbeddingInputType,
    maxRetries = 3,
  ): Promise<number[][]> {
    let lastErr: Error | null = null;
    let delayMs = 500;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000); // 10s timeout

      try {
        const res = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            input: batch,
            model: this.model,
            input_type: inputType,
          }),
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          const status = res.status;
          const errBody = await res.text().catch(() => '');
          if ((status === 429 || status >= 500) && attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, delayMs));
            delayMs *= 2;
            continue;
          }
          throw new Error(`Voyage API HTTP ${status}: ${errBody}`);
        }

        const data = (await res.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        const sorted = data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
        return sorted;
      } catch (err) {
        clearTimeout(timeoutId);
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs *= 2;
        }
      }
    }

    throw lastErr ?? new Error('Voyage embedding request failed after retries');
  }
}

/**
 * Ollama Provider: calls local Ollama endpoint.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama' as const;
  readonly dim: number;
  private readonly model: string;
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

