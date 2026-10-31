/**
 * server/src/contexts/hash.ts
 *
 * Deterministic canonicalization and content hashing for Context objects.
 *
 * - canonicalize(value): Deterministic JSON string. Keys sorted recursively,
 *   undefined omitted, stable number formatting.
 * - hashContext(ctx): SHA-256 hex digest of the canonical JSON representation
 *   of { model, promptText, config, toolSchemas, deps }.
 */

import { createHash } from 'node:crypto';

export interface ContextData {
  model: string;
  promptText: string;
  config?: Record<string, unknown> | undefined;
  toolSchemas?: Record<string, unknown> | undefined;
  deps?: Record<string, unknown> | undefined;
}

/**
 * Deterministically serialize any JSON-compatible value to a string.
 * - Object keys are sorted lexicographically at every depth.
 * - `undefined` values and functions are omitted from objects.
 * - Numbers: -0 is normalized to 0.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return Object.is(value, -0) ? '0' : String(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const v = canonicalize(item);
      return v === undefined ? 'null' : v;
    });
    return `[${items.join(',')}]`;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];

    for (const k of keys) {
      const val = obj[k];
      if (val === undefined || typeof val === 'function' || typeof val === 'symbol') {
        continue;
      }
      const serialized = canonicalize(val);
      if (serialized !== undefined) {
        parts.push(`${JSON.stringify(k)}:${serialized}`);
      }
    }

    return `{${parts.join(',')}}`;
  }

  // Fallback for types that shouldn't appear in JSON
  return 'null';
}

/**
 * Computes a SHA-256 hex hash from the canonical representation of a context.
 * Only the core 5 axes { model, promptText, config, toolSchemas, deps } are included.
 */
export function hashContext(ctx: ContextData): string {
  const normalized = {
    model: ctx.model ?? '',
    promptText: ctx.promptText ?? '',
    config: ctx.config ?? {},
    toolSchemas: ctx.toolSchemas ?? {},
    deps: ctx.deps ?? {},
  };

  const canonicalJson = canonicalize(normalized);
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

