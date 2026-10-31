/**
 * server/src/ingest/redact.ts
 *
 * Deep-redact sensitive values from arbitrary JSON-compatible objects before
 * storing them.  Operates on the contextPayload field (and any nested object).
 *
 * Rules:
 *  1. Key-based: if a key matches SENSITIVE_KEY_RE, replace string/number value
 *     with "[REDACTED]".
 *  2. Value-based: if a string value matches SENSITIVE_VALUE_RE (even under a
 *     non-sensitive key), replace with "[REDACTED]".
 *
 * Pure function — original object is never mutated.
 */

/** Keys whose values must always be redacted. */
const SENSITIVE_KEY_RE =
  /(?:api[_-]?key|secret|token|password|passwd|authorization|auth)/i;

/**
 * Value patterns that look like credentials regardless of key name.
 *
 * Pattern overview:
 *   sk-...        — OpenAI / Anthropic style keys
 *   Bearer ...    — Authorization header values
 *   ghp_... / ghs_... / github_pat_... — GitHub tokens
 *   xoxb-... / xoxa-... — Slack tokens
 *   AIza...       — Google API keys
 */
const SENSITIVE_VALUE_RE =
  /(?:^sk-[A-Za-z0-9]{6,}|^Bearer\s+\S+|^ghp_\w+|^ghs_\w+|^github_pat_\w+|^xox[baps]-\w+|^AIza[A-Za-z0-9_-]{35,})/;

const REDACTED = '[REDACTED]';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

/**
 * Recursively redact sensitive data from a JSON-compatible value.
 *
 * @param value  The value to inspect (mutated copy returned, original unchanged).
 * @param keyHint  The parent key name, used for key-based redaction of primitives.
 */
export function redact(value: unknown, keyHint?: string): unknown {
  if (value === null || typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) return REDACTED;
    if (SENSITIVE_VALUE_RE.test(value)) return REDACTED;
    return value;
  }

  if (typeof value === 'number') {
    if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) return REDACTED;
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (typeof value === 'object') {
    const result: JsonObject = {};
    for (const [k, v] of Object.entries(value as JsonObject)) {
      result[k] = redact(v, k) as JsonValue;
    }
    return result;
  }

  // Fallback: unknown types (undefined, functions, symbols) are dropped.
  return undefined;
}
