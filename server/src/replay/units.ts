/**
 * server/src/replay/units.ts
 *
 * Generic change unit extraction and application for context replay.
 *
 * Units of change are derived from diffContexts(baseline, bad):
 *   - 'model' (if baseline.model != bad.model)
 *   - 'prompt' (all prompt line differences grouped into one atomic unit)
 *   - each config key: e.g. 'config.chunkSize'
 *   - each toolSchema: e.g. 'toolSchema.create_invoice'
 *   - each dep: e.g. 'dep.extractor'
 *
 * The engine operates purely on string unit IDs and never hard-codes
 * domain-specific variable names.
 */

import { diffContexts, type ContextChange } from '../contexts/diff.js';
import type { ContextData } from '../contexts/hash.js';

/**
 * Extracts distinct change units from the diff between baseline and bad contexts.
 * Stably ordered and deduplicated.
 */
export function extractUnits(baseline: ContextData, bad: ContextData): string[] {
  const changes = diffContexts(baseline, bad);
  const unitsSet = new Set<string>();

  for (const change of changes) {
    if (change.axis === 'model') {
      unitsSet.add('model');
    } else if (change.axis === 'prompt') {
      unitsSet.add('prompt');
    } else {
      unitsSet.add(`${change.axis}.${change.path}`);
    }
  }

  return Array.from(unitsSet).sort();
}

/**
 * Pure function: returns a new ContextData with baseline as the base,
 * taking ONLY the chosen active units from bad context.
 */
export function applyUnits(
  baseline: ContextData,
  bad: ContextData,
  activeUnits: string[] | Set<string>,
): ContextData {
  const active = activeUnits instanceof Set ? activeUnits : new Set(activeUnits);

  const result: ContextData = {
    model: active.has('model') ? bad.model : baseline.model,
    promptText: active.has('prompt') ? bad.promptText : baseline.promptText,
    config: { ...(baseline.config ?? {}) },
    toolSchemas: { ...(baseline.toolSchemas ?? {}) },
    deps: { ...(baseline.deps ?? {}) },
  };

  const badConfig = bad.config ?? {};
  const badToolSchemas = bad.toolSchemas ?? {};
  const badDeps = bad.deps ?? {};

  for (const unit of active) {
    if (unit.startsWith('config.')) {
      const key = unit.slice('config.'.length);
      if (key in badConfig) {
        result.config![key] = badConfig[key];
      } else {
        delete result.config![key];
      }
    } else if (unit.startsWith('toolSchema.')) {
      const key = unit.slice('toolSchema.'.length);
      if (key in badToolSchemas) {
        result.toolSchemas![key] = badToolSchemas[key];
      } else {
        delete result.toolSchemas![key];
      }
    } else if (unit.startsWith('dep.')) {
      const key = unit.slice('dep.'.length);
      if (key in badDeps) {
        result.deps![key] = badDeps[key];
      } else {
        delete result.deps![key];
      }
    }
  }

  return result;
}
