/**
 * server/src/contexts/diff.ts
 *
 * Typed change diff between two contexts.
 * Returns a deterministic, stably-ordered list of changes across 5 axes:
 *   - model
 *   - prompt
 *   - config
 *   - toolSchema
 *   - dep
 */

import { diffLines } from 'diff';
import type { ContextData } from './hash.js';

export type ChangeAxis = 'model' | 'prompt' | 'config' | 'toolSchema' | 'dep';

export interface ContextChange {
  axis: ChangeAxis;
  path: string;
  before: unknown;
  after: unknown;
  summary: string;
}

/**
 * Deep equality check for primitives, arrays, and plain objects.
 */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!isDeepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

/**
 * Recursively diff two objects, producing leaf changes sorted alphabetically by path.
 */
function diffNestedKeys(
  axis: ChangeAxis,
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
  parentPath = '',
): ContextChange[] {
  const objA = a ?? {};
  const objB = b ?? {};
  const allKeys = Array.from(new Set([...Object.keys(objA), ...Object.keys(objB)])).sort();
  const changes: ContextChange[] = [];

  for (const key of allKeys) {
    const currentPath = parentPath ? `${parentPath}.${key}` : key;
    const valA = objA[key];
    const valB = objB[key];

    if (isDeepEqual(valA, valB)) {
      continue;
    }

    const isAObj = valA !== null && typeof valA === 'object' && !Array.isArray(valA);
    const isBObj = valB !== null && typeof valB === 'object' && !Array.isArray(valB);

    if (isAObj && isBObj) {
      // Recurse into nested objects
      changes.push(
        ...diffNestedKeys(
          axis,
          valA as Record<string, unknown>,
          valB as Record<string, unknown>,
          currentPath,
        ),
      );
    } else {
      let summary: string;
      if (valA === undefined) {
        summary = `Added ${axis}.${currentPath}: ${JSON.stringify(valB)}`;
      } else if (valB === undefined) {
        summary = `Removed ${axis}.${currentPath} (was ${JSON.stringify(valA)})`;
      } else {
        summary = `${axis}.${currentPath} changed from ${JSON.stringify(valA)} to ${JSON.stringify(valB)}`;
      }

      changes.push({
        axis,
        path: currentPath,
        before: valA,
        after: valB,
        summary,
      });
    }
  }

  return changes;
}

/**
 * Compare two contexts and return a typed list of differences.
 * The order of returned changes is deterministic:
 *   1. model changes
 *   2. prompt changes
 *   3. config changes (sorted by path)
 *   4. toolSchema changes (sorted by path)
 *   5. dep changes (sorted by path)
 */
export function diffContexts(a: ContextData, b: ContextData): ContextChange[] {
  const changes: ContextChange[] = [];

  // 1. Model diff
  const modelA = a.model ?? '';
  const modelB = b.model ?? '';
  if (modelA !== modelB) {
    changes.push({
      axis: 'model',
      path: 'model',
      before: modelA,
      after: modelB,
      summary: `Model changed from "${modelA}" to "${modelB}"`,
    });
  }

  // 2. Prompt diff (line-based using jsdiff)
  const promptA = a.promptText ?? '';
  const promptB = b.promptText ?? '';
  if (promptA !== promptB) {
    const lineDiff = diffLines(promptA, promptB);
    const addedLines = lineDiff.filter((p) => p.added).reduce((n, p) => n + (p.count ?? 0), 0);
    const removedLines = lineDiff.filter((p) => p.removed).reduce((n, p) => n + (p.count ?? 0), 0);

    changes.push({
      axis: 'prompt',
      path: 'promptText',
      before: promptA,
      after: promptB,
      summary: `Prompt modified (+${addedLines} / -${removedLines} lines)`,
    });
  }

  // 3. Config diff
  changes.push(...diffNestedKeys('config', a.config, b.config));

  // 4. ToolSchema diff
  changes.push(...diffNestedKeys('toolSchema', a.toolSchemas, b.toolSchemas));

  // 5. Deps diff
  changes.push(...diffNestedKeys('dep', a.deps, b.deps));

  return changes;
}

