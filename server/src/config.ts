/**
 * server/src/config.ts
 *
 * Single source of truth for all environment-specific configuration.
 * Parsed and validated once at startup using Zod.
 * Fails fast with a human-readable message listing every invalid / missing var.
 */

import { z } from 'zod';

// ─── Schema ───────────────────────────────────────────────────────────────────

const boolStr = z
  .string()
  .transform((s) => s.toLowerCase() === 'true')
  .default('false');

const schema = z.object({
  // Runtime
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // CORS / public URL
  CORS_ORIGIN: z.string().url('CORS_ORIGIN must be a valid URL'),
  PUBLIC_URL: z.string().url('PUBLIC_URL must be a valid URL'),

  // MongoDB
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB: z.string().min(1, 'MONGODB_DB is required'),

  // Auth — comma-separated list, at least one key required
  API_KEYS: z
    .string()
    .min(1, 'API_KEYS must contain at least one key')
    .transform((s) =>
      s
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    )
    .refine((keys) => keys.length > 0, 'API_KEYS must contain at least one key'),

  // LLM narration (OpenAI-compatible; works with Ollama / Groq / Gemini)
  LLM_ENABLED: boolStr,
  LLM_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('qwen2.5:3b'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(2500),

  // Embeddings (MongoDB Atlas Voyage Embedding API)
  EMBED_PROVIDER: z.enum(['atlas_voyage', 'voyage', 'ollama', 'none']).default('atlas_voyage'),
  EMBED_BASE_URL: z.string().optional(),
  EMBED_API_KEY: z.string().optional(),
  EMBED_MODEL: z.string().default('voyage-4'),
  EMBED_DIM: z.coerce
    .number()
    .int()
    .positive('EMBED_DIM must be a positive integer')
    .default(1024),
  EMBED_CACHE_SIZE: z.coerce
    .number()
    .int()
    .positive('EMBED_CACHE_SIZE must be a positive integer')
    .default(256),
  EMBED_MAX_RPM: z.coerce
    .number()
    .int()
    .positive('EMBED_MAX_RPM must be a positive integer')
    .default(3),

  // Background worker
  WORKER_ENABLED: boolStr,

  // Contract mining & detection thresholds
  MIN_BASELINE_RUNS: z.coerce.number().int().positive().default(10),
  CONTRACT_MIN_SUPPORT: z.coerce.number().min(0).max(1).default(0.98),
  DETECT_WINDOW: z.coerce.number().int().positive().default(20),
  DETECT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  DETECT_MIN_RUNS: z.coerce.number().int().positive().default(8),

  // Live stream & public dashboard access
  READ_PUBLIC_PROJECTS: z
    .string()
    .default('demo,invoice-demo')
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  MAX_SSE_CLIENTS: z.coerce.number().int().positive().default(50),

  // Freeze-Replay Experiment Grid & Shapley Attribution
  REPLAY_SAMPLES: z.coerce.number().int().positive().default(3),
  EXPERIMENT_MAX_FULL_K: z.coerce.number().int().positive().default(4),
  EXPERIMENT_PERM_SAMPLES: z.coerce.number().int().positive().default(200),
  EXPERIMENT_EPSILON: z.coerce.number().min(0).max(1).default(0.05),

  // Lessons, Vector Recall & Preflight
  LESSON_TTL_DAYS: z.coerce.number().int().positive().default(90),
  LESSON_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.48),

  // Demo sandboxes & rate limits
  READ_PUBLIC_PREFIX: z.string().default('demo-'),
  MAX_SANDBOXES: z.coerce.number().int().positive().default(50),
  SANDBOX_TTL_HOURS: z.coerce.number().int().positive().default(2),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
});

// ─── Parse ────────────────────────────────────────────────────────────────────

const result = schema.safeParse(process.env);

if (!result.success) {
  const lines = result.error.errors.map(
    (e) => `  ${e.path.join('.') || '(root)'}: ${e.message}`,
  );
  console.error(
    `\n[Waypoint] Config validation failed — fix these env vars:\n${lines.join('\n')}\n`,
  );
  process.exit(1);
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const config = result.data;
export type Config = typeof config;
